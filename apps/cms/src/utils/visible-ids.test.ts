import { describe, expect, it } from "vitest";
import { DEPT, ROLE, TEAM, USER, USER_UID, createOrgStub } from "../test/org-fixtures.test.helper";
import {
  ANNOUNCEMENT_FIND,
  EVENT_FIND,
  KUDOS_FIND,
  announcementRecipients,
  audienceScopeOf,
  holdsGrant,
  loadAllUserScopes,
  loadRoleGrants,
  loadUserScope,
  visibleWikiSpaceIds,
} from "./visible-ids";
import type { UserScope } from "./visible-ids";

/**
 * Unit tests for the wiki-space visibility helpers (issue #24).
 *
 * These are pure server-side resolvers: they touch only `strapi.db.query`
 * (which bypasses users-permissions gating AND `throwRestrictedRelations`),
 * so a small branching stub over the queried uid is enough — no Strapi
 * runtime, no database.
 *
 * `isSpaceVisible` is a module-private function, so its four visibility rules
 * (public / role / department / team) are exercised through the public
 * `visibleWikiSpaceIds`, which filters a populated space set through exactly
 * that predicate.
 */

const MEMBER_ROLE = 5;
const LEAD_ROLE = 6;
const ENGINEERING = 20;
const DESIGN = 21;
const FRONTEND_TEAM = 30;
const BACKEND_TEAM = 31;

/**
 * The full space fixture: one space per visibility rule. Ids are chosen so an
 * assertion on the returned id list unambiguously says WHICH rule matched.
 */
const SPACES = [
  { id: 1, visibility: "public" },
  { id: 2, visibility: "role", allowedRoles: [{ id: MEMBER_ROLE }, { id: LEAD_ROLE }] },
  { id: 3, visibility: "department", department: { id: ENGINEERING } },
  { id: 4, visibility: "team", team: { id: FRONTEND_TEAM } },
];

/**
 * Branching `strapi` stub. Each content-type uid gets its own findOne /
 * findMany; the space/team/user rows are supplied per test.
 */
function stubStrapi(opts: {
  user?: any;
  teams?: any[];
  spaces?: any[];
  onUserWhere?: (where: any) => void;
}) {
  return {
    db: {
      query: (uid: string) => {
        if (uid === "plugin::users-permissions.user") {
          return {
            findOne: async ({ where }: any) => {
              opts.onUserWhere?.(where);
              return opts.user && opts.user.id === where.id ? opts.user : null;
            },
            findMany: async () => [],
          };
        }
        if (uid === "api::team.team") {
          return {
            findOne: async () => null,
            findMany: async () => opts.teams ?? [],
          };
        }
        if (uid === "api::wiki-space.wiki-space") {
          return {
            findOne: async () => null,
            findMany: async () => opts.spaces ?? [],
          };
        }
        return { findOne: async () => null, findMany: async () => [] };
      },
    },
  } as any;
}

const scopeFrom = (partial: Partial<UserScope>): UserScope => ({
  teamIds: [],
  ledTeamIds: [],
  ...partial,
});

