import { describe, expect, it, vi } from "vitest";

import {
  createStrapiStub,
  matchWhere,
  policyContext,
  type Row,
  type StrapiStub,
  type StubUser,
} from "../test/strapi-stub.test.helper";
import commentTargetVisibility from "./comment-target-visibility";

/**
 * Wiring test for the #28 read policy — decision logic itself is covered
 * by utils/target-visibility.test.ts. Pinned here (same trap set as the
 * sibling visibility policy tests):
 *   1. the filter lands on `policyContext.request.query`, not on the
 *      throw-away `policyContext.query` copy (Koa prototype-getter trap),
 *   2. no visible target stays restrictive (`{ id: { $eq: -1 } }`) —
 *      never an empty `$in` (sanitizeQuery strips those, fail-open),
 *   3. a client filter is only narrowed (`$and`), never replaced,
 *   4. empty per-type lists emit NO branch for that type.
 */

const ENG = 1;

const USERS = [{ id: 10, role: { id: 5, type: "member" }, department: { id: ENG }, teams: [] }];

function stubStrapi({
  announcements = [] as any[],
  spaces = [] as any[],
  pages = [] as any[],
} = {}) {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async ({ where }: any) =>
          uid === "plugin::users-permissions.user"
            ? (USERS.find((u) => u.id === where.id) ?? null)
            : null,
        findMany: async ({ where }: any = {}) => {
          if (uid === "api::team.team") return [];
          if (uid === "api::announcement.announcement") return announcements;
          if (uid === "api::wiki-space.wiki-space") return spaces;
          if (uid === "api::wiki-page.wiki-page") {
            const ids: number[] = where?.space?.id?.$in ?? [];
            return pages.filter((p: any) => p.space && ids.includes(p.space.id));
          }
          return [];
        },
      }),
    },
  } as any;
}

function context(user: any, query: Record<string, unknown> = {}) {
  return {
    state: user ? { user } : {},
    request: { query: { ...query } },
  } as any;
}

const member = { id: 10, role: { id: 5, type: "member" } };

describe("comment-target-visibility policy", () => {
  it("lets admin_role through without touching the query", async () => {
    const ctx = context({ id: 1, role: { type: "admin_role" } });
    await expect(commentTargetVisibility(ctx, undefined, { strapi: stubStrapi() })).resolves.toBe(
      true,
    );
    expect(ctx.request.query.filters).toBeUndefined();
  });

  it("injects the visible-anchor filter into the REAL request query", async () => {
    const strapi = stubStrapi({
      announcements: [{ id: 1, documentId: "docA", publishedAt: "2026-01-01", audience: "all" }],
      spaces: [{ id: 1, visibility: "public" }],
      pages: [{ id: 100, documentId: "pageP", space: { id: 1 } }],
    });
    const ctx = context(member);
    await commentTargetVisibility(ctx, undefined, { strapi });
    expect(ctx.request.query.filters).toEqual({
      $or: [
        { targetType: "announcement", targetDocumentId: { $in: ["docA"] } },
        { targetType: "wiki-page", targetDocumentId: { $in: ["pageP"] } },
      ],
    });
  });

  it("emits no branch for a target type with nothing visible (never an empty $in)", async () => {
    const strapi = stubStrapi({
      announcements: [{ id: 1, documentId: "docA", publishedAt: "2026-01-01", audience: "all" }],
    });
    const ctx = context(member);
    await commentTargetVisibility(ctx, undefined, { strapi });
    expect(ctx.request.query.filters).toEqual({
      targetType: "announcement",
      targetDocumentId: { $in: ["docA"] },
    });
  });

  it("stays restrictive when nothing at all is visible", async () => {
    const ctx = context(member);
    await commentTargetVisibility(ctx, undefined, { strapi: stubStrapi() });
    expect(ctx.request.query.filters).toEqual({ id: { $eq: -1 } });
  });

  it("narrows a client filter with $and instead of replacing it", async () => {
    const strapi = stubStrapi({
      announcements: [{ id: 1, documentId: "docA", publishedAt: "2026-01-01", audience: "all" }],
    });
    const clientFilter = { targetType: { $eq: "announcement" } };
    const ctx = context(member, { filters: clientFilter });
    await commentTargetVisibility(ctx, undefined, { strapi });
    expect(ctx.request.query.filters).toEqual({
      $and: [clientFilter, { targetType: "announcement", targetDocumentId: { $in: ["docA"] } }],
    });
  });

  it("treats anonymous callers as null scope (untargeted only)", async () => {
    const strapi = stubStrapi({
      announcements: [
        { id: 1, documentId: "docA", publishedAt: "2026-01-01", audience: "all" },
        { id: 2, documentId: "docB", publishedAt: "2026-01-01", department: { id: ENG } },
      ],
    });
    const ctx = context(null);
    await commentTargetVisibility(ctx, undefined, { strapi });
    expect(ctx.request.query.filters).toEqual({
      targetType: "announcement",
      targetDocumentId: { $in: ["docA"] },
    });
  });
});

