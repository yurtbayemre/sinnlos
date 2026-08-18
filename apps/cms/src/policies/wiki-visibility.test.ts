import { describe, expect, it } from "vitest";
import wikiVisibility from "./wiki-visibility";

/**
 * Wiring test for the wiki read policy. It resolves the set of visible
 * wiki-space ids SERVER-SIDE (via loadUserScope + visibleWikiSpaceIds) and
 * injects a NON-relational id filter into the REAL request query. The
 * applicable content-type level arrives per route via `config.level`:
 *   - "space"    → the space ids themselves,
 *   - "page"     → pages whose space is visible (join),
 *   - "revision" → revisions whose page's space is visible (join).
 * wiki-page / wiki-revision have no visibility of their own; they inherit it.
 *
 * Space visibility rules: public → everyone (incl. anon); role → role in
 * allowedRoles; department → department matches; team → one of the caller's
 * teams matches. admin_role / editor bypass entirely.
 *
 * The regression traps this pins down (utils/policy-query.ts, issue #24):
 *   (a) the filter must land on `policyContext.request.query`, not the
 *       throw-away `policyContext.query` copy,
 *   (b) an empty visible-id list stays restrictive (`$eq: -1`, never `$in: []`),
 *   (d) the id list spans drafts AND published, so status is pinned
 *       "published" server-side; admin/editor bypass first.
 *   (c) documentId-vs-id is N/A — read policy, no single-row primary-key lookup.
 *
 * The policy only touches `strapi.db.query`, so plain-object stubs suffice.
 */

const ENGINEERING = 1;
const FRONTEND_TEAM = 10;
const MEMBER_ROLE = 5;
const OTHER_ROLE = 7; // in no space's allowedRoles

interface StubUser {
  id: number;
  role?: { id: number; type: string };
  department?: { id: number };
  teams?: { id: number }[];
}

interface SpaceRow {
  id: number;
  visibility: "public" | "role" | "department" | "team";
  allowedRoles?: { id: number }[];
  department?: { id: number };
  team?: { id: number };
}

/** One space per visibility mode. */
const SPACES: SpaceRow[] = [
  { id: 100, visibility: "public" },
  { id: 101, visibility: "role", allowedRoles: [{ id: MEMBER_ROLE }] },
  { id: 102, visibility: "department", department: { id: ENGINEERING } },
  { id: 103, visibility: "team", team: { id: FRONTEND_TEAM } },
];

/** Pages / revisions carry the id of the space they belong to (join key). */
const PAGES = [
  { id: 200, spaceId: 100 },
  { id: 201, spaceId: 101 },
  { id: 202, spaceId: 102 },
  { id: 203, spaceId: 103 },
];
const REVISIONS = [
  { id: 300, spaceId: 100 },
  { id: 301, spaceId: 101 },
  { id: 302, spaceId: 102 },
  { id: 303, spaceId: 103 },
];

const TEAMS = [{ id: FRONTEND_TEAM, lead: { id: 999 } }];

/** role-only, department-only and team-only callers, each matching one space. */
const roleUser: StubUser = { id: 10, role: { id: MEMBER_ROLE, type: "member" } };
const deptUser: StubUser = {
  id: 11,
  role: { id: OTHER_ROLE, type: "member" },
  department: { id: ENGINEERING },
};
const teamUser: StubUser = {
  id: 12,
  role: { id: OTHER_ROLE, type: "member" },
  teams: [{ id: FRONTEND_TEAM }],
};

const USERS = [roleUser, deptUser, teamUser];

interface StubOverrides {
  spaces?: SpaceRow[];
  users?: StubUser[];
  teams?: { id: number; lead?: { id: number } }[];
  pages?: { id: number; spaceId: number }[];
  revisions?: { id: number; spaceId: number }[];
}

function stubStrapi(overrides: StubOverrides = {}) {
  const {
    spaces = SPACES,
    users = USERS,
    teams = TEAMS,
    pages = PAGES,
    revisions = REVISIONS,
  } = overrides;
  return {
    db: {
      query: (uid: string) => ({
        findOne: async ({ where }: any) => users.find((u) => u.id === where.id) ?? null,
        findMany: async (params: any = {}) => {
          switch (uid) {
            case "api::wiki-space.wiki-space":
              return spaces;
            case "api::team.team":
              return teams;
            case "api::wiki-page.wiki-page": {
              const ids: number[] = params?.where?.space?.id?.$in ?? [];
              return pages.filter((p) => ids.includes(p.spaceId)).map((p) => ({ id: p.id }));
            }
            case "api::wiki-revision.wiki-revision": {
              const ids: number[] = params?.where?.page?.space?.id?.$in ?? [];
              return revisions
                .filter((r) => ids.includes(r.spaceId))
                .map((r) => ({ id: r.id }));
            }
            default:
              return [];
          }
        },
      }),
    },
  };
}

function context(user: StubUser | null, query: Record<string, unknown> = {}) {
  return {
    state: user ? { user } : {},
    request: { query: { ...query } },
  } as any;
}

const run = (
  ctx: any,
  level?: "space" | "page" | "revision",
  overrides: StubOverrides = {},
) =>
  wikiVisibility(
    ctx,
    level ? { level } : undefined,
    { strapi: stubStrapi(overrides) } as any,
  );