describe("visibleWikiSpaceIds (isSpaceVisible rules)", () => {
  it("returns public spaces for an anonymous caller (null scope)", async () => {
    const ids = await visibleWikiSpaceIds(stubStrapi({ spaces: SPACES }), null);
    // Only the `public` space; role/department/team all require a scope.
    expect(ids).toEqual([1]);
  });

  it("returns every space when the scope matches all four rules", async () => {
    const scope = scopeFrom({
      roleId: MEMBER_ROLE,
      departmentId: ENGINEERING,
      teamIds: [FRONTEND_TEAM],
    });
    const ids = await visibleWikiSpaceIds(stubStrapi({ spaces: SPACES }), scope);
    expect(ids).toEqual([1, 2, 3, 4]);
  });

  it("public is visible to a fully non-matching authenticated scope", async () => {
    const scope = scopeFrom({
      roleId: 999,
      departmentId: DESIGN,
      teamIds: [BACKEND_TEAM],
    });
    const ids = await visibleWikiSpaceIds(stubStrapi({ spaces: SPACES }), scope);
    expect(ids).toEqual([1]);
  });

  it("role: matches only when the role id is in allowedRoles", async () => {
    const match = await visibleWikiSpaceIds(
      stubStrapi({ spaces: SPACES }),
      scopeFrom({ roleId: LEAD_ROLE }),
    );
    expect(match).toEqual([1, 2]);

    const miss = await visibleWikiSpaceIds(
      stubStrapi({ spaces: SPACES }),
      scopeFrom({ roleId: 42 }),
    );
    expect(miss).toEqual([1]);
  });

  it("department: matches only the caller's own department", async () => {
    const match = await visibleWikiSpaceIds(
      stubStrapi({ spaces: SPACES }),
      scopeFrom({ departmentId: ENGINEERING }),
    );
    expect(match).toEqual([1, 3]);

    const miss = await visibleWikiSpaceIds(
      stubStrapi({ spaces: SPACES }),
      scopeFrom({ departmentId: DESIGN }),
    );
    expect(miss).toEqual([1]);
  });

  it("team: matches only when one of the caller's teams owns the space", async () => {
    const match = await visibleWikiSpaceIds(
      stubStrapi({ spaces: SPACES }),
      scopeFrom({ teamIds: [FRONTEND_TEAM] }),
    );
    expect(match).toEqual([1, 4]);

    const miss = await visibleWikiSpaceIds(
      stubStrapi({ spaces: SPACES }),
      scopeFrom({ teamIds: [BACKEND_TEAM] }),
    );
    expect(miss).toEqual([1]);
  });

  it("stays fail-closed: no matching space yields an empty list, never a throw", async () => {
    // Every space here is scoped; a scope that matches none must resolve to
    // []. The policy turns that into a scalar `{ id: { $eq: -1 } }` via
    // restrictiveIdFilter (covered in policy-query.test.ts) — never $in:[].
    const onlyScoped = SPACES.filter((s) => s.id !== 1);
    const ids = await visibleWikiSpaceIds(
      stubStrapi({ spaces: onlyScoped }),
      scopeFrom({ roleId: 42, departmentId: DESIGN, teamIds: [BACKEND_TEAM] }),
    );
    expect(ids).toEqual([]);
  });

  it("guards missing relation rows: role/department/team spaces with no target are hidden", async () => {
    // A malformed space (visibility set but the relation is null/absent) must
    // not fall through to visible — the predicate's null guards keep it out.
    const malformed = [
      { id: 10, visibility: "role" }, // no allowedRoles
      { id: 11, visibility: "department", department: null },
      { id: 12, visibility: "team", team: null },
      { id: 13, visibility: "public" },
    ];
    const scope = scopeFrom({
      roleId: MEMBER_ROLE,
      departmentId: ENGINEERING,
      teamIds: [FRONTEND_TEAM],
    });
    const ids = await visibleWikiSpaceIds(stubStrapi({ spaces: malformed }), scope);
    expect(ids).toEqual([13]);
  });

  it("treats an unknown visibility value as not visible (default branch)", async () => {
    const weird = [
      { id: 20, visibility: "everyone" }, // not a known rule
      { id: 21, visibility: "public" },
    ] as any;
    const scope = scopeFrom({ roleId: MEMBER_ROLE });
    const ids = await visibleWikiSpaceIds(stubStrapi({ spaces: weird }), scope);
    expect(ids).toEqual([21]);
  });
});

describe("loadUserScope", () => {
  const USER = {
    id: 7,
    role: { id: LEAD_ROLE },
    department: { id: ENGINEERING },
    teams: [{ id: FRONTEND_TEAM }, { id: BACKEND_TEAM }],
  };

  const TEAMS = [
    { id: 40, lead: { id: 7 } }, // led by our user
    { id: 41, lead: { id: 8 } }, // led by someone else
    { id: 42, lead: null }, // unassigned lead
  ];

  it("resolves role, department, member teams and led teams", async () => {
    const scope = await loadUserScope(stubStrapi({ user: USER, teams: TEAMS }), 7);
    expect(scope).toEqual({
      roleId: LEAD_ROLE,
      departmentId: ENGINEERING,
      teamIds: [FRONTEND_TEAM, BACKEND_TEAM],
      // ledTeamIds is resolved from team.lead (no inverse field on the user),
      // so only team 40 counts — not 41 (other lead) or 42 (no lead).
      ledTeamIds: [40],
    });
  });

  it("looks the user up by numeric primary-key id", async () => {
    let seenWhere: any;
    await loadUserScope(
      stubStrapi({ user: USER, teams: TEAMS, onUserWhere: (w) => (seenWhere = w) }),
      7,
    );
    expect(seenWhere).toEqual({ id: 7 });
  });

  it("fails safe to empty scope when the user row is missing", async () => {
    // findOne returns null (unknown id) — every field degrades to a safe
    // default rather than throwing, so downstream visibility resolves to
    // public-only.
    const scope = await loadUserScope(stubStrapi({ user: USER, teams: TEAMS }), 999);
    expect(scope).toEqual({
      roleId: undefined,
      departmentId: undefined,
      teamIds: [],
      ledTeamIds: [],
    });
  });

  it("tolerates a user with no role / department / teams relations", async () => {
    const sparse = { id: 3 };
    const scope = await loadUserScope(stubStrapi({ user: sparse, teams: [] }), 3);
    expect(scope).toEqual({
      roleId: undefined,
      departmentId: undefined,
      teamIds: [],
      ledTeamIds: [],
    });
  });
});

