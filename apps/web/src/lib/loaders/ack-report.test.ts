import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrapiError } from "@/lib/strapi-error";

/**
 * WD03: the /manage/acknowledgements view-model from mocked reads (one
 * page of mandatory announcements and documents each, v0.31; the
 * directory, the team roster, the ack index); the report rules
 * (lib/ack-report.ts, the domain targeting) are real. Snapshots per
 * scenario: success, partial failure, truncation, CMS down.
 */
const reads = {
  announcements: vi.fn<(page: number) => Promise<unknown>>(),
  users: vi.fn<(params: string) => Promise<unknown>>(),
  teams: vi.fn<() => Promise<unknown>>(),
  acks: vi.fn<(documentIds: string[]) => Promise<unknown>>(),
  documents: vi.fn<(page: number) => Promise<unknown>>(),
  documentAcks: vi.fn<(documentIds: string[]) => Promise<unknown>>(),
};

vi.mock("@/lib/api/announcements", () => ({
  ackReportAnnouncementsPage: (page: number) => reads.announcements(page),
}));
vi.mock("@/lib/users", () => ({ fetchAllUsers: (params: string) => reads.users(params) }));
vi.mock("@/lib/teams", () => ({ fetchAllTeams: () => reads.teams() }));
vi.mock("@/lib/api/documents", () => ({
  ackReportDocumentsPage: (page: number) => reads.documents(page),
}));
vi.mock("@/lib/acknowledgements", () => ({
  fetchAnnouncementAckIndex: (documentIds: string[]) => reads.acks(documentIds),
  fetchDocumentAckIndex: (documentIds: string[]) => reads.documentAcks(documentIds),
}));

const { loadAckReport, ACK_REPORT_USER_QUERY } = await import("./ack-report");

/** One page of a section as the cms answers it. */
const paged = <T>(data: T[], page = 1, total = data.length) => ({
  data,
  meta: { pagination: { page, pageSize: 20, pageCount: Math.ceil(total / 20), total } },
});

const member = { id: 2, type: "member" };
const user = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  username: `user${id}`,
  displayName: `User ${id}`,
  role: member,
  department: { id: 10, name: "Engineering" },
  ...extra,
});
const ANNOUNCEMENTS = paged([
  // Company-wide.
  {
    id: 1,
    documentId: "ann-1",
    title: "Code of conduct",
    requiresAck: true,
    ackDeadline: "2026-10-31",
  },
  // Engineering only.
  {
    id: 2,
    documentId: "ann-2",
    title: "On-call rota",
    requiresAck: true,
    department: { id: 10, name: "Engineering" },
  },
  // One team, and the role list (names missing: the type, else #id).
  {
    id: 3,
    documentId: "ann-3",
    title: "Release freeze",
    requiresAck: true,
    team: { id: 30 },
    audienceRoles: [{ id: 2, type: "member" }, { id: 9 }],
  },
  // Not mandatory (DEMO_MODE answers unfiltered): left out.
  { id: 4, documentId: "ann-4", title: "Lunch", requiresAck: false },
]);
const USERS = {
  users: [
    user(1),
    user(2, { displayName: "" }),
    user(3, { department: { id: 11, name: "Sales" } }),
    // Never counted: blocked, a guest.
    user(4, { blocked: true }),
    user(5, { role: { id: 6, type: "guest" } }),
  ],
  truncated: false,
};
const TEAMS = { teams: [{ id: 30, lead: { id: 1 }, members: [{ id: 3 }] }], truncated: false };
const ACKS = {
  index: new Map([
    ["ann-1", new Set([1, 3, 4])],
    ["ann-2", new Set([1])],
    ["ann-3", new Set<number>()],
  ]),
  truncated: false,
};
const outage = () => new StrapiError(502, "Bad Gateway", "");

