import { describe, expect, it } from "vitest";
import announcementVisibility from "./announcement-visibility";

/**
 * Wiring test for the read policy: it must resolve the caller's scope,
 * decide visibility in JS and inject a NON-relational id filter into the
 * REAL request query.
 *
 * The four traps this pins down (all of them shipped bugs once, see
 * utils/policy-query.ts):
 *   1. the filter must land on `policyContext.request.query`, not on the
 *      throw-away `policyContext.query` copy,
 *   2. an empty visible-id list must stay restrictive (`$eq: -1`),
 *   3. a client-supplied filter may only be narrowed, never replaced, and
 *   4. the id list spans drafts AND published rows, so the publication
 *      state must be pinned server-side — otherwise `?status=draft` reads
 *      unpublished announcements.
 *
 * The policy only touches `strapi.db.query`, so a small stub is enough —
 * no Strapi runtime, no database.
 */

const ENGINEERING = 1;
const DESIGN = 2;
const FRONTEND_TEAM = 10;
const MEMBER_ROLE = 5;
const TEAM_LEAD_ROLE = 6;

interface StubUser {
  id: number;
  role?: { id: number; type: string };
  department?: { id: number };
  teams?: { id: number }[];
}

const ANNOUNCEMENTS = [
  { id: 1, audience: "all" },
  { id: 2, audience: "departments", department: { id: ENGINEERING } },
  { id: 3, audience: "all", team: { id: FRONTEND_TEAM } },
  { id: 4, audience: "all", audienceRoles: [{ id: TEAM_LEAD_ROLE }] },
];

/** Frontend team, led by user 7, with user 8 as a plain member. */
const TEAMS = [{ id: FRONTEND_TEAM, lead: { id: 7 } }];

function stubStrapi(users: StubUser[]) {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async ({ where }: any) =>
          users.find((u) => u.id === where.id) ?? null,
        findMany: async () =>
          uid === "api::team.team"
            ? TEAMS
            : uid === "api::announcement.announcement"
              ? ANNOUNCEMENTS
              : [],
      }),
    },
  };
}

/**
 * Minimal Koa-ish policy context: `query` lives on `request`, which is the
 * only object the controller later reads through (`ctx.query` delegates to
 * `ctx.request.query`). `query` carries whatever the CLIENT sent.
 */
function context(user: StubUser | null, query: Record<string, unknown> = {}) {
  return {
    state: user ? { user } : {},
    request: { query: { ...query } },
  } as any;
}

const run = (ctx: any, users: StubUser[]) =>
  announcementVisibility(ctx, undefined, { strapi: stubStrapi(users) } as any);

describe("announcement-visibility policy", () => {
  it("lets admin_role through without touching the query", async () => {
    const admin = { id: 1, role: { id: 1, type: "admin_role" } };
    const ctx = context(admin, { status: "draft" });
    await expect(run(ctx, [admin])).resolves.toBe(true);
    expect(ctx.request.query.filters).toBeUndefined();
    // admin_role / editor bypass BEFORE the status is pinned — they author
    // the drafts and must keep reading them.
    expect(ctx.request.query.status).toBe("draft");
  });

  it("restricts a member to untargeted announcements of their department", async () => {
    const designer: StubUser = {
      id: 6,
      role: { id: MEMBER_ROLE, type: "member" },
      department: { id: DESIGN },
    };
    const ctx = context(designer);
    await run(ctx, [designer]);
    // #2 is Engineering-only, #3 is team-scoped, #4 is role-scoped.
    expect(ctx.request.query.filters).toEqual({ id: { $in: [1] } });
  });

  it("includes the department announcement for that department's members", async () => {
    const engineer: StubUser = {
      id: 2,
      role: { id: MEMBER_ROLE, type: "member" },
      department: { id: ENGINEERING },
    };
    const ctx = context(engineer);
    await run(ctx, [engineer]);
    expect(ctx.request.query.filters).toEqual({ id: { $in: [1, 2] } });
  });

  it("counts the team LEAD as a team member (no inverse field on the user)", async () => {
    const lead: StubUser = {
      id: 7,
      role: { id: TEAM_LEAD_ROLE, type: "team_lead" },
      department: { id: DESIGN },
      teams: [],
    };
    const ctx = context(lead);
    await run(ctx, [lead]);
    // #3 via the led team, #4 via the team_lead role.
    expect(ctx.request.query.filters).toEqual({ id: { $in: [1, 3, 4] } });
  });

  it("keeps a caller-supplied filter and only narrows it", async () => {
    const engineer: StubUser = {
      id: 2,
      role: { id: MEMBER_ROLE, type: "member" },
      department: { id: ENGINEERING },
    };
    const ctx = context(engineer, { filters: { requiresAck: { $eq: true } } });
    await run(ctx, [engineer]);
    expect(ctx.request.query.filters).toEqual({
      $and: [{ requiresAck: { $eq: true } }, { id: { $in: [1, 2] } }],
    });
  });

  it("gives an anonymous caller only the untargeted announcements", async () => {
    const ctx = context(null);
    await run(ctx, []);
    expect(ctx.request.query.filters).toEqual({ id: { $in: [1] } });
  });

  it("stays restrictive when nothing is visible (no fail-open empty $in)", async () => {
    const stranger: StubUser = { id: 9, role: { id: MEMBER_ROLE, type: "member" } };
    const ctx = context(stranger);
    // Every announcement in this scenario carries a criterion.
    const onlyTargeted = ANNOUNCEMENTS.filter((a) => a.id !== 1);
    const strapi = {
      db: {
        query: (uid: string) => ({
          findOne: async () => stranger,
          findMany: async () =>
            uid === "api::team.team"
              ? TEAMS
              : uid === "api::announcement.announcement"
                ? onlyTargeted
                : [],
        }),
      },
    };
    await announcementVisibility(ctx, undefined, { strapi } as any);
    expect(ctx.request.query.filters).toEqual({ id: { $eq: -1 } });
  });

  describe("publication state", () => {
    const engineer: StubUser = {
      id: 2,
      role: { id: MEMBER_ROLE, type: "member" },
      department: { id: ENGINEERING },
    };

    it("overrides a client-supplied ?status=draft with 'published'", async () => {
      // The id list comes from strapi.db.query and therefore spans draft AND
      // published rows; without this, `?status=draft` would return the
      // UNPUBLISHED announcements the caller is targeted by.
      const ctx = context(engineer, { status: "draft" });
      await run(ctx, [engineer]);
      expect(ctx.request.query.status).toBe("published");
    });

    it("pins the status even when the client sent none", async () => {
      const ctx = context(engineer);
      await run(ctx, [engineer]);
      expect(ctx.request.query.status).toBe("published");
    });

    it("removes the legacy v4 publicationState param", async () => {
      // Inert in Strapi 5, but sanitizeQuery keeps unknown keys (no
      // api.rest.strictParams configured), so it must not survive.
      const ctx = context(engineer, { status: "draft", publicationState: "preview" });
      await run(ctx, [engineer]);
      expect(ctx.request.query.status).toBe("published");
      expect("publicationState" in ctx.request.query).toBe(false);
    });

    it("pins the status without disturbing the injected id filter", async () => {
      const ctx = context(engineer, { status: "draft" });
      await run(ctx, [engineer]);
      expect(ctx.request.query.filters).toEqual({ id: { $in: [1, 2] } });
    });
  });
});
