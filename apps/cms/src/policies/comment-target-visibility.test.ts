import { describe, expect, it } from "vitest";

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
