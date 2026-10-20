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
 *      target ids. The only other outcomes are a 400 (a ValidationError):
 *      the write allowlist's and the org query closure's, and
 *      event-rsvp-own-rows' refusal of a client filter on the user
 *      relation (pinned in its own suite; the sweep below sends none); and
 *      the thrown ForbiddenError("Forbidden") of a gate whose refusal must
 *      stay byte-identical to a controller's former ctx.forbidden()
 *      (`refusal: "forbidden"`, is-comment-author, PL03), in place of
 *      `false` wherever a refusal is expected.
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
 *   5. The v2 write gate (global::can-author, batch 15, decision 06 §B2):
 *      kinds `moderator-write-gate` (quick-link, poll: admin_role/editor
 *      enforced, everyone else false, no bypass) and
 *      `department-author-write-gate` (announcement, event, document: also
 *      a department_head with a department, on rows their department owns
 *      and targets). A route config without its uid gets no class. On a
 *      custom document action (publish, unpublish, discardDraft, editable)
 *      a refusal is a thrown NotFoundError (404, like a hidden findOne),
 *      on the generic create/update and the list a plain false.
 *   6. The wiki-page row gate (global::can-edit-wiki rebuilt in batch 16,
 *      kind `row-write-gate`): no bypass; moderators enforced on every
 *      page, the page's author, the head of its department and the lead of
 *      its team on their pages (in a space they read), everyone else false;
 *      a route config without the wiki-page uid gives no class; a custom
 *      page action refuses with a 404.
 *   7. Single-row org gates enforce every admitted role, with admin_role
 *      only moderating; editable refuses missing access with 404, updates
 *      with false. Every query key, including status, is refused.
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
      "api::comment.comment": [
        { id: 1, documentId: "cmown0000000000000000000", author: { id: OWNER } },
        { id: 2, documentId: "cmfor0000000000000000000", author: { id: STRANGER } },
        { id: 3, documentId: "cmnoauthor00000000000000", author: null },
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

type Kind =
  | "read-filter"
  | "status-pin"
  | "ownership"
  | "role-gate"
  | "org-write-gate"
  | "moderator-write-gate"
  | "department-author-write-gate"
  | "row-write-gate";

/** Kinds whose payload refusal is the allowlist's 400 (a ValidationError). */
const WRITE_GATE_KINDS: readonly Kind[] = [
  "org-write-gate",
  "moderator-write-gate",
  "department-author-write-gate",
  "row-write-gate",
];
const isWriteGate = (kind: Kind) => WRITE_GATE_KINDS.includes(kind);

interface ContractCase {
  /** The route config the case stands for (routes.matrix.test.ts pins the routes). */
  config?: Record<string, unknown>;
  /** Role types that pass untouched, without reading any data. */
  bypass: readonly RoleType[];
  /** A non-bypass caller gets an injected `filters` clause. */
  injectsFilter: boolean;
  /** A non-bypass caller gets status=published (draft & publish type). */
  pinsStatus: boolean;
  /** How this case refuses, when it differs from the contract's (can-author's custom actions: 404). */
  refusal?: "false" | "forbidden" | "notFound";
  /** false: a route the owner's role does not hold (a moderators-only list); the positive branch skips it. */
  owner?: boolean;
}

interface PolicyContract {
  kind: Kind;
  /** What a request without a signed-in user gets. */
  anonymous: "deny" | "filter";
  /**
   * How a refusal looks: `false` (the default; Strapi answers PolicyError),
   * a thrown ForbiddenError("Forbidden"), the body of ctx.forbidden(), or
   * a thrown NotFoundError (a case's own refusal, can-author's custom
   * document actions).
   */
  refusal?: "false" | "forbidden" | "notFound";
  cases: readonly ContractCase[];
  /** A request the member (105) may make: params and body for the positive branch. */
  ownRequest?: (ids: Record<string, string>) => {
    params?: Record<string, unknown>;
    body?: unknown;
  };
}

const ADMIN_EDITOR = ["admin_role", "editor"] as const;

/** The five types global::can-author guards (utils/authoring-uids.ts AUTHORED_UIDS). */
const CAN_AUTHOR_UIDS = [
  "api::announcement.announcement",
  "api::event.event",
  "api::quick-link.quick-link",
  "api::document.document",
  "api::poll.poll",
] as const;
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
      // Course audience (v0.20): the course level filters by department too.
      read(ADMIN_EDITOR, true),
      read(ADMIN_EDITOR, true, { level: "course" }),
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
  // Comments (PL03): moderation like reactions; refusals keep the comment
  // controller's former 403 body, and an id naming no comment passes on to
  // its 404 (pinned in is-comment-author.test.ts and over HTTP in
  // comment-delete.integration.test.ts).
  "is-comment-author": {
    kind: "ownership",
    anonymous: "deny",
    refusal: "forbidden",
    cases: [{ bypass: ADMIN_EDITOR, injectsFilter: false, pinsStatus: false }],
    ownRequest: () => ({ params: { id: "1" } }),
  },
  // Reactions: moderation, like comment delete.
  "is-reaction-author": {
    kind: "ownership",
    anonymous: "deny",
    cases: [{ bypass: ADMIN_EDITOR, injectsFilter: false, pinsStatus: false }],
    ownRequest: () => ({ params: { id: "1" } }),
  },
  // Single-row org gates: every admitted class is enforced; admin_role only moderates.
  "can-edit-department": {
    kind: "org-write-gate",
    anonymous: "deny",
    cases: [
      { bypass: [], injectsFilter: false, pinsStatus: false },
      {
        config: { intent: "editable" },
        bypass: [],
        injectsFilter: false,
        pinsStatus: false,
        refusal: "notFound",
      },
    ],
    ownRequest: (ids) => ({ params: { id: ids.department }, body: { data: { description: "x" } } }),
  },
  "can-edit-team": {
    kind: "org-write-gate",
    anonymous: "deny",
    cases: [
      { bypass: [], injectsFilter: false, pinsStatus: false },
      {
        config: { intent: "editable" },
        bypass: [],
        injectsFilter: false,
        pinsStatus: false,
        refusal: "notFound",
      },
    ],
    ownRequest: (ids) => ({ params: { id: ids.team }, body: { data: { description: "x" } } }),
  },
  // The wiki-page row gate (batch 16): no bypass. The moderator class is
  // role-only, so the moderators' list passes them without a read.
  "can-edit-wiki": {
    kind: "row-write-gate",
    anonymous: "deny",
    cases: [
      { config: { uid: WIKI_PAGE }, bypass: [], injectsFilter: false, pinsStatus: false },
      {
        config: { uid: WIKI_PAGE, intent: "authoringList" },
        bypass: ADMIN_EDITOR,
        injectsFilter: false,
        pinsStatus: false,
        owner: false,
      },
      ...(["editable", "publish", "revisions"] as const).map((intent) => ({
        config: { uid: WIKI_PAGE, intent },
        bypass: [] as RoleType[],
        injectsFilter: false,
        pinsStatus: false,
        refusal: "notFound" as const,
      })),
    ],
    ownRequest: (ids) => ({ params: { id: ids.pageOwn }, body: { data: { title: "Renamed" } } }),
  },
  // v2 write gate (batch 15): no bypass. The moderator class is role-only,
  // so the list (no row, no payload) passes moderators without a read;
  // everything else reads rows or checks a payload. The positive branches
  // are pinned per kind below and in can-author.test.ts.
  "can-author": {
    kind: "department-author-write-gate",
    anonymous: "deny",
    cases: CAN_AUTHOR_UIDS.flatMap((uid) => [
      { config: { uid }, bypass: [], injectsFilter: false, pinsStatus: false },
      {
        config: { uid, intent: "authoringList" },
        bypass: ADMIN_EDITOR,
        injectsFilter: false,
        pinsStatus: false,
      },
      ...(uid === "api::poll.poll" ? [] : (["publish", "editable"] as const)).map((intent) => ({
        config: { uid, intent },
        bypass: [] as RoleType[],
        injectsFilter: false,
        pinsStatus: false,
        refusal: "notFound" as const,
      })),
    ]),
  },
};

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

