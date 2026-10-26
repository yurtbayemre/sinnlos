import { afterEach, describe, expect, it, vi } from "vitest";
import { createStrapiStub, policyContext } from "../test/strapi-stub.test.helper";
import announcementVisibility from "./announcement-visibility";
import { narrowedFilters, withNarrowing } from "../test/narrowing.test.helper";

/**
 * Wiring test for the read policy: it must resolve the caller's scope,
 * decide visibility in JS and leave a NON-relational id clause for the
 * Document Service reads of the request (#175; filtersOf runs the real
 * narrowing middleware over what the policy stored).
 *
 * The traps this pins down (all of them shipped bugs once, see
 * utils/policy-query.ts):
 *   1. the status pin must land on `policyContext.request.query`, not on
 *      the throw-away `policyContext.query` copy,
 *   2. an empty visible-id list must stay restrictive (it matches nothing),
 *   3. a client-supplied filter may only be narrowed, never replaced, and
 *   4. the id list spans drafts AND published rows, so the publication
 *      state must be pinned server-side — otherwise `?status=draft` reads
 *      unpublished announcements.
 *
 * The policy only touches `strapi.db.query` and the request context, so a
 * small stub is enough — no Strapi runtime, no database.
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
        findOne: async ({ where }: any) => users.find((u) => u.id === where.id) ?? null,
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
  announcementVisibility(ctx, undefined, { strapi: withNarrowing(stubStrapi(users), ctx) } as any);

/** The filters a read gets once the Document Service applied what the policy stored (#175). */
const filtersOf = (ctx: { state?: object; request: { query: Record<string, unknown> } }) =>
  narrowedFilters(ctx, "api::announcement.announcement", ctx.request.query.filters);

describe("announcement-visibility policy", () => {
  it("lets admin_role through without touching the query", async () => {
    const admin = { id: 1, role: { id: 1, type: "admin_role" } };
    const ctx = context(admin, { status: "draft" });
    await expect(run(ctx, [admin])).resolves.toBe(true);
    expect(await filtersOf(ctx)).toBeUndefined();
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
    expect(await filtersOf(ctx)).toEqual({ id: { $in: [1] } });
  });

  it("includes the department announcement for that department's members", async () => {
    const engineer: StubUser = {
      id: 2,
      role: { id: MEMBER_ROLE, type: "member" },
      department: { id: ENGINEERING },
    };
    const ctx = context(engineer);
    await run(ctx, [engineer]);
    expect(await filtersOf(ctx)).toEqual({ id: { $in: [1, 2] } });
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
    expect(await filtersOf(ctx)).toEqual({ id: { $in: [1, 3, 4] } });
  });

  it("keeps a caller-supplied filter and only narrows it", async () => {
    const engineer: StubUser = {
      id: 2,
      role: { id: MEMBER_ROLE, type: "member" },
      department: { id: ENGINEERING },
    };
    const ctx = context(engineer, { filters: { requiresAck: { $eq: true } } });
    await run(ctx, [engineer]);
    expect(await filtersOf(ctx)).toEqual({
      $and: [{ requiresAck: { $eq: true } }, { id: { $in: [1, 2] } }],
    });
  });

  it("gives an anonymous caller only the untargeted announcements", async () => {
    const ctx = context(null);
    await run(ctx, []);
    expect(await filtersOf(ctx)).toEqual({ id: { $in: [1] } });
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
    await announcementVisibility(ctx, undefined, { strapi: withNarrowing(strapi, ctx) } as any);
    expect(await filtersOf(ctx)).toEqual({ id: { $in: [] } });
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
      expect(await filtersOf(ctx)).toEqual({ id: { $in: [1, 2] } });
    });
  });
});

describe("announcement expiry (DA02, owner answer 2026-09-29 (b))", () => {
  // The shared stub evaluates the where clause the policy sends, so the
  // expiry has to be in the query: an expired row is not among the ids.
  const NOW = new Date("2026-09-29T10:00:00.000Z");
  const UID = "api::announcement.announcement";

  afterEach(() => {
    vi.useRealTimers();
  });

  function expiryStub() {
    return createStrapiStub({
      tables: {
        "plugin::users-permissions.user": [{ id: 2, username: "eng", department: null }],
        [UID]: [
          { id: 1, audience: "all", expiresAt: null },
          { id: 2, audience: "all", expiresAt: "2026-09-29T09:59:59.000Z" },
          // Expires exactly now: expired from this instant on.
          { id: 3, audience: "all", expiresAt: "2026-09-29T10:00:00.000Z" },
          { id: 4, audience: "all", expiresAt: "2026-09-29T10:00:01.000Z" },
          { id: 5, audience: "all" },
        ],
      },
    });
  }

  const idsFor = async (user: { id: number; role: { type: string } } | null) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const strapi = expiryStub();
    const ctx = policyContext(user);
    await expect(
      announcementVisibility(ctx, undefined, { strapi: withNarrowing(strapi, ctx) }),
    ).resolves.toBe(true);
    return filtersOf(ctx);
  };

  it("drops announcements whose expiresAt instant has passed, for members and anonymous alike", async () => {
    expect(await idsFor({ id: 2, role: { type: "member" } })).toEqual({ id: { $in: [1, 4, 5] } });
    expect(await idsFor(null)).toEqual({ id: { $in: [1, 4, 5] } });
  });

  it("leaves expired announcements to admin_role and editor (bypass, query untouched)", async () => {
    for (const type of ["admin_role", "editor"]) {
      expect(await idsFor({ id: 2, role: { type } }), type).toBeUndefined();
    }
  });
});