/**
 * PL04 single-anchor fast path, on the shared stub: a client filter that
 * pins exactly one {targetType, targetDocumentId} is checked for that
 * anchor only, and every anchor returns the same comment rows with and
 * without the fast path (the full path is forced with an equivalent filter
 * the parser does not take: `$in` instead of `$eq`).
 */
describe("comment-target-visibility: single-anchor fast path (PL04)", () => {
  const ENG_DEPT = 10;
  const SALES_DEPT = 11;
  const PUBLISHED = "2026-09-01T00:00:00.000Z";
  const ANN_ALL = "annall000000000000000000";
  const ANN_ENG = "anneng000000000000000000";
  const ANN_DRAFT = "anndraft0000000000000000";
  const PAGE_OPEN = "pageopen0000000000000000";
  const PAGE_SALES = "pagesales000000000000000";
  const PAGE_WIDENED = "pagewidened0000000000000";
  const GHOST = "ghost0000000000000000000";
  const COMMENT = "api::comment.comment";

  const row = (id: number, documentId: string, published: boolean, data: object): Row => ({
    id,
    documentId,
    publishedAt: published ? PUBLISHED : null,
    ...data,
  });
  const comment = (id: number, targetType: string, targetDocumentId: string): Row => ({
    id,
    documentId: `c${String(id).padStart(23, "0")}`,
    body: `on ${targetDocumentId}`,
    targetType,
    targetDocumentId,
  });
  const salesOnly = { visibility: "department", department: { id: SALES_DEPT } };

  function stub(): StrapiStub {
    return createStrapiStub({
      tables: {
        "api::department.department": [
          { id: ENG_DEPT, documentId: "deng00000000000000000000", name: "Eng" },
          { id: SALES_DEPT, documentId: "dsal00000000000000000000", name: "Sales" },
        ],
        "plugin::users-permissions.user": [
          { id: 1, username: "eng", department: { id: ENG_DEPT }, teams: [] },
          { id: 2, username: "sales", department: { id: SALES_DEPT }, teams: [] },
        ],
        "api::announcement.announcement": [
          row(1, ANN_ALL, true, { title: "all" }),
          row(2, ANN_ALL, false, { title: "all" }),
          row(3, ANN_ENG, true, { title: "eng", department: { id: ENG_DEPT } }),
          row(4, ANN_ENG, false, { title: "eng", department: { id: ENG_DEPT } }),
          row(5, ANN_DRAFT, false, { title: "draft" }),
        ],
        "api::wiki-space.wiki-space": [
          row(1, "sopen", true, { visibility: "public" }),
          row(2, "sopen", false, { visibility: "public" }),
          row(3, "ssales", true, salesOnly),
          row(4, "ssales", false, salesOnly),
          // Sales-only when published, widened to public in the draft.
          row(5, "swide", true, salesOnly),
          row(6, "swide", false, { visibility: "public" }),
        ],
        "api::wiki-page.wiki-page": [
          row(1, PAGE_OPEN, true, { title: "o", space: { id: 1 } }),
          row(2, PAGE_OPEN, false, { title: "o", space: { id: 2 } }),
          row(3, PAGE_SALES, true, { title: "s", space: { id: 3 } }),
          row(4, PAGE_SALES, false, { title: "s", space: { id: 4 } }),
          row(5, PAGE_WIDENED, true, { title: "w", space: { id: 5 } }),
          row(6, PAGE_WIDENED, false, { title: "w", space: { id: 6 } }),
        ],
        [COMMENT]: [
          comment(1, "announcement", ANN_ALL),
          comment(2, "announcement", ANN_ENG),
          comment(3, "announcement", ANN_DRAFT),
          comment(4, "wiki-page", PAGE_OPEN),
          comment(5, "wiki-page", PAGE_SALES),
          comment(6, "wiki-page", PAGE_WIDENED),
        ],
      },
    });
  }

  const eng: StubUser = { id: 1, role: { type: "member" } };
  const sales: StubUser = { id: 2, role: { type: "member" } };
  const CALLERS: [string, StubUser | null][] = [
    ["eng", eng],
    ["sales", sales],
    ["a caller without an id", { role: { type: "member" } }],
    ["anonymous", null],
  ];
  const ANCHORS: [string, string][] = [
    ["announcement", ANN_ALL],
    ["announcement", ANN_ENG],
    ["announcement", ANN_DRAFT],
    ["announcement", GHOST],
    ["wiki-page", PAGE_OPEN],
    ["wiki-page", PAGE_SALES],
    ["wiki-page", PAGE_WIDENED],
    ["wiki-page", ANN_ALL],
    ["event", ANN_ALL],
    ["constructor", ANN_ALL],
  ];

  /** Runs the policy and answers the ids of the comments its final filter matches. */
  async function read(user: StubUser | null, filters?: unknown) {
    const strapi = stub();
    const ctx = policyContext(user, filters === undefined ? {} : { query: { filters } });
    const result = await commentTargetVisibility(ctx, undefined, { strapi });
    const final = ctx.request.query.filters as Record<string, unknown>;
    const ids = strapi.tables[COMMENT].filter((row) => matchWhere(COMMENT, row, final)).map(
      (row) => row.id,
    );
    return { result, final, ids, calls: strapi.calls };
  }

  const pin = (targetType: string, targetDocumentId: string) => ({
    targetType: { $eq: targetType },
    targetDocumentId: { $eq: targetDocumentId },
  });
  const unpinned = (targetType: string, targetDocumentId: string) => ({
    targetType: { $in: [targetType] },
    targetDocumentId: { $in: [targetDocumentId] },
  });
  const restricted = (client: unknown) => ({ $and: [client, { id: { $eq: -1 } }] });

  it.each(CALLERS)(
    "returns the same rows with and without the fast path (%s)",
    async (_n, user) => {
      for (const [targetType, documentId] of ANCHORS) {
        const label = `${targetType} ${documentId}`;
        const fast = await read(user, pin(targetType, documentId));
        const full = await read(user, unpinned(targetType, documentId));
        expect(fast.result, label).toBe(true);
        expect(fast.ids, label).toEqual(full.ids);
        // The fast path never resolves the whole announcement table.
        const scans = fast.calls.filter(
          (call) =>
            call.uid === "api::announcement.announcement" &&
            (call.params as { where?: unknown }).where === undefined,
        );
        expect(scans, label).toEqual([]);
      }
    },
  );

  it("reads exactly the visible threads on the full path", async () => {
    // Comment 3 sits on a never-published announcement: no one's thread
    // (owner answer 2026-09-29 (b), the answer of a missing target).
    await expect(read(eng)).resolves.toMatchObject({ ids: [1, 2, 4] });
    await expect(read(sales)).resolves.toMatchObject({ ids: [1, 4, 5, 6] });
    await expect(read(null)).resolves.toMatchObject({ ids: [1, 4] });
  });

  it("injects the full path's branch for a visible anchor, $and-narrowed", async () => {
    const { final, ids } = await read(eng, pin("announcement", ANN_ENG));
    expect(final).toEqual({
      $and: [
        pin("announcement", ANN_ENG),
        { targetType: "announcement", targetDocumentId: { $in: [ANN_ENG] } },
      ],
    });
    expect(ids).toEqual([2]);
  });

  it("stays restrictive for an invisible, unknown or unsupported anchor", async () => {
    for (const [user, targetType, documentId] of [
      [sales, "announcement", ANN_ENG],
      [eng, "wiki-page", PAGE_SALES],
      // A space widened only in its draft opens nothing (published row decides).
      [eng, "wiki-page", PAGE_WIDENED],
      [eng, "announcement", GHOST],
      // An unpublished announcement answers exactly like GHOST.
      [eng, "announcement", ANN_DRAFT],
      [eng, "event", ANN_ALL],
      [eng, "constructor", ANN_ALL],
    ] as const) {
      const { final, ids } = await read(user, pin(targetType, documentId));
      expect(final, `${targetType} ${documentId}`).toEqual(restricted(pin(targetType, documentId)));
      expect(ids, `${targetType} ${documentId}`).toEqual([]);
    }
  });

  it("takes the fast path inside a top-level $and, and the full path for any other shape", async () => {
    const inAnd = await read(eng, { $and: [pin("announcement", ANN_ALL), { id: { $gt: 0 } }] });
    expect(inAnd.ids).toEqual([1]);
    expect(inAnd.calls.some((call) => call.uid === "api::wiki-space.wiki-space")).toBe(false);

    const full = await read(eng, { targetType: { $eq: "announcement" } });
    expect(full.ids).toEqual([1, 2]);
    expect(full.calls.some((call) => call.uid === "api::wiki-space.wiki-space")).toBe(true);
  });

  it("fails closed with a log when the anchors exceed the bind limit (PL04)", async () => {
    const count = 40_000;
    const error = vi.fn<(message: string) => void>();
    const strapi = {
      db: {
        query: (uid: string) => ({
          findOne: async () => null,
          findMany: async () =>
            uid === "api::announcement.announcement"
              ? Array.from({ length: count }, (_, index) => ({
                  id: index + 1,
                  documentId: `a${String(index).padStart(23, "0")}`,
                  publishedAt: PUBLISHED,
                }))
              : [],
        }),
      },
      log: { error },
    };
    const ctx = policyContext(null, { query: { filters: { body: { $contains: "x" } } } });
    await expect(commentTargetVisibility(ctx, undefined, { strapi })).resolves.toBe(true);
    expect(ctx.request.query.filters).toEqual({
      $and: [{ body: { $contains: "x" } }, { id: { $eq: -1 } }],
    });
    expect(String(error.mock.calls[0]?.[0])).toContain(
      `comment-target-visibility anchors: ${count} values`,
    );
    // A single pinned anchor binds one value: the fast path is unaffected.
    const pinned = policyContext(null, {
      query: { filters: pin("announcement", "a" + "0".repeat(23)) },
    });
    await expect(commentTargetVisibility(pinned, undefined, { strapi })).resolves.toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("lets admin_role and editor through untouched on the fast path too", async () => {
    for (const type of ["admin_role", "editor"]) {
      const { result, final, calls } = await read(
        { id: 9, role: { type } },
        pin("announcement", ANN_ENG),
      );
      expect(result, type).toBe(true);
      expect(final, type).toEqual(pin("announcement", ANN_ENG));
      expect(calls, type).toEqual([]);
    }
  });
});