/** A NotFoundError, thrown by can-author on a custom document action. */
const isNotFoundThrow = (outcome: Outcome): boolean =>
  "error" in outcome && outcome.error instanceof errors.NotFoundError;

/** ctx.forbidden()'s error, thrown by a `refusal: "forbidden"` gate (never a PolicyError). */
const isForbiddenThrow = (outcome: Outcome): boolean =>
  "error" in outcome &&
  outcome.error instanceof errors.ForbiddenError &&
  !(outcome.error instanceof errors.PolicyError) &&
  outcome.error.message === "Forbidden";

/** The refusal of a case: `false`, or the throw its contract (or the case) names. */
const isRefusal = (
  contract: PolicyContract,
  outcome: Outcome,
  contractCase?: ContractCase,
): boolean => {
  const refusal = contractCase?.refusal ?? contract.refusal ?? "false";
  if (refusal === "forbidden") return isForbiddenThrow(outcome);
  if (refusal === "notFound") return isNotFoundThrow(outcome);
  return "result" in outcome && outcome.result === false;
};

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
    const targeted = contract.kind === "ownership" || isWriteGate(contract.kind);
    const params = targeted ? targetParams(ids) : [undefined, { id: "1" }];
    const bodies = isWriteGate(contract.kind) ? writeBodies(ids) : [undefined];
    const failures: string[] = [];
    for (const contractCase of contract.cases) {
      const { config } = contractCase;
      const refusal = contractCase.refusal ?? contract.refusal ?? "false";
      for (const caller of ALL_CALLERS) {
        for (const param of params) {
          for (const body of bodies) {
            const ctx = policyContext(caller.user, { query: CLIENT_QUERY, params: param, body });
            const outcome = await run(name, config, ctx, strapi);
            const ok =
              "result" in outcome
                ? typeof outcome.result === "boolean" &&
                  // A gate that refuses by throwing never answers a plain false.
                  (outcome.result || refusal === "false")
                : (isWriteGate(contract.kind) && outcome.error instanceof errors.ValidationError) ||
                  (refusal === "forbidden" && isForbiddenThrow(outcome)) ||
                  (refusal === "notFound" && isNotFoundThrow(outcome));
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
      for (const contractCase of contract.cases) {
        const { config } = contractCase;
        for (const caller of ANONYMOUS) {
          const ctx = policyContext(caller.user, { query: CLIENT_QUERY, ...own });
          const outcome = await run(name, config, ctx, strapi);
          expect(
            isRefusal(contract, outcome, contractCase),
            `${caller.label}: ${describeOutcome(outcome)}`,
          ).toBe(true);
          expect(ctx.request.query, caller.label).toEqual(CLIENT_QUERY);
        }
      }
    });
  }

  if (contract.kind === "role-gate" || isWriteGate(contract.kind)) {
    it("refuses a caller without a role type", async () => {
      const { strapi, ids } = fixture();
      const own = contract.ownRequest?.(ids) ?? {};
      for (const contractCase of contract.cases) {
        for (const caller of ROLELESS) {
          const ctx = policyContext(caller.user, { query: CLIENT_QUERY, ...own });
          const outcome = await run(name, contractCase.config, ctx, strapi);
          expect(isRefusal(contract, outcome, contractCase), caller.label).toBe(true);
        }
      }
    });
  }

  if (contract.kind === "ownership" || isWriteGate(contract.kind)) {
    // Without a numeric id the caller owns nothing, not even a row whose
    // owner is gone (a deleted user leaves the relation null). The ownership
    // gates got this with the PL02 factories (ownerGate); users-permissions
    // always sets a database user, so it is defence in depth.
    it("never lets a caller without an id own a row", async () => {
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
    });
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
        const params = { id: isWriteGate(contract.kind) ? ids.pageForeign : "2" };
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
      for (const { config, bypass, owner } of contract.cases) {
        if (bypass.includes(type) || owner === false) continue;
        const decoy = { filters: "DECOY" };
        const ctx = policyContext(
          { id: USER_ID[type], role: roleOf(type) },
          { ...own, query: contract.kind === "org-write-gate" ? {} : CLIENT_QUERY, decoy },
        );
        const body = ctx.request.body as { data?: unknown } | undefined;
        const sent = body?.data;
        expect(await run(name, config, ctx)).toEqual({ result: true });
        expect(ctx.query).toBe(decoy);
        const intent = (config as { intent?: unknown } | undefined)?.intent;
        if (contract.kind === "org-write-gate") {
          expect(ctx.request.query).toEqual({});
          if (intent !== "editable") {
            expect(body?.data).not.toBe(sent);
            expect(body?.data).toEqual(sent);
          }
        } else if (contract.kind === "row-write-gate" && intent === undefined) {
          // The same for a row class's generic update, with lastEditor the caller.
          expect(ctx.request.query.status).toBe("published");
          expect(body?.data).not.toBe(sent);
          expect(body?.data).toEqual({ ...(sent as object), lastEditor: USER_ID[type] });
        } else {
          expect(ctx.request.query).toEqual(CLIENT_QUERY);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// The v2 write-gate kinds (decision 06 §B2; batch 15 lane 15A)
// ---------------------------------------------------------------------------

describe("policy contract kind: moderator-write-gate (can-author on quick-link and poll)", () => {
  const bodies: Record<string, unknown> = {
    "api::quick-link.quick-link": { data: { label: "Payroll", url: "/payroll" } },
    "api::poll.poll": { data: { question: "Lunch?", options: ["A", "B"] } },
  };

  it.each(Object.keys(bodies))(
    "%s: moderators enforced, everyone else false, no bypass",
    async (uid) => {
      for (const type of ROLE_TYPES) {
        const { strapi } = fixture();
        const body = bodies[uid];
        const ctx = policyContext({ id: USER_ID[type], role: roleOf(type) }, { body });
        const outcome = await run("can-author", { uid }, ctx, strapi);
        const moderator = (ADMIN_EDITOR as readonly string[]).includes(type);
        expect(outcome, type).toEqual({ result: moderator });
        // Enforced: the payload is the allowlist's copy (the caller field added).
        const data = (ctx.request.body as { data: Record<string, unknown> }).data;
        if (moderator) expect(data).not.toBe((body as { data: unknown }).data);
      }
    },
  );

  it.each(Object.keys(bodies))("%s: a route config without its uid gives no class", async (uid) => {
    const { strapi } = fixture();
    for (const config of [
      undefined,
      {},
      { uid: "" },
      { uid: 42 },
      { uid: "api::wiki-page.wiki-page" },
    ]) {
      const ctx = policyContext(
        { id: USER_ID.editor, role: roleOf("editor") },
        { body: bodies[uid] },
      );
      expect(await run("can-author", config, ctx, strapi), JSON.stringify(config)).toEqual({
        result: false,
      });
    }
  });
});

describe("policy contract kind: department-author-write-gate (can-author on announcement, event, document)", () => {
  const A = "api::announcement.announcement";
  const head = { id: USER_ID.department_head, role: roleOf("department_head") };

  /** The fixture plus department-owned and moderator rows. */
  function owned() {
    const { strapi, ids } = fixture();
    const published = { status: "published" as const };
    const mine = strapi.seedDocument(
      A,
      {
        title: "Mine",
        department: { id: 10 },
        ownerDepartment: { id: 10 },
        audience: "departments",
      },
      published,
    );
    const theirs = strapi.seedDocument(
      A,
      {
        title: "Theirs",
        department: { id: 11 },
        ownerDepartment: { id: 11 },
        audience: "departments",
      },
      published,
    );
    const moderators = strapi.seedDocument(A, { title: "Mod", department: { id: 10 } }, published);
    const widened = strapi.seedDocument(
      A,
      { title: "Wide", department: null, ownerDepartment: { id: 10 }, audience: "all" },
      published,
    );
    return { strapi, ids, mine, theirs, moderators, widened };
  }

  it("moderators enforced on any row; a department head only with a department and on an owned, in-scope row", async () => {
    const world = owned();
    const update = (user: StubUser, documentId: string) =>
      run(
        "can-author",
        { uid: A },
        policyContext(user, { params: { id: documentId }, body: { data: { title: "x" } } }),
        world.strapi,
      );
    expect(await update(head, world.mine.documentId)).toEqual({ result: true });
    for (const documentId of [
      world.theirs.documentId,
      world.moderators.documentId,
      world.widened.documentId,
    ]) {
      expect(await update(head, documentId), documentId).toEqual({ result: false });
    }
    for (const type of ["admin_role", "editor"] as const) {
      for (const row of [world.mine, world.theirs, world.moderators]) {
        expect(
          await update({ id: USER_ID[type], role: roleOf(type) }, row.documentId),
          type,
        ).toEqual({
          result: true,
        });
      }
    }
    for (const type of ["team_lead", "member", "guest", "authenticated"] as const) {
      expect(
        await update({ id: USER_ID[type], role: roleOf(type) }, world.mine.documentId),
        type,
      ).toEqual({
        result: false,
      });
    }
    // A department_head without a department (the stranger's role swapped).
    const loner = { id: USER_ID.editor, role: roleOf("department_head") };
    expect(await update(loner, world.mine.documentId)).toEqual({ result: false });
  });

  it("a custom document action refuses with a 404, never a 403 or a 412", async () => {
    const world = owned();
    const outcome = await run(
      "can-author",
      { uid: A, intent: "editable" },
      policyContext(head, { params: { id: world.theirs.documentId } }),
      world.strapi,
    );
    expect("error" in outcome && outcome.error instanceof errors.NotFoundError).toBe(true);
    expect(
      await run(
        "can-author",
        { uid: A, intent: "editable" },
        policyContext(head, { params: { id: world.mine.documentId } }),
        world.strapi,
      ),
    ).toEqual({ result: true });
  });
});

describe("policy contract kind: row-write-gate (can-edit-wiki on wiki pages)", () => {
  const PAGE_CONFIG = { uid: WIKI_PAGE };
  const caller = (type: RoleType) => ({ id: USER_ID[type], role: roleOf(type) });

  it("moderators enforced on every page, the author on theirs, everyone else false", async () => {
    const { strapi, ids } = fixture();
    const update = (user: StubUser, id: string) =>
      run(
        "can-edit-wiki",
        PAGE_CONFIG,
        policyContext(user, { params: { id }, body: { data: { title: "x" } } }),
        strapi,
      );
    for (const type of ["admin_role", "editor"] as const) {
      for (const id of [ids.pageOwn, ids.pageForeign]) {
        expect(await update(caller(type), id), `${type} ${id}`).toEqual({ result: true });
      }
    }
    expect(await update(caller("member"), ids.pageOwn)).toEqual({ result: true });
    expect(await update(caller("member"), ids.pageForeign)).toEqual({ result: false });
    // The head of the own page's department (10) and the lead of its team (30).
    expect(await update(caller("department_head"), ids.pageOwn)).toEqual({ result: true });
    expect(await update(caller("team_lead"), ids.pageOwn)).toEqual({ result: true });
    for (const type of ["guest", "authenticated"] as const) {
      expect(await update(caller(type), ids.pageOwn), type).toEqual({ result: false });
    }
    const stranger = { id: STRANGER, role: roleOf("member") };
    expect(await update(stranger, ids.pageOwn)).toEqual({ result: false });
  });

  it("moderators' payloads are checked: no bypass", async () => {
    const { strapi, ids } = fixture();
    const outcome = await run(
      "can-edit-wiki",
      PAGE_CONFIG,
      policyContext(caller("editor"), {
        params: { id: ids.pageOwn },
        body: { data: { title: "x", author: STRANGER } },
      }),
      strapi,
    );
    expect("error" in outcome && outcome.error instanceof errors.ValidationError).toBe(true);
  });

  it("a route config without the wiki-page uid gives no class", async () => {
    const { strapi, ids } = fixture();
    for (const config of [undefined, {}, { uid: "" }, { uid: "api::wiki-space.wiki-space" }]) {
      const ctx = policyContext(caller("editor"), {
        params: { id: ids.pageOwn },
        body: { data: { title: "x" } },
      });
      expect(await run("can-edit-wiki", config, ctx, strapi), JSON.stringify(config)).toEqual({
        result: false,
      });
    }
  });

  it("a custom page action refuses with a 404, never a 403", async () => {
    const { strapi, ids } = fixture();
    const outcome = await run(
      "can-edit-wiki",
      { uid: WIKI_PAGE, intent: "editable" },
      policyContext(caller("member"), { params: { id: ids.pageForeign } }),
      strapi,
    );
    expect("error" in outcome && outcome.error instanceof errors.NotFoundError).toBe(true);
  });
});