describe("fail-closed targeting (D-PT01 and the re-target marker, batch 15)", () => {
  // The shared stub honours the select, so a policy that did not select
  // `retargetRequired` would let rows 3 and 4 through.
  const UID = "api::announcement.announcement";
  const ENGINEERING_ID = 10;
  const FRONTEND_ID = 30;

  function failClosedStub() {
    return createStrapiStub({
      tables: {
        "plugin::users-permissions.user": [
          {
            id: 2,
            username: "eng",
            department: { id: ENGINEERING_ID },
            teams: [{ id: FRONTEND_ID }],
            role: { id: MEMBER_ROLE, type: "member" },
          },
        ],
        "api::team.team": [{ id: FRONTEND_ID, lead: null }],
        [UID]: [
          { id: 1, audience: "all" },
          // D-PT01: restricted, nothing left to restrict to.
          { id: 2, audience: "departments", department: null, team: null },
          // The team was deleted: the department remains, the marker holds.
          {
            id: 3,
            audience: "departments",
            department: { id: ENGINEERING_ID },
            retargetRequired: true,
          },
          // The department was deleted: the team remains, the marker holds.
          { id: 4, audience: "departments", team: { id: FRONTEND_ID }, retargetRequired: true },
          // Re-targeted: the marker is off again.
          {
            id: 5,
            audience: "departments",
            department: { id: ENGINEERING_ID },
            retargetRequired: false,
          },
        ],
      },
    });
  }

  const filtersFor = async (user: { id: number; role: { type: string } } | null) => {
    const ctx = policyContext(user);
    await expect(
      announcementVisibility(ctx, undefined, { strapi: withNarrowing(failClosedStub(), ctx) }),
    ).resolves.toBe(true);
    return filtersOf(ctx);
  };

  it("hides restricted announcements from their remaining audience and from anonymous callers", async () => {
    expect(await filtersFor({ id: 2, role: { type: "member" } })).toEqual({
      id: { $in: [1, 5] },
    });
    expect(await filtersFor(null)).toEqual({ id: { $in: [1] } });
  });

  it("leaves them to admin_role and editor (bypass, query untouched)", async () => {
    for (const type of ["admin_role", "editor"]) {
      expect(await filtersFor({ id: 2, role: { type } }), type).toBeUndefined();
    }
  });
});

describe("a department delete between the policy's reads (batch 15)", () => {
  it("re-reads the marker after the relations: a torn read admits nobody", async () => {
    const UID = "api::announcement.announcement";
    // Committed: Engineering deleted, the marker set, the Frontend team left.
    const strapi = createStrapiStub({
      tables: {
        "plugin::users-permissions.user": [
          {
            id: 2,
            username: "eng",
            department: { id: 10 },
            teams: [{ id: FRONTEND_TEAM }],
            role: { id: MEMBER_ROLE, type: "member" },
          },
        ],
        "api::team.team": [{ id: FRONTEND_TEAM, lead: null }],
        [UID]: [
          { id: 1, audience: "departments", team: { id: FRONTEND_TEAM }, retargetRequired: true },
        ],
      },
    });
    // The scalar select ran before the delete committed, the populate after.
    const query = strapi.db.query.bind(strapi.db);
    strapi.db.query = (uid: string) => {
      const inner = query(uid);
      if (uid !== UID) return inner;
      return {
        ...inner,
        findMany: async (params) => {
          const rows = await inner.findMany(params);
          return params?.populate ? rows.map((row) => ({ ...row, retargetRequired: false })) : rows;
        },
      };
    };
    const ctx = policyContext({ id: 2, role: { type: "member" } });
    await expect(
      announcementVisibility(ctx, undefined, { strapi: withNarrowing(strapi, ctx) }),
    ).resolves.toBe(true);
    expect(await filtersOf(ctx)).toEqual({ id: { $in: [] } });
  });
});