beforeEach(() => {
  reads.announcements.mockReset().mockResolvedValue(ANNOUNCEMENTS);
  reads.users.mockReset().mockResolvedValue(USERS);
  reads.teams.mockReset().mockResolvedValue(TEAMS);
  reads.acks.mockReset().mockResolvedValue(ACKS);
  reads.documents.mockReset().mockResolvedValue(paged([]));
  reads.documentAcks.mockReset().mockResolvedValue({ index: new Map(), truncated: false });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadAckReport", () => {
  it("success: one row per mandatory announcement, rates over the eligible audience", async () => {
    const view = await loadAckReport();
    expect(reads.users).toHaveBeenCalledWith(ACK_REPORT_USER_QUERY);
    expect(reads.acks).toHaveBeenCalledWith(["ann-1", "ann-2", "ann-3"]);
    expect(view.rows.map((r) => [r.id, r.ackedCount, r.targetTotal, r.pct])).toEqual([
      [1, 2, 3, 67],
      [2, 1, 2, 50],
      [3, 0, 2, 0],
    ]);
    // An empty display name falls back to the username.
    expect(view.rows[1]!.openUsers).toEqual([{ id: 2, name: "user2" }]);
    expect(view.rows[2]!.audience).toEqual({
      department: null,
      team: "#30",
      roles: ["member", "#9"],
    });
    expect(view).toMatchSnapshot();
  });

  it("partial failure: no team roster leaves only the team-scoped row unknown", async () => {
    reads.teams.mockRejectedValue(outage());
    const view = await loadAckReport();
    expect(view.failed).toBe(true);
    expect(view.rows.map((r) => r.targetUnknown)).toEqual([false, false, true]);
    expect(view).toMatchSnapshot();
  });

  it("partial failure: no directory leaves every row unknown, never 0 of 0", async () => {
    reads.users.mockRejectedValue(outage());
    const view = await loadAckReport();
    expect(view.rows.every((r) => r.targetUnknown)).toBe(true);
    expect(view.failed).toBe(true);
  });

  it("truncated: any input walk cut at its cap marks the report incomplete", async () => {
    reads.acks.mockResolvedValue({ ...ACKS, truncated: true });
    const view = await loadAckReport();
    expect(view).toMatchObject({ truncated: true, failed: false });
    expect(view).toMatchSnapshot();
    reads.acks.mockResolvedValue(ACKS);
    reads.users.mockResolvedValue({ ...USERS, truncated: true });
    const directoryCut = await loadAckReport();
    expect(directoryCut.truncated).toBe(true);
    expect(directoryCut.rows.every((r) => r.targetUnknown)).toBe(true);
  });

  it("CMS down: the banner, no rows and no empty state", async () => {
    for (const read of Object.values(reads)) read.mockRejectedValue(outage());
    const view = await loadAckReport();
    expect(view).toMatchSnapshot();
    expect(view).toMatchObject({ rows: [], empty: false, failed: true });
  });

  it("no mandatory announcement and no mandatory document is the empty state", async () => {
    reads.announcements.mockResolvedValue(paged([]));
    await expect(loadAckReport()).resolves.toMatchObject({
      rows: [],
      documentRows: [],
      empty: true,
      failed: false,
    });
  });

  it("documents (v0.20): one row per mandatory document over the acknowledging roles", async () => {
    reads.documents.mockResolvedValue(
      paged([
        { id: 7, documentId: "doc-7", title: "Fire safety", requiresAck: true },
        {
          id: 8,
          documentId: "doc-8",
          title: "Forklift rules",
          requiresAck: true,
          audience: "departments",
          departments: [{ id: 11, name: "Sales" }],
        },
        // Not mandatory (DEMO_MODE answers unfiltered): left out.
        { id: 9, documentId: "doc-9", title: "Menu", requiresAck: false },
      ]),
    );
    reads.documentAcks.mockResolvedValue({
      index: new Map([
        ["doc-7", new Set([1])],
        ["doc-8", new Set<number>()],
      ]),
      truncated: false,
    });
    const view = await loadAckReport();
    expect(reads.documentAcks).toHaveBeenCalledWith(["doc-7", "doc-8"]);
    // The guest (user 5) and the blocked user 4 never count.
    expect(view.documentRows.map((r) => [r.id, r.ackedCount, r.targetTotal, r.pct])).toEqual([
      [7, 1, 3, 33],
      [8, 0, 1, 0],
    ]);
    expect(view.documentRows[1]!.audience).toEqual({ department: "Sales", team: null, roles: [] });
    expect(view.documentRows[1]!.openUsers).toEqual([{ id: 3, name: "User 3" }]);
    expect(view.empty).toBe(false);
  });

  it("documents (v0.20): a failed document read is the banner, a cut index the warning", async () => {
    reads.documentAcks.mockResolvedValue({ index: new Map(), truncated: true });
    await expect(loadAckReport()).resolves.toMatchObject({ truncated: true, failed: false });
    reads.documents.mockRejectedValue(outage());
    await expect(loadAckReport()).resolves.toMatchObject({ failed: true, empty: false });
  });
});

describe("pages (v0.31)", () => {
  const many = (prefix: string, from: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: from + i,
      documentId: `${prefix}-${from + i}`,
      title: `${prefix} ${from + i}`,
      requiresAck: true,
    }));

  it("reads each section's own page and the receipts of the shown items only", async () => {
    reads.announcements.mockResolvedValue(paged(many("ann", 41, 20), 3, 65));
    reads.documents.mockResolvedValue(paged(many("doc", 21, 20), 2, 45));
    const view = await loadAckReport({ page: 3, documentsPage: 2 });
    expect(reads.announcements.mock.calls).toEqual([[3]]);
    expect(reads.documents.mock.calls).toEqual([[2]]);
    expect(reads.acks).toHaveBeenCalledWith(many("ann", 41, 20).map((a) => a.documentId));
    expect(reads.documentAcks).toHaveBeenCalledWith(many("doc", 21, 20).map((d) => d.documentId));
    expect(view.rows).toHaveLength(20);
    expect(view.announcementsPage).toEqual({ page: 3, pageCount: 4, total: 65 });
    expect(view.documentsPage).toEqual({ page: 2, pageCount: 3, total: 45 });
  });

  it("a page past the last shows the last page; an emptied report is the empty state", async () => {
    reads.announcements.mockImplementation(async (page) =>
      page === 2 ? paged(many("ann", 21, 1), 2, 21) : paged([], page, 21),
    );
    const view = await loadAckReport({ page: 9, documentsPage: 1 });
    expect(reads.announcements.mock.calls).toEqual([[9], [2]]);
    expect(view.announcementsPage).toEqual({ page: 2, pageCount: 2, total: 21 });
    expect(view.rows.map((row) => row.id)).toEqual([21]);
    reads.announcements.mockReset().mockResolvedValue(paged([], 4, 0));
    await expect(loadAckReport({ page: 4, documentsPage: 1 })).resolves.toMatchObject({
      rows: [],
      empty: true,
      announcementsPage: { page: 4, pageCount: 1, total: 0 },
    });
  });

  it("a failed section read has no page", async () => {
    reads.documents.mockRejectedValue(outage());
    await expect(loadAckReport()).resolves.toMatchObject({
      documentsPage: null,
      announcementsPage: { page: 1 },
    });
  });
});

describe("control flow", () => {
  it("never swallows the expired-session redirect of a read", async () => {
    const expired = (() => {
      try {
        redirect("/sign-in?expired=1");
      } catch (e) {
        return e;
      }
    })();
    reads.acks.mockRejectedValue(expired);
    await expect(loadAckReport()).rejects.toBe(expired);
  });
});