describe("loadAllUserScopes (FX19)", () => {
  it("every active user in one users query plus the team-lead map", async () => {
    const strapi = createOrgStub();
    const scopes = await loadAllUserScopes(strapi);
    expect(strapi.calls.map((call) => `${call.method} ${call.uid}`).sort()).toEqual([
      "findMany api::team.team",
      `findMany ${USER_UID}`,
    ]);
    expect(scopes.map((scope) => scope.userId)).toEqual([
      USER.alice,
      USER.bob,
      USER.carol,
      USER.dave,
      USER.gina,
      USER.anna,
    ]);
    expect(scopes.find((scope) => scope.userId === USER.dave)).toEqual({
      userId: USER.dave,
      roleId: ROLE.teamLead,
      roleType: "team_lead",
      departmentId: DEPT.sales,
      teamIds: [],
      ledTeamIds: [TEAM.frontend],
    });
    expect(scopes.find((scope) => scope.userId === USER.alice)).toMatchObject({
      roleType: "member",
      teamIds: [TEAM.frontend],
      ledTeamIds: [],
    });
  });

  it("excludes blocked users NULL-safe and keeps users without role or department", async () => {
    const strapi = createOrgStub();
    for (const user of strapi.tables[USER_UID]) {
      if (user.id === USER.bob) user.blocked = null;
      if (user.id === USER.alice) {
        user.role = null;
        user.department = null;
      }
    }
    const scopes = await loadAllUserScopes(strapi);
    expect(scopes.map((scope) => scope.userId)).toContain(USER.bob);
    expect(scopes.map((scope) => scope.userId)).not.toContain(USER.bert);
    expect(scopes.find((scope) => scope.userId === USER.alice)).toMatchObject({
      roleId: undefined,
      roleType: null,
      departmentId: undefined,
    });
  });
});

describe("loadRoleGrants (FX19)", () => {
  it("reads the holders of each action from up_permissions in one query", async () => {
    const strapi = createOrgStub();
    const grants = await loadRoleGrants(strapi, [ANNOUNCEMENT_FIND, KUDOS_FIND, EVENT_FIND]);
    expect(strapi.calls).toHaveLength(1);
    expect([...grants.holders(ANNOUNCEMENT_FIND)].sort()).toEqual(
      [
        ROLE.admin,
        ROLE.editor,
        ROLE.departmentHead,
        ROLE.teamLead,
        ROLE.member,
        ROLE.authenticated,
      ].sort(),
    );
    expect(grants.holders(ANNOUNCEMENT_FIND).has(ROLE.guest)).toBe(false);
    expect(grants.holders(EVENT_FIND).has(ROLE.guest)).toBe(true);
    // findOne alone (the fixture's noise row for guest) is no read grant here.
    expect(grants.holders("api::poll.poll.find").size).toBe(0);
  });

  it("an action that was not loaded, or rows without a role, grant nothing", async () => {
    const strapi = createOrgStub({ grants: false });
    strapi.tables["plugin::users-permissions.permission"] = [
      { id: 1, action: ANNOUNCEMENT_FIND, role: null },
      { id: 2, action: ANNOUNCEMENT_FIND, role: { id: ROLE.member } },
    ];
    const grants = await loadRoleGrants(strapi, [ANNOUNCEMENT_FIND]);
    expect([...grants.holders(ANNOUNCEMENT_FIND)]).toEqual([ROLE.member]);
    expect(grants.holders(KUDOS_FIND).size).toBe(0);
  });
});

describe("the announcement recipient filter (FX19)", () => {
  async function recipients(targeting: Parameters<typeof announcementRecipients>[0]) {
    const strapi = createOrgStub();
    const [scopes, grants] = await Promise.all([
      loadAllUserScopes(strapi),
      loadRoleGrants(strapi, [ANNOUNCEMENT_FIND]),
    ]);
    return announcementRecipients(targeting, scopes, grants.holders(ANNOUNCEMENT_FIND)).map(
      (scope) => scope.userId,
    );
  }

  it("guest and blocked are excluded, everyone else with the grant is in", async () => {
    expect(await recipients({})).toEqual([USER.alice, USER.bob, USER.carol, USER.dave, USER.anna]);
    expect(await recipients({ department: { id: DEPT.engineering } })).toEqual([
      USER.alice,
      USER.carol,
    ]);
  });

  it("a team's lead is included although no member", async () => {
    expect(await recipients({ team: { id: TEAM.frontend } })).toEqual([USER.alice, USER.dave]);
  });

  it("admins and editors get strictly the targeted audience", async () => {
    expect(await recipients({ audienceRoles: [{ id: ROLE.member }] })).toEqual([
      USER.alice,
      USER.bob,
    ]);
  });

  it("holdsGrant and audienceScopeOf", () => {
    const scope: UserScope = {
      roleId: ROLE.member,
      departmentId: 1,
      teamIds: [2],
      ledTeamIds: [3],
    };
    expect(holdsGrant(scope, new Set([ROLE.member]))).toBe(true);
    expect(holdsGrant(scope, new Set([ROLE.guest]))).toBe(false);
    expect(holdsGrant({ ...scope, roleId: undefined }, new Set([ROLE.member]))).toBe(false);
    expect(audienceScopeOf(scope)).toEqual({
      roleId: ROLE.member,
      departmentId: 1,
      teamIds: [2, 3],
    });
  });
});
