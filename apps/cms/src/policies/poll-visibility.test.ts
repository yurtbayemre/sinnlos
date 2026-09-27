import { describe, expect, it } from "vitest";
import pollVisibility, { type PollVisibilityHost } from "./poll-visibility";

/**
 * Wiring test for the poll read policy (decision 02), in the strapi-stub
 * pattern of quick-link-visibility.test.ts. The rules themselves are pinned
 * in utils/poll-audience.test.ts; this file pins the query side:
 *   - no user → false; admin_role/editor → true with the query untouched,
 *   - the visible ids come from PUBLISHED rows only (the findMany `where`),
 *   - departments match by documentId (a user linked to row 1 and a poll
 *     linked to row 2 of the same department document still match),
 *   - an empty list stays restrictive ({ id: { $eq: -1 } }, never $in: []),
 *   - a client filter is $and-wrapped, the status pinned to published, the
 *     legacy publicationState removed, and the result is a strict true.
 */

interface StubUser {
  id: number;
  role?: { type: string };
  department?: { id: number; documentId: string } | null;
}

interface PollRow {
  id: number;
  audience?: string | null;
  departments?: { id: number; documentId: string }[];
  publishedAt: string | null;
}

const PUBLISHED = "2026-09-01T00:00:00.000Z";

/** 1 company-wide, 2 Engineering, 3 Design, 4 Eng+Design, 5 orphaned, 6 legacy 'all' + Eng, 7 a draft. */
const POLLS: PollRow[] = [
  { id: 1, audience: "all", departments: [], publishedAt: PUBLISHED },
  { id: 2, audience: "departments", departments: [{ id: 2, documentId: "d-eng" }], publishedAt: PUBLISHED },
  { id: 3, audience: "departments", departments: [{ id: 3, documentId: "d-design" }], publishedAt: PUBLISHED },
  {
    id: 4,
    audience: "departments",
    departments: [
      { id: 2, documentId: "d-eng" },
      { id: 3, documentId: "d-design" },
    ],
    publishedAt: PUBLISHED,
  },
  { id: 5, audience: "departments", departments: [], publishedAt: PUBLISHED },
  { id: 6, audience: "all", departments: [{ id: 2, documentId: "d-eng" }], publishedAt: PUBLISHED },
  { id: 7, audience: "all", departments: [], publishedAt: null },
];

function stub(users: StubUser[], polls: PollRow[] = POLLS) {
  const findManyCalls: Record<string, unknown>[] = [];
  const strapi: PollVisibilityHost = {
    db: {
      query: (uid: string) => ({
        findOne: async (params: Record<string, unknown>) => {
          const where = params.where as { id: number };
          return uid === "plugin::users-permissions.user"
            ? (users.find((u) => u.id === where.id) ?? null)
            : null;
        },
        findMany: async (params: Record<string, unknown>) => {
          findManyCalls.push(params);
          if (uid !== "api::poll.poll") return [];
          const wantsPublished =
            (params.where as { publishedAt?: { $notNull?: boolean } } | undefined)?.publishedAt
              ?.$notNull === true;
          return polls.filter((p) => !wantsPublished || p.publishedAt !== null);
        },
      }),
    },
  };
  return { strapi, findManyCalls };
}

type Query = Record<string, unknown>;

function context(user: StubUser | null, query: Query = {}) {
  return {
    state: user ? { user } : {},
    request: { query: { ...query } },
  };
}

async function run(user: StubUser | null, query: Query = {}, polls?: PollRow[]) {
  const ctx = context(user, query);
  const { strapi, findManyCalls } = stub(user ? [user] : [], polls);
  const result = await pollVisibility(ctx, undefined, { strapi });
  return { result, query: ctx.request.query, findManyCalls };
}

const as = (type: string, department: StubUser["department"] = null): StubUser => ({
  id: 9,
  role: { type },
  department,
});

/** The user row links department row 1; the polls link row 2 of the same document. */
const ENG_ROW_1 = { id: 1, documentId: "d-eng" };

describe("poll-visibility policy", () => {
  it("refuses a request without a signed-in user", async () => {
    const { result, query } = await run(null);
    expect(result).toBe(false);
    expect(query.filters).toBeUndefined();
  });

  it("lets admin_role and editor through with the query untouched (drafts included)", async () => {
    for (const role of ["admin_role", "editor"]) {
      const { result, query, findManyCalls } = await run(as(role), { status: "draft" });
      expect(result, role).toBe(true);
      expect(query, role).toEqual({ status: "draft" });
      expect(findManyCalls, role).toEqual([]);
    }
  });

  it("matches departments by documentId, not by row id (twin regression)", async () => {
    const { query } = await run(as("member", ENG_ROW_1));
    expect(query.filters).toEqual({ id: { $in: [1, 2, 4, 6] } });
  });

  it("shows a guest the company-wide polls plus its own department's", async () => {
    const { query } = await run(as("guest", { id: 3, documentId: "d-design" }));
    expect(query.filters).toEqual({ id: { $in: [1, 3, 4] } });
  });

  it("shows a user without a department the company-wide polls only", async () => {
    for (const department of [null, undefined]) {
      const { query } = await run(as("member", department));
      expect(query.filters).toEqual({ id: { $in: [1] } });
    }
  });

  it("never lists a poll whose departments are gone (only admin/editor see it)", async () => {
    for (const role of ["member", "department_head", "team_lead", "guest", "authenticated"]) {
      const { query } = await run(as(role, ENG_ROW_1));
      expect((query.filters as { id: { $in: number[] } }).id.$in, role).not.toContain(5);
    }
  });

  it("evaluates published rows only", async () => {
    const { query, findManyCalls } = await run(as("member", null));
    expect(findManyCalls).toEqual([
      {
        where: { publishedAt: { $notNull: true } },
        select: ["id", "audience"],
        populate: { departments: { select: ["documentId"] } },
      },
    ]);
    expect((query.filters as { id: { $in: number[] } }).id.$in).not.toContain(7);
  });

  it("stays restrictive when nothing is visible (no fail-open empty $in)", async () => {
    const targetedOnly = POLLS.filter((p) => p.id === 2 || p.id === 3);
    const { query } = await run(as("member", null), {}, targetedOnly);
    expect(query.filters).toEqual({ id: { $eq: -1 } });
  });

  it("keeps a client filter and only narrows it", async () => {
    const { query } = await run(as("member", ENG_ROW_1), {
      filters: { question: { $containsi: "pizza" } },
    });
    expect(query.filters).toEqual({
      $and: [{ question: { $containsi: "pizza" } }, { id: { $in: [1, 2, 4, 6] } }],
    });
  });

  it("pins the status to published and drops the legacy and cohort keys", async () => {
    const { query } = await run(as("member", null), {
      status: "draft",
      publicationState: "preview",
      publicationFilter: "modified",
      hasPublishedVersion: "false",
    });
    expect(query.status).toBe("published");
    expect("publicationState" in query).toBe(false);
    expect("publicationFilter" in query).toBe(false);
    expect("hasPublishedVersion" in query).toBe(false);
  });

  it("writes onto request.query, never the throw-away ctx.query copy", async () => {
    const ctx = { ...context(as("member", null)), query: {} as Query };
    const { strapi } = stub([as("member", null)]);
    await pollVisibility(ctx, undefined, { strapi });
    expect(ctx.request.query.filters).toEqual({ id: { $in: [1] } });
    expect(ctx.query.filters).toBeUndefined();
  });

  it("returns a strict true for a reader", async () => {
    const { result } = await run(as("member", null));
    expect(result).toBe(true);
  });
});
