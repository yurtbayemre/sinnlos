import { readdirSync } from "node:fs";
import { join } from "node:path";
import { errors } from "@strapi/utils";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createStrapiStub,
  policyContext,
  type StrapiStub,
  type StubPolicyContext,
  type StubUser,
} from "../test/strapi-stub.test.helper";

/**
 * Contract for EVERY policy module in src/policies (roadmap S03), on the
 * shared stub (src/test/strapi-stub.test.helper.ts). The per-policy suites
 * next to this file pin each policy's own rules; this one pins what all of
 * them owe the framework, parameterised over the directory listing, so a new
 * policy without an entry in CONTRACTS fails here:
 *
 *   1. Strict booleans on every branch. Strapi counts `undefined` as a PASS
 *      (@strapi/core services/server/policy.js, pinned in
 *      framework-contract.test.ts), so every outcome must be exactly true or
 *      false, for callers without a user, a role, a role type or an id, for
 *      lookalike role spellings and for missing, malformed and foreign
 *      target ids. The only other outcome is a 400 (a ValidationError): the
 *      write allowlist's, for the three FX07 write gates, and
 *      event-rsvp-own-rows' refusal of a client filter on the user
 *      relation (pinned in its own suite; the sweep below sends none).
 *   2. Fail closed without a caller: a policy that is not meant for
 *      anonymous callers returns false for them; role and write gates also
 *      refuse a caller without a role, and no gate lets a caller without a
 *      numeric id through.
 *   3. The bypass table: exactly the listed role types pass with the
 *      request untouched and no data read. Personal data (acknowledgements,
 *      lesson progress, notifications, RSVPs) bypasses admin_role only, never
 *      editor; content visibility and moderation bypass admin_role and
 *      editor (poll-visibility: read bypass for authoring, decision 02); the
 *      is-classified-author bypass comes from the route config.
 *   4. Injected filters land on the REAL request query (policyContext.request
 *      .query, §5.14), never on the own `query` copy createPolicyContext
 *      leaves behind; a client filter is kept and $and-narrowed, never
 *      replaced; read policies on draft & publish types pin
 *      status=published and drop the publication-cohort keys (§5.24).
 */

type PolicyFn = (ctx: StubPolicyContext, config: unknown, deps: { strapi: StrapiStub }) => unknown;

const ROLE_TYPES = [
  "admin_role",
  "editor",
  "department_head",
  "team_lead",
  "member",
  "guest",
  "authenticated",
] as const;
type RoleType = (typeof ROLE_TYPES)[number];

/** Spellings that must never be read as a role (every check is exact). */
const LOOKALIKE_ROLES = [
  "Admin_role",
  "ADMIN_ROLE",
  "admin",
  " editor",
  "Editor",
  "public",
  "superuser",
  "",
];

const ROLE_ID: Record<RoleType, number> = {
  admin_role: 1,
  editor: 2,
  department_head: 3,
  team_lead: 4,
  member: 5,
  guest: 6,
  authenticated: 7,
};

/** One user per role type; the member (105) owns the "own" rows below. */
const USER_ID: Record<RoleType, number> = {
  admin_role: 101,
  editor: 102,
  department_head: 103,
  team_lead: 104,
  member: 105,
  guest: 106,
  authenticated: 107,
};
const OWNER = USER_ID.member;
/** A member of the other department; owns the "foreign" rows. */
const STRANGER = 108;

const USER = "plugin::users-permissions.user";
const DEPARTMENT = "api::department.department";
const TEAM = "api::team.team";
const WIKI_SPACE = "api::wiki-space.wiki-space";
const WIKI_PAGE = "api::wiki-page.wiki-page";

const DEPT_ENG = "deng00000000000000000000";
const DEPT_OPS = "dops00000000000000000000";
const TEAM_FE = "tfe000000000000000000000";

const roleOf = (type: RoleType) => ({ id: ROLE_ID[type], type });

interface Fixture {
  strapi: StrapiStub;
  /** documentIds of the rows the member may edit / the stranger owns. */
  ids: Record<string, string>;
}

/**
 * One intranet: two departments, a team, one own and one foreign row per
 * ownership type, and draft & publish documents (with twins) for every read
 * policy. Built fresh per use: policies only read it.
 */
