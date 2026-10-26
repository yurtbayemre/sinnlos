import { beforeEach, describe, expect, it, vi } from "vitest";

import { openAckCounts } from "./open-acks";

/**
 * GET /api/me/open-acks (v0.31, #172), the composition: the read grants
 * decide whether a kind is counted at all (null, never 0), the moderators
 * count every published mandatory row, everyone else the rows among the
 * visibility function's ids, and the caller's receipts are subtracted by
 * documentId. The visibility rules themselves are the policies' functions,
 * pinned by their own tests and by integration/open-acks.integration.test.ts.
 */

const grants = vi.hoisted(() => ({ byAction: new Map<string, Set<number>>() }));
const visible = vi.hoisted(() => ({
  announcement: [] as number[],
  document: [] as number[],
  calls: [] as string[],
}));

vi.mock("./visible-ids", async (original) => ({
  ...(await original<typeof import("./visible-ids")>()),
  loadUserScope: vi.fn(async (_strapi: unknown, userId: number) => ({
    roleId: userId === 1 ? 100 : userId === 2 ? 200 : 300,
    teamIds: [],
    ledTeamIds: [],
  })),
  loadRoleGrants: vi.fn(async () => ({
    holders: (action: string) => grants.byAction.get(action) ?? new Set<number>(),
  })),
  visibleAnnouncementIds: vi.fn(async () => {
    visible.calls.push("announcement");
    return visible.announcement;
  }),
}));

vi.mock("./policy-factories", async (original) => ({
  ...(await original<typeof import("./policy-factories")>()),
  departmentScopedIds: vi.fn(async () => {
    visible.calls.push("document");
    return visible.document;
  }),
}));

type Row = Record<string, unknown>;

const TABLES: Record<string, Row[]> = {
  "api::announcement.announcement": [
    { id: 1, documentId: "a1", requiresAck: true, publishedAt: null },
    { id: 2, documentId: "a1", requiresAck: true, publishedAt: "2026-01-01" },
    { id: 3, documentId: "a2", requiresAck: true, publishedAt: "2026-01-01" },
    { id: 4, documentId: "a3", requiresAck: false, publishedAt: "2026-01-01" },
    { id: 5, documentId: "a4", requiresAck: true, publishedAt: "2026-01-01" },
  ],
  "api::document.document": [
    { id: 11, documentId: "d1", requiresAck: true, publishedAt: "2026-01-01" },
    { id: 12, documentId: "d2", requiresAck: true, publishedAt: "2026-01-01" },
  ],
  "api::acknowledgement.acknowledgement": [
    { userId: 1, targetType: "announcement", targetDocumentId: "a2" },
    { userId: 1, targetType: "document", targetDocumentId: "d1" },
    { userId: 9, targetType: "announcement", targetDocumentId: "a4" },
  ],
};

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "$and") return (cond as Row[]).every((part) => matches(row, part));
    if (key === "user") return row.userId === (cond as { id: number }).id;
    if (cond && typeof cond === "object" && "$notNull" in cond) return row[key] != null;
    if (cond && typeof cond === "object" && "$in" in cond) {
      return (cond as { $in: unknown[] }).$in.includes(row[key]);
    }
    if (cond && typeof cond === "object" && "$eq" in cond) return row[key] === (cond as Row).$eq;
    return row[key] === cond;
  });
}

const strapi = {
  db: {
    query: (uid: string) => ({
      findMany: async ({ where }: { where: Row }) =>
        (TABLES[uid] ?? []).filter((row) => matches(row, where)),
      findOne: async () => null,
    }),
    config: { connection: { client: "sqlite" } },
    dialect: { client: "sqlite" },
  },
};

const MEMBER = { id: 1, role: { type: "member" } };
const EDITOR = { id: 2, role: { type: "editor" } };
const GUEST = { id: 3, role: { type: "guest" } };

const ALL_READS = [
  "api::acknowledgement.acknowledgement.find",
  "api::announcement.announcement.find",
  "api::document.document.find",
];

beforeEach(() => {
  grants.byAction = new Map(ALL_READS.map((action) => [action, new Set([100, 200])]));
  visible.announcement = [2, 3, 5];
  visible.document = [11, 12];
  visible.calls = [];
});

describe("openAckCounts", () => {
  it("counts the visible published mandatory rows the caller has not confirmed", async () => {
    visible.announcement = [1, 3, 5];
    // a1's visible row is its draft: its published twin is not counted.
    expect(await openAckCounts(strapi as never, MEMBER)).toEqual({
      announcements: 1,
      documents: 1,
    });
    expect(visible.calls.sort()).toEqual(["announcement", "document"]);
  });

  it("moderators count every published mandatory row, without the visibility functions", async () => {
    visible.announcement = [];
    expect(await openAckCounts(strapi as never, EDITOR)).toEqual({
      announcements: 3,
      documents: 2,
    });
    expect(visible.calls).toEqual([]);
  });

  it("an empty visible set counts nothing", async () => {
    visible.announcement = [];
    visible.document = [];
    expect(await openAckCounts(strapi as never, MEMBER)).toEqual({
      announcements: 0,
      documents: 0,
    });
  });

  it("a visible set past the bind limit fails closed like the policy (counts nothing)", async () => {
    // SQLite: 32,766 parameters minus the 1,000 of headroom (utils/policy-query.ts).
    const oversized = Array.from({ length: 31_767 }, (_, i) => i + 1);
    visible.announcement = oversized;
    visible.document = Array.from({ length: 31_767 }, (_, i) => i + 11);
    expect(await openAckCounts(strapi as never, MEMBER)).toEqual({
      announcements: 0,
      documents: 0,
    });
    visible.announcement = oversized.slice(0, 31_766);
    expect((await openAckCounts(strapi as never, MEMBER)).announcements).toBe(2);
  });

  it("a kind whose read grant the role lacks is null, never 0", async () => {
    expect(await openAckCounts(strapi as never, GUEST)).toEqual({
      announcements: null,
      documents: null,
    });
    grants.byAction.set("api::announcement.announcement.find", new Set([200]));
    expect(await openAckCounts(strapi as never, MEMBER)).toEqual({
      announcements: null,
      documents: 1,
    });
    grants.byAction.set("api::acknowledgement.acknowledgement.find", new Set([200]));
    expect(await openAckCounts(strapi as never, MEMBER)).toEqual({
      announcements: null,
      documents: null,
    });
    expect(visible.calls).toEqual(["document"]);
  });

  it("a caller without an id gets nothing", async () => {
    expect(await openAckCounts(strapi as never, { role: { type: "member" } })).toEqual({
      announcements: null,
      documents: null,
    });
  });
});