describe("wiki-visibility policy", () => {
  describe("space level", () => {
    it("defaults to the space level when no config is given", async () => {
      const ctx = context(roleUser);
      await run(ctx); // config undefined → level "space"
      expect(ctx.request.query.filters).toEqual({ id: { $in: [100, 101] } });
    });

    it("shows an anonymous caller only public spaces", async () => {
      const ctx = context(null);
      await run(ctx, "space");
      expect(ctx.request.query.filters).toEqual({ id: { $in: [100] } });
    });

    it("adds a role space when the caller's role is allowed", async () => {
      const ctx = context(roleUser);
      await run(ctx, "space");
      expect(ctx.request.query.filters).toEqual({ id: { $in: [100, 101] } });
    });

    it("adds a department space when the caller's department matches", async () => {
      const ctx = context(deptUser);
      await run(ctx, "space");
      expect(ctx.request.query.filters).toEqual({ id: { $in: [100, 102] } });
    });

    it("adds a team space when one of the caller's teams matches", async () => {
      const ctx = context(teamUser);
      await run(ctx, "space");
      expect(ctx.request.query.filters).toEqual({ id: { $in: [100, 103] } });
    });

    it("lets admin_role through without touching the query (trap d bypass)", async () => {
      const admin = { id: 1, role: { id: 1, type: "admin_role" } };
      const ctx = context(admin, { status: "draft" });
      await expect(run(ctx, "space")).resolves.toBe(true);
      expect(ctx.request.query.filters).toBeUndefined();
      expect(ctx.request.query.status).toBe("draft");
    });

    it("lets editor through without touching the query", async () => {
      const ed = { id: 1, role: { id: 3, type: "editor" } };
      const ctx = context(ed, { status: "draft" });
      await expect(run(ctx, "space")).resolves.toBe(true);
      expect(ctx.request.query.filters).toBeUndefined();
      expect(ctx.request.query.status).toBe("draft");
    });

    it("stays restrictive when nothing is visible (no fail-open empty $in — trap b)", async () => {
      // No public space + anonymous caller → nothing visible.
      const noPublic = SPACES.filter((s) => s.visibility !== "public");
      const ctx = context(null);
      await run(ctx, "space", { spaces: noPublic });
      expect(ctx.request.query.filters).toEqual({ id: { $eq: -1 } });
    });

    it("keeps a caller-supplied filter and only narrows it", async () => {
      const ctx = context(roleUser, { filters: { slug: { $eq: "handbook" } } });
      await run(ctx, "space");
      expect(ctx.request.query.filters).toEqual({
        $and: [{ slug: { $eq: "handbook" } }, { id: { $in: [100, 101] } }],
      });
    });

    it("writes onto request.query, never the throw-away ctx.query copy (trap a)", async () => {
      const ctx = context(roleUser);
      ctx.query = {};
      await run(ctx, "space");
      expect(ctx.request.query.filters).toEqual({ id: { $in: [100, 101] } });
      expect(ctx.query.filters).toBeUndefined();
    });
  });

  describe("page level (inherits space visibility via join)", () => {
    it("returns the pages of the caller's visible spaces", async () => {
      const ctx = context(roleUser);
      await run(ctx, "page");
      // spaces [100, 101] → pages [200, 201].
      expect(ctx.request.query.filters).toEqual({ id: { $in: [200, 201] } });
    });

    it("gives an anonymous caller only public-space pages", async () => {
      const ctx = context(null);
      await run(ctx, "page");
      expect(ctx.request.query.filters).toEqual({ id: { $in: [200] } });
    });

    it("stays restrictive when no space is visible (trap b, join skipped)", async () => {
      const noPublic = SPACES.filter((s) => s.visibility !== "public");
      const ctx = context(null);
      await run(ctx, "page", { spaces: noPublic });
      expect(ctx.request.query.filters).toEqual({ id: { $eq: -1 } });
    });
  });

  describe("revision level (inherits space visibility via nested join)", () => {
    it("returns the revisions of the caller's visible spaces", async () => {
      const ctx = context(roleUser);
      await run(ctx, "revision");
      // spaces [100, 101] → revisions [300, 301].
      expect(ctx.request.query.filters).toEqual({ id: { $in: [300, 301] } });
    });

    it("gives an anonymous caller only public-space revisions", async () => {
      const ctx = context(null);
      await run(ctx, "revision");
      expect(ctx.request.query.filters).toEqual({ id: { $in: [300] } });
    });

    it("stays restrictive when no space is visible (trap b, join skipped)", async () => {
      const noPublic = SPACES.filter((s) => s.visibility !== "public");
      const ctx = context(null);
      await run(ctx, "revision", { spaces: noPublic });
      expect(ctx.request.query.filters).toEqual({ id: { $eq: -1 } });
    });
  });

  describe("publication state (trap d)", () => {
    it("overrides a client-supplied ?status=draft with 'published'", async () => {
      const ctx = context(roleUser, { status: "draft" });
      await run(ctx, "space");
      expect(ctx.request.query.status).toBe("published");
    });

    it("pins the status even when the client sent none", async () => {
      const ctx = context(roleUser);
      await run(ctx, "space");
      expect(ctx.request.query.status).toBe("published");
    });

    it("removes the legacy v4 publicationState param", async () => {
      const ctx = context(roleUser, { status: "draft", publicationState: "preview" });
      await run(ctx, "space");
      expect(ctx.request.query.status).toBe("published");
      expect("publicationState" in ctx.request.query).toBe(false);
    });

    it("pins the status without disturbing the injected id filter", async () => {
      const ctx = context(roleUser, { status: "draft" });
      await run(ctx, "page");
      expect(ctx.request.query.filters).toEqual({ id: { $in: [200, 201] } });
    });
  });
});