function fixture(): Fixture {
  const user = (id: number, type: RoleType, department: number | null, teams: number[] = []) => ({
    id,
    username: `u${id}`,
    role: roleOf(type),
    department: department === null ? null : { id: department },
    teams: teams.map((team) => ({ id: team })),
  });
  const strapi = createStrapiStub({
    tables: {
      [USER]: [
        user(USER_ID.admin_role, "admin_role", null),
        user(USER_ID.editor, "editor", null),
        user(USER_ID.department_head, "department_head", 10),
        user(USER_ID.team_lead, "team_lead", 10, [30]),
        user(OWNER, "member", 10, [30]),
        user(USER_ID.guest, "guest", 10),
        user(USER_ID.authenticated, "authenticated", null),
        user(STRANGER, "member", 11),
      ],
      [DEPARTMENT]: [
        {
          id: 10,
          documentId: DEPT_ENG,
          name: "Engineering",
          publishedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: 11,
          documentId: DEPT_OPS,
          name: "Operations",
          publishedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      [TEAM]: [
        {
          id: 30,
          documentId: TEAM_FE,
          name: "Frontend",
          lead: { id: USER_ID.team_lead },
          department: { id: 10 },
          members: [{ id: USER_ID.team_lead }, { id: OWNER }],
          publishedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      "api::classified.classified": [
        { id: 1, documentId: "clown0000000000000000000", author: { id: OWNER } },
        { id: 2, documentId: "clfor0000000000000000000", author: { id: STRANGER } },
        { id: 3, documentId: "clnoauthor00000000000000", author: null },
      ],
      "api::event-rsvp.event-rsvp": [
        { id: 1, documentId: "rsown0000000000000000000", user: { id: OWNER } },
        { id: 2, documentId: "rsfor0000000000000000000", user: { id: STRANGER } },
        { id: 3, documentId: "rsnouser0000000000000000", user: null },
      ],
      "api::notification.notification": [
        { id: 1, documentId: "noown0000000000000000000", recipient: { id: OWNER } },
        { id: 2, documentId: "nofor0000000000000000000", recipient: { id: STRANGER } },
        { id: 3, documentId: "nonorecip000000000000000", recipient: null },
      ],
      "api::reaction.reaction": [
        { id: 1, documentId: "reown0000000000000000000", author: { id: OWNER } },
        { id: 2, documentId: "refor0000000000000000000", author: { id: STRANGER } },
        { id: 3, documentId: "renoauthor00000000000000", author: null },
      ],
    },
  });

  const published = { status: "published" as const };
  const spacePublic = strapi.seedDocument(
    WIKI_SPACE,
    { title: "Handbook", visibility: "public" },
    published,
  );
  const spaceOps = strapi.seedDocument(
    WIKI_SPACE,
    { title: "Ops", visibility: "department", department: { id: 11 } },
    published,
  );
  const spaceRef = (seeded: { published: { id: number } | null }) => ({
    id: seeded.published?.id ?? 0,
  });
  const pageOwn = strapi.seedDocument(
    WIKI_PAGE,
    {
      title: "Own",
      space: spaceRef(spacePublic),
      author: { id: OWNER },
      department: { id: 10 },
      team: { id: 30 },
    },
    published,
  );
  const pageForeign = strapi.seedDocument(
    WIKI_PAGE,
    {
      title: "Foreign",
      space: spaceRef(spaceOps),
      author: { id: STRANGER },
      department: { id: 11 },
    },
    published,
  );
  strapi.seedDocument(
    "api::wiki-revision.wiki-revision",
    { page: { id: pageOwn.published?.id ?? 0 } },
    published,
  );

  strapi.seedDocument("api::announcement.announcement", { title: "All" }, published);
  strapi.seedDocument(
    "api::announcement.announcement",
    { title: "Ops", department: { id: 11 } },
    published,
  );
  strapi.seedDocument("api::document.document", { title: "All", departments: [] }, published);
  strapi.seedDocument(
    "api::document.document",
    { title: "Ops", departments: [{ id: 11 }] },
    published,
  );
  strapi.seedDocument("api::quick-link.quick-link", { title: "All", departments: [] }, published);
  strapi.seedDocument(
    "api::quick-link.quick-link",
    { title: "Ops", departments: [{ id: 11 }] },
    published,
  );
  strapi.seedDocument(
    "api::poll.poll",
    { question: "All", audience: "all", departments: [] },
    published,
  );
  strapi.seedDocument(
    "api::poll.poll",
    { question: "Ops", audience: "departments", departments: [{ id: 11 }] },
    published,
  );
  strapi.seedDocument(
    "api::poll.poll",
    { question: "Guests", audience: "all", departments: [], visibleToGuests: true },
    published,
  );
  const course = strapi.seedDocument("api::course.course", { title: "Course" }, published);
  strapi.seedDocument(
    "api::lesson.lesson",
    { title: "Lesson", course: { id: course.published?.id ?? 0 } },
    published,
  );
  const draftCourse = strapi.seedDocument("api::course.course", { title: "Draft course" });
  strapi.seedDocument("api::lesson.lesson", {
    title: "Orphan",
    course: { id: draftCourse.draft?.id ?? 0 },
  });

  return {
    strapi,
    ids: {
      department: DEPT_ENG,
      team: TEAM_FE,
      pageOwn: pageOwn.documentId,
      pageForeign: pageForeign.documentId,
      spacePublic: spacePublic.documentId,
      spaceOps: spaceOps.documentId,
    },
  };
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

type Kind = "read-filter" | "status-pin" | "ownership" | "role-gate" | "write-allowlist";

interface ContractCase {
  /** The route config the case stands for (routes.matrix.test.ts pins the routes). */
  config?: Record<string, unknown>;
  /** Role types that pass untouched, without reading any data. */
  bypass: readonly RoleType[];
  /** A non-bypass caller gets an injected `filters` clause. */
  injectsFilter: boolean;
  /** A non-bypass caller gets status=published (draft & publish type). */
  pinsStatus: boolean;
}

interface PolicyContract {
  kind: Kind;
  /** What a request without a signed-in user gets. */
  anonymous: "deny" | "filter";
  cases: readonly ContractCase[];
  /** A request the member (105) may make: params and body for the positive branch. */
  ownRequest?: (ids: Record<string, string>) => {
    params?: Record<string, unknown>;
    body?: unknown;
  };
}

const ADMIN_EDITOR = ["admin_role", "editor"] as const;
const ADMIN_ONLY = ["admin_role"] as const;

const read = (
  bypass: readonly RoleType[],
  pinsStatus: boolean,
  config?: Record<string, unknown>,
): ContractCase => ({
  config,
  bypass,
  injectsFilter: true,
  pinsStatus,
});

const CONTRACTS: Record<string, PolicyContract> = {
  // Personal data: admin_role only (the /manage report), never editor.
  "acknowledgement-visibility": {
    kind: "read-filter",
    anonymous: "deny",
    cases: [read(ADMIN_ONLY, false)],
  },
  "lesson-progress-visibility": {
    kind: "read-filter",
    anonymous: "deny",
    cases: [read(ADMIN_ONLY, false)],
  },
  "notification-visibility": {
    kind: "read-filter",
    anonymous: "deny",
    cases: [read(ADMIN_ONLY, false)],
  },
  // FX21: raw RSVP rows are the caller's own (the summary route aggregates
  // everyone else's). A client user filter is refused with 400; its own
  // suite pins that, the sweep's client filter does not name the user.
  "event-rsvp-own-rows": {
    kind: "read-filter",
    anonymous: "deny",
    cases: [read(ADMIN_ONLY, false)],
  },
  // Content visibility: admin_role and editor author and moderate.
  "announcement-visibility": {
    kind: "read-filter",
    anonymous: "filter",
    cases: [read(ADMIN_EDITOR, true)],
  },
  "document-visibility": {
    kind: "read-filter",
    anonymous: "filter",
    cases: [read(ADMIN_EDITOR, true)],
  },
  "quick-link-visibility": {
    kind: "read-filter",
    anonymous: "filter",
    cases: [read(ADMIN_EDITOR, true)],
  },
  // comment/reaction have no draft & publish: no status pin.
  "comment-target-visibility": {
    kind: "read-filter",
    anonymous: "filter",
    cases: [read(ADMIN_EDITOR, false)],
  },
  // Decision 02: admin_role/editor read every poll (authoring); nobody reads anonymously.
  "poll-visibility": { kind: "read-filter", anonymous: "deny", cases: [read(ADMIN_EDITOR, true)] },
  "wiki-visibility": {
    kind: "read-filter",
    anonymous: "filter",
    cases: [
      read(ADMIN_EDITOR, true),
      read(ADMIN_EDITOR, true, { level: "space" }),
      read(ADMIN_EDITOR, true, { level: "page" }),
      read(ADMIN_EDITOR, true, { level: "revision" }),
    ],
  },
  "training-visibility": {
    kind: "read-filter",
    anonymous: "filter",
    cases: [
      { bypass: ADMIN_EDITOR, injectsFilter: false, pinsStatus: true },
      { config: { level: "course" }, bypass: ADMIN_EDITOR, injectsFilter: false, pinsStatus: true },
      read(ADMIN_EDITOR, true, { level: "lesson" }),
    ],
  },
  "published-only": {
    kind: "status-pin",
    anonymous: "filter",
    cases: [{ bypass: ADMIN_EDITOR, injectsFilter: false, pinsStatus: true }],
  },
  "is-admin-or-editor": {
    kind: "role-gate",
    anonymous: "deny",
    cases: [{ bypass: ADMIN_EDITOR, injectsFilter: false, pinsStatus: false }],
  },
  "is-classified-author": {
    kind: "ownership",
    anonymous: "deny",
    cases: [
      { bypass: ADMIN_EDITOR, injectsFilter: false, pinsStatus: false },
      // update: editing an ad is an owner/admin matter.
      {
        config: { bypassRoles: ["admin_role"] },
        bypass: ADMIN_ONLY,
        injectsFilter: false,
        pinsStatus: false,
      },
      // delete: editors keep the takedown.
      {
        config: { bypassRoles: ["admin_role", "editor"] },
        bypass: ADMIN_EDITOR,
        injectsFilter: false,
        pinsStatus: false,
      },
    ],
    ownRequest: () => ({ params: { id: "1" } }),
  },
  // An RSVP and a notification are personal: admin_role only.
  "is-event-rsvp-owner": {
    kind: "ownership",
    anonymous: "deny",
    cases: [{ bypass: ADMIN_ONLY, injectsFilter: false, pinsStatus: false }],
    ownRequest: () => ({ params: { id: "1" } }),
  },
  "is-notification-recipient": {
    kind: "ownership",
    anonymous: "deny",
    cases: [{ bypass: ADMIN_ONLY, injectsFilter: false, pinsStatus: false }],
    ownRequest: () => ({ params: { id: "1" } }),
  },
  // Reactions: moderation, like comment delete.
  "is-reaction-author": {
    kind: "ownership",
    anonymous: "deny",
    cases: [{ bypass: ADMIN_EDITOR, injectsFilter: false, pinsStatus: false }],
    ownRequest: () => ({ params: { id: "1" } }),
  },
  // FX07 write gates: admin_role/editor skip the allowlist.
  "can-edit-department": {
    kind: "write-allowlist",
    anonymous: "deny",
    cases: [{ bypass: ADMIN_EDITOR, injectsFilter: false, pinsStatus: false }],
    ownRequest: (ids) => ({ params: { id: ids.department }, body: { data: { description: "x" } } }),
  },
  "can-edit-team": {
    kind: "write-allowlist",
    anonymous: "deny",
    cases: [{ bypass: ADMIN_EDITOR, injectsFilter: false, pinsStatus: false }],
    ownRequest: (ids) => ({ params: { id: ids.team }, body: { data: { description: "x" } } }),
  },
  "can-edit-wiki": {
    kind: "write-allowlist",
    anonymous: "deny",
    cases: [{ bypass: ADMIN_EDITOR, injectsFilter: false, pinsStatus: false }],
    ownRequest: (ids) => ({ params: { id: ids.pageOwn }, body: { data: { title: "Renamed" } } }),
  },
};

/**
 * KNOWN: the ownership policies compare `row.<owner>?.id === user.id`
 * without checking that the caller has a numeric id, so a caller without an
 * id would "own" a row whose owner is gone (a deleted user leaves the
 * relation null). Unreachable today: users-permissions always puts a
 * database user with an id on ctx.state.user. Listed as `it.fails`, so the
 * fix (PL02 policy factories) must remove the entry; the FX07 write gates
 * already refuse such a caller.
 */
const KNOWN_IDLESS_OWNERS = new Set([
  "is-classified-author",
  "is-event-rsvp-owner",
  "is-notification-recipient",
  "is-reaction-author",
]);

/** The member who owns the positive branch; for department/team writes the head/lead. */
const OWN_CALLER: Partial<Record<string, RoleType>> = {
  "can-edit-department": "department_head",
  "can-edit-team": "team_lead",
};

// ---------------------------------------------------------------------------
// Loading every policy module
// ---------------------------------------------------------------------------

const POLICY_NAMES = readdirSync(__dirname)
  .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
  .map((file) => file.replace(/\.ts$/, ""))
  .sort();

const policies = new Map<string, PolicyFn>();

// Loads every policy module in parallel. The budget is 30 s, not the 10 s
// hook default: under a full parallel run the cold transform of the policies
// and their imports (@strapi/utils and friends) has taken longer than 10 s.
beforeAll(async () => {
  const loaded = await Promise.all(
    POLICY_NAMES.map(async (name) => {
      const module: unknown = await import(join(__dirname, `${name}.ts`));
      return [name, (module as { default?: unknown }).default] as const;
    }),
  );
  for (const [name, handler] of loaded) {
    if (typeof handler !== "function")
      throw new Error(`${name}: the default export is not a policy function`);
    policies.set(name, handler as PolicyFn);
  }
}, 30_000);

const policyOf = (name: string): PolicyFn => {
  const policy = policies.get(name);
  if (!policy) throw new Error(`${name} not loaded`);
  return policy;
};

type Outcome = { result: unknown } | { error: unknown };

async function run(
  name: string,
  config: unknown,
  ctx: StubPolicyContext,
  strapi: StrapiStub = fixture().strapi,
): Promise<Outcome> {
  try {
    return { result: await policyOf(name)(ctx, config, { strapi }) };
  } catch (error) {
    return { error };
  }
}

const describeOutcome = (outcome: Outcome) =>
  "result" in outcome ? `returned ${String(outcome.result)}` : `threw ${String(outcome.error)}`;

// ---------------------------------------------------------------------------
// Callers and requests for the sweep
// ---------------------------------------------------------------------------

interface Caller {
  label: string;
  user: StubUser | null | undefined;
}

const ANONYMOUS: Caller[] = [
  { label: "no state", user: undefined },
  { label: "state without a user", user: null },
];

const ROLELESS: Caller[] = [
  { label: "user without a role", user: { id: OWNER } },
  { label: "user with role null", user: { id: OWNER, role: null } },
  { label: "user with a role without a type", user: { id: OWNER, role: { id: 5 } } },
];

const IDLESS: Caller[] = ROLE_TYPES.map((type) => ({
  label: `${type} without an id`,
  user: { role: roleOf(type) },
}));

const ROLE_CALLERS: Caller[] = [
  ...ROLE_TYPES.map((type) => ({ label: type, user: { id: USER_ID[type], role: roleOf(type) } })),
  { label: "stranger member", user: { id: STRANGER, role: roleOf("member") } },
  ...LOOKALIKE_ROLES.map((type) => ({
    label: `lookalike "${type}"`,
    user: { id: OWNER, role: { id: 99, type } },
  })),
];

const ALL_CALLERS = [...ANONYMOUS, ...ROLELESS, ...IDLESS, ...ROLE_CALLERS];

function targetParams(ids: Record<string, string>): Array<Record<string, unknown> | undefined> {
  return [
    undefined,
    {},
    { id: "" },
    { id: "abc" },
    { id: "0" },
    { id: "2147483648" },
    { id: "constructor" },
    { id: "1" },
    { id: "2" },
    { id: "3" },
    { id: "99" },
    { id: 1 },
    ...Object.values(ids).map((id) => ({ id })),
  ];
}

function writeBodies(ids: Record<string, string>): unknown[] {
  return [
    undefined,
    {},
    { data: null },
    { data: { description: "x" } },
    { data: { title: "T" } },
    { data: { title: "T", space: ids.spacePublic } },
    { data: { name: "Hijack", members: [STRANGER] } },
  ];
}

const CLIENT_QUERY = {
  filters: { title: { $eq: "client" } },
  status: "draft",
  publicationFilter: "never-published",
  hasPublishedVersion: "false",
};

// ---------------------------------------------------------------------------
// The suites
// ---------------------------------------------------------------------------

describe("policy contract: the table covers src/policies exactly", () => {
  it("has one entry per policy module, and no entry without one", () => {
    expect(POLICY_NAMES.length).toBeGreaterThan(0);
    expect(Object.keys(CONTRACTS).sort()).toEqual(POLICY_NAMES);
  });
});

describe.each(Object.keys(CONTRACTS).sort())("policy contract: %s", (name) => {
  const contract = CONTRACTS[name];

  it("returns strict booleans on every branch (or the allowlist's 400)", async () => {
    // Policies only read data, so one fixture serves the whole sweep.
    const { strapi, ids } = fixture();
    const targeted = contract.kind === "ownership" || contract.kind === "write-allowlist";
    const params = targeted ? targetParams(ids) : [undefined, { id: "1" }];
    const bodies = contract.kind === "write-allowlist" ? writeBodies(ids) : [undefined];
    const failures: string[] = [];
    for (const { config } of contract.cases) {
      for (const caller of ALL_CALLERS) {
        for (const param of params) {
          for (const body of bodies) {
            const ctx = policyContext(caller.user, { query: CLIENT_QUERY, params: param, body });
            const outcome = await run(name, config, ctx, strapi);
            const ok =
              "result" in outcome
                ? typeof outcome.result === "boolean"
                : contract.kind === "write-allowlist" &&
                  outcome.error instanceof errors.ValidationError;
            if (!ok) {
              failures.push(
                `${caller.label} params=${JSON.stringify(param)} body=${JSON.stringify(body)} ` +
                  `config=${JSON.stringify(config)}: ${describeOutcome(outcome)}`,
              );
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  if (contract.anonymous === "deny") {
    it("refuses a request without a signed-in user", async () => {
      const { strapi, ids } = fixture();
      const own = contract.ownRequest?.(ids) ?? {};
      for (const { config } of contract.cases) {
        for (const caller of ANONYMOUS) {
          const ctx = policyContext(caller.user, { query: CLIENT_QUERY, ...own });
          expect(await run(name, config, ctx, strapi), caller.label).toEqual({ result: false });
          expect(ctx.request.query, caller.label).toEqual(CLIENT_QUERY);
        }
      }
    });
  }

  if (contract.kind === "role-gate" || contract.kind === "write-allowlist") {
    it("refuses a caller without a role type", async () => {
      const { strapi, ids } = fixture();
      const own = contract.ownRequest?.(ids) ?? {};
      for (const { config } of contract.cases) {
        for (const caller of ROLELESS) {
          const ctx = policyContext(caller.user, { query: CLIENT_QUERY, ...own });
          expect(await run(name, config, ctx, strapi), caller.label).toEqual({ result: false });
        }
      }
    });
  }

  if (contract.kind === "ownership" || contract.kind === "write-allowlist") {
    // Without a numeric id the caller owns nothing, not even a row whose
    // owner is gone. users-permissions always sets a database user, so this
    // is defence in depth.
    (KNOWN_IDLESS_OWNERS.has(name) ? it.fails : it)(
      "never lets a caller without an id own a row",
      async () => {
        const { strapi, ids } = fixture();
        const own = contract.ownRequest?.(ids) ?? {};
        const passed: string[] = [];
        for (const { config, bypass } of contract.cases) {
          for (const caller of IDLESS) {
            if (bypass.includes(caller.user?.role?.type as RoleType)) continue;
            for (const param of targetParams(ids)) {
              const ctx = policyContext(caller.user, {
                query: CLIENT_QUERY,
                params: param,
                body: own.body,
              });
              const outcome = await run(name, config, ctx, strapi);
              if ("result" in outcome && outcome.result === true) {
                passed.push(
                  `${caller.label} params=${JSON.stringify(param)} config=${JSON.stringify(config)}`,
                );
              }
            }
          }
        }
        expect(passed).toEqual([]);
      },
    );
  }

  it.each(contract.cases.map((c) => [JSON.stringify(c.config ?? null), c] as const))(
    "bypasses exactly its table roles, untouched and without reading data (config %s)",
    async (_config, contractCase) => {
      const { ids } = fixture();
      const bypassed: string[] = [];
      for (const caller of ROLE_CALLERS) {
        const { strapi } = fixture();
        const body = { data: { name: "Hijack", description: "x" } };
        // A target the caller does not own, so only a bypass can pass untouched.
        const params = { id: contract.kind === "write-allowlist" ? ids.pageForeign : "2" };
        const ctx = policyContext(caller.user, { query: CLIENT_QUERY, params, body });
        const outcome = await run(name, contractCase.config, ctx, strapi);
        const untouched =
          JSON.stringify(ctx.request.query) === JSON.stringify(CLIENT_QUERY) &&
          JSON.stringify(ctx.request.body) === JSON.stringify(body);
        if (
          "result" in outcome &&
          outcome.result === true &&
          untouched &&
          strapi.calls.length === 0
        ) {
          bypassed.push(String(caller.user?.role?.type));
        }
      }
      expect(bypassed.sort()).toEqual([...contractCase.bypass].sort());
    },
  );

  if (contract.kind === "read-filter" || contract.kind === "status-pin") {
    it.each(contract.cases.map((c) => [JSON.stringify(c.config ?? null), c] as const))(
      "writes onto the real request query, $and-narrowing the client filter (config %s)",
      async (_config, contractCase) => {
        const callers: Caller[] = [
          { label: "member", user: { id: OWNER, role: roleOf("member") } },
        ];
        if (contract.anonymous === "filter") callers.push({ label: "anonymous", user: undefined });
        for (const caller of callers) {
          const decoy = { filters: "DECOY", status: "DECOY" };
          const ctx = policyContext(caller.user, { query: CLIENT_QUERY, decoy });
          const outcome = await run(name, contractCase.config, ctx);
          expect(outcome, caller.label).toEqual({ result: true });
          // The own `query` copy is never the target (§5.14).
          expect(ctx.query, caller.label).toBe(decoy);
          expect(decoy, caller.label).toEqual({ filters: "DECOY", status: "DECOY" });

          const query = ctx.request.query;
          if (contractCase.injectsFilter) {
            const filters = query.filters as { $and?: unknown[] };
            expect(filters.$and?.[0], caller.label).toEqual(CLIENT_QUERY.filters);
            expect(filters.$and, caller.label).toHaveLength(2);
          } else {
            expect(query.filters, caller.label).toEqual(CLIENT_QUERY.filters);
          }
          if (contractCase.pinsStatus) {
            expect(query.status, caller.label).toBe("published");
            expect(query, caller.label).not.toHaveProperty("publicationFilter");
            expect(query, caller.label).not.toHaveProperty("hasPublishedVersion");
          } else {
            expect(query.status, caller.label).toBe("draft");
          }

          // Without a client filter the clause stands alone (never an empty $and).
          if (contractCase.injectsFilter) {
            const bare = policyContext(caller.user, {});
            expect(await run(name, contractCase.config, bare), caller.label).toEqual({
              result: true,
            });
            expect(bare.request.query.filters, caller.label).toBeDefined();
            expect(bare.request.query.filters, caller.label).not.toHaveProperty("$and");
          }
        }
      },
    );
  }

  if (contract.ownRequest) {
    it("passes its owner (the positive branch is reachable)", async () => {
      const { ids } = fixture();
      const type = OWN_CALLER[name] ?? "member";
      const own = contract.ownRequest?.(ids) ?? {};
      for (const { config, bypass } of contract.cases) {
        if (bypass.includes(type)) continue;
        const decoy = { filters: "DECOY" };
        const ctx = policyContext(
          { id: USER_ID[type], role: roleOf(type) },
          { ...own, query: CLIENT_QUERY, decoy },
        );
        const body = ctx.request.body as { data?: unknown } | undefined;
        const sent = body?.data;
        expect(await run(name, config, ctx)).toEqual({ result: true });
        expect(ctx.query).toBe(decoy);
        if (contract.kind === "write-allowlist") {
          // The allowlist pins the write to published on the REAL query and
          // replaces the payload with the checked copy.
          expect(ctx.request.query.status).toBe("published");
          expect(body?.data).not.toBe(sent);
          expect(body?.data).toEqual(sent);
        } else {
          expect(ctx.request.query).toEqual(CLIENT_QUERY);
        }
      }
    });
  }
});
