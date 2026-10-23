import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CUSTOM_ACTION_GRANTS,
  PERMISSION_MATRIX,
  REVOKED_PERMISSIONS,
  computeDesiredGrants,
} from "./bootstrap/permission-matrix";
import { ADMIN, MODERATORS } from "./bootstrap/roles";
import { knownActions, unknownActions } from "./bootstrap/sync-permissions";
import {
  cmsPackageDir,
  requirePackageFile,
  strapiPackageDir,
} from "./test/sqlite-engine.test.helper";
import {
  CLOSED_RELATION_TARGETS,
  RESTRICTED_RELATION_TARGETS,
  isRestrictedRelation,
} from "./utils/restricted-relations";
import {
  AUTHORED_UIDS,
  DEPARTMENT_AUTHORED_UIDS,
  departmentAuthorRolesOf,
} from "./utils/authoring-uids";
import {
  DEPARTMENT_AUTHOR_CLASS,
  MODERATOR_CLASS,
  WRITE_ALLOWLIST,
  writeClassesFor,
  type WriteAllowlist,
} from "./utils/write-allowlist";

/**
 * Route → policy golden matrix and grant cross-check (roadmap S01).
 *
 * Every content-API call passes two independent gates (docs/architecture.md
 * §5.8): the users-permissions GRANT (a permission row `<uid>.<action>`,
 * seeded from bootstrap/permission-matrix.ts) and the route's POLICIES
 * (`config.policies` in src/api/*\/routes/*.ts). The shipped authorization
 * defects sat in the seam between the two — router config that the pure
 * unit suite never sees:
 *   - an action left out of a `createCoreRouter` config still EXISTS and
 *     runs WITHOUT policies unless the router uses `only:` (the forged
 *     POST /api/poll-votes hole),
 *   - a custom handler without an exact CUSTOM_ACTION_GRANTS key 403s for
 *     everyone (§5.22), and
 *   - `ensurePermission` only ADDS rows, so a REVOKED_PERMISSIONS entry that
 *     overlaps a grant is re-added and deleted again on every boot.
 *
 * This file loads every router and controller module with
 * `factories.createCoreRouter` / `createCoreController` mocked to CAPTURE
 * their arguments, reads the content-type schemas, and asserts:
 *   (a) a golden action → policies table — any router change is a
 *       deliberate edit of GOLDEN below,
 *   (b) every GRANTED core action is policy-gated, controller-overridden or
 *       on the explicit ALLOWLIST (with a reason),
 *   (c) every custom handler resolves to a controller method and has a
 *       CUSTOM_ACTION_GRANTS key (and every api:: key has a route),
 *   (d) REVOKED_PERMISSIONS is disjoint from every grant,
 * plus two structural read-side invariants derived from the schemas: every
 * draft & publish type pins `status=published` on its reads (§5.24), and
 * every relation from outside a visibility-filtered type's policy domain
 * into that type is cut by the global relation guard (FX05); and one on the
 * write side: a role without the admin_role/editor bypass can write the
 * relations the guard trusts (and the department/team pages it cuts) only
 * through a route that enforces the field allowlist (FX07), and every
 * draft & publish write such a role holds goes through that allowlist,
 * which pins `status=published` like the reads.
 *
 * Known holes start as `it.fails` (the KNOWN_* sets). vitest reports an
 * `it.fails` that starts passing as a failure, so every fix has to flip its
 * entry — and update GOLDEN — in the same commit.
 */

type PolicySpec = string | { name: string; config?: Record<string, unknown> };

interface RouteConfig {
  policies?: PolicySpec[];
  middlewares?: unknown[];
  auth?: unknown;
}

interface CoreRouterOptions {
  only?: string[];
  except?: string[];
  config?: Record<string, RouteConfig | undefined>;
}

interface CustomRoute {
  method: string;
  path: string;
  handler: string;
  config?: RouteConfig;
}

type ControllerFactory = (deps: { strapi: unknown }) => Record<string, unknown>;

interface AttributeSchema {
  type: string;
  relation?: string;
  target?: string;
}

interface ContentTypeSchema {
  info?: { pluralName?: string };
  options?: { draftAndPublish?: boolean };
  attributes: Record<string, AttributeSchema>;
}

const captured = vi.hoisted(() => ({
  routers: [] as { uid: string; options: CoreRouterOptions }[],
  controllers: new Map<string, string[]>(),
}));

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreRouter: (uid: string, options: CoreRouterOptions = {}) => {
      captured.routers.push({ uid, options });
      return { capturedCoreRouter: uid };
    },
    // Own methods of the override object = the actions the controller
    // replaces (or adds). The factory only builds method closures, so a
    // bare stub is enough to call it.
    createCoreController: (uid: string, factory?: ControllerFactory) => {
      captured.controllers.set(uid, factory ? Object.keys(factory({ strapi: {} })) : []);
      return { capturedCoreController: uid };
    },
  },
}));

const API_DIR = join(__dirname, "api");
const CORE_ACTIONS = ["find", "findOne", "create", "update", "delete"];
const READ_ACTIONS = ["find", "findOne"];

/**
 * Users-permissions reads every role receives on top of PERMISSION_MATRIX
 * (USER_READ_ACTIONS in bootstrap/permission-matrix.ts; no role is excluded,
 * guest included — see the note on the guest matrix there).
 */
const USER_READ_GRANTS = [
  "plugin::users-permissions.user.find",
  "plugin::users-permissions.user.findOne",
  "plugin::users-permissions.user.me",
];

interface RouteEntry {
  /** Permission key: `<uid>.<action>` for core routes, the handler for custom ones. */
  action: string;
  kind: "core" | "custom";
  /** Router file relative to src/api — for failure messages. */
  source: string;
  config: RouteConfig;
  /** Custom routes only: the declared method and path. */
  method?: string;
  path?: string;
}

interface Loaded {
  routes: Map<string, RouteEntry>;
  /** Controller uid → own (overriding or custom) method names. */
  controllerMethods: Map<string, string[]>;
  schemas: Map<string, ContentTypeSchema>;
}

/**
 * An installed plugin's server controllers, instantiated like Strapi's
 * controller registry does (a factory is called with `{ strapi }`; the
 * factories only build closures). The dist index either exports them as
 * `controllers` (upload) or behind a lazy `__require` (users-permissions).
 */
function installedControllers(packageDir: string): Record<string, object> {
  const loaded = requirePackageFile<{
    controllers?: Record<string, unknown>;
    __require?: () => Record<string, unknown>;
  }>(packageDir, "dist/server/controllers/index.js");
  const controllers = loaded.controllers ?? loaded.__require?.() ?? {};
  return Object.fromEntries(
    Object.entries(controllers).map(([name, controller]) => [
      name,
      typeof controller === "function"
        ? (controller as (deps: { strapi: object }) => object)({ strapi: {} })
        : (controller as object),
    ]),
  );
}

const tsModules = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    : [];

/** Mirrors @strapi/core 5.49 createCoreRouter: omit(except) → pick(only). */
function selectedCoreActions({ only, except }: CoreRouterOptions): string[] {
  return CORE_ACTIONS.filter((a) => !except?.includes(a)).filter((a) => !only || only.includes(a));
}

async function load(): Promise<Loaded> {
  const routes = new Map<string, RouteEntry>();
  const add = (entry: RouteEntry) => {
    const previous = routes.get(entry.action);
    // Two routes on one action share ONE permission row — the one with the
    // weaker policy list would silently widen the other.
    if (previous) {
      throw new Error(`${entry.action} is served by ${previous.source} AND ${entry.source}`);
    }
    routes.set(entry.action, entry);
  };
  const controllerMethods = new Map<string, string[]>();
  const schemas = new Map<string, ContentTypeSchema>();

  for (const api of readdirSync(API_DIR)) {
    const controllersDir = join(API_DIR, api, "controllers");
    for (const file of tsModules(controllersDir)) {
      const uid = `api::${api}.${file.replace(/\.ts$/, "")}`;
      const mod = await import(join(controllersDir, file));
      // Factory controllers were captured by the mock; plain-object
      // controllers (routes-only APIs such as profile) are their methods.
      controllerMethods.set(uid, captured.controllers.get(uid) ?? Object.keys(mod.default));
    }

    const routesDir = join(API_DIR, api, "routes");
    for (const file of tsModules(routesDir)) {
      const source = `${api}/routes/${file}`;
      const before = captured.routers.length;
      const mod = await import(join(routesDir, file));
      if (captured.routers.length > before) {
        const { uid, options } = captured.routers[captured.routers.length - 1];
        for (const action of selectedCoreActions(options)) {
          add({
            action: `${uid}.${action}`,
            kind: "core",
            source,
            config: options.config?.[action] ?? {},
          });
        }
      } else {
        for (const route of (mod.default as { routes: CustomRoute[] }).routes) {
          add({
            action: route.handler,
            kind: "custom",
            source,
            config: route.config ?? {},
            method: route.method,
            path: route.path,
          });
        }
      }
    }

    const contentTypesDir = join(API_DIR, api, "content-types");
    if (existsSync(contentTypesDir)) {
      for (const name of readdirSync(contentTypesDir)) {
        const schemaFile = join(contentTypesDir, name, "schema.json");
        schemas.set(`api::${api}.${name}`, JSON.parse(readFileSync(schemaFile, "utf8")));
      }
    }
  }
  return { routes, controllerMethods, schemas };
}

const policyName = (p: PolicySpec) => (typeof p === "string" ? p : p.name);

/** Splits a permission key into controller uid + action name. */
function splitAction(action: string): [string, string] {
  const dot = action.lastIndexOf(".");
  return [action.slice(0, dot), action.slice(dot + 1)];
}

// ---------------------------------------------------------------------------
// (a) Golden table. `[]` = no policy (configured empty or left unconfigured —
// both run the handler without a policy). An action missing here has NO
// route (`only:`), which is the strongest gate there is.
// ---------------------------------------------------------------------------

const ADMIN_OR_EDITOR = ["global::is-admin-or-editor"];
/** The v2 write gate on a core create/update (batch 15): the route's uid. */
const canAuthor = (uid: string) => [{ name: "global::can-author", config: { uid } }];
/** The v2 write gate on a custom authoring action: the route's uid and intent. */
const canAuthorAction = (uid: string, intent: string) => [
  { name: "global::can-author", config: { uid, intent } },
];
const ANNOUNCEMENT = "api::announcement.announcement";
const EVENT = "api::event.event";
const QUICK_LINK = "api::quick-link.quick-link";
const DOCUMENT = "api::document.document";
const DUTY_PLAN = "api::duty-plan.duty-plan";
const KPI = "api::kpi.kpi";
const POLL = "api::poll.poll";
const WIKI_SPACE = "api::wiki-space.wiki-space";
const WIKI_PAGE = "api::wiki-page.wiki-page";
/** The custom routes of api/<type>/routes/00-authoring.ts, by intent. */
const authoringRoutes = (uid: string, intents: readonly string[]) =>
  Object.fromEntries(intents.map((intent) => [`${uid}.${intent}`, canAuthorAction(uid, intent)]));
const DP_INTENTS = ["publish", "unpublish", "discardDraft", "authoringList", "editable"] as const;
const POLL_INTENTS = ["authoringList", "editable"] as const;
/** A wiki space is always published, like a poll: the list and the form read. */
const WIKI_SPACE_INTENTS = POLL_INTENTS;
/** The rebuilt wiki-page row gate (batch 16): the route's uid and, on a custom action, its intent. */
const canEditWiki = (intent?: string) => [
  {
    name: "global::can-edit-wiki",
    config: intent ? { uid: WIKI_PAGE, intent } : { uid: WIKI_PAGE },
  },
];
/** The wiki-page actions of api/wiki-page/routes/00-authoring.ts (§J2), and who holds them. */
const WIKI_PAGE_ACTION_ROLES: Record<string, readonly string[]> = {
  createDraft: ["admin_role", "editor", "department_head", "team_lead"],
  myDrafts: ["admin_role", "editor", "department_head", "team_lead", "member"],
  editable: ["admin_role", "editor", "department_head", "team_lead", "member"],
  saveDraft: ["admin_role", "editor", "department_head", "team_lead", "member"],
  publish: ["admin_role", "editor", "department_head", "team_lead", "member"],
  discardDraft: ["admin_role", "editor", "department_head", "team_lead", "member"],
  revisions: ["admin_role", "editor", "department_head", "team_lead", "member"],
  revision: ["admin_role", "editor", "department_head", "team_lead", "member"],
  restore: ["admin_role", "editor", "department_head", "team_lead", "member"],
  unpublish: ["admin_role", "editor"],
  authoringList: ["admin_role", "editor"],
};
const wiki = (level: string) => [{ name: "global::wiki-visibility", config: { level } }];
const training = (level: string) => [{ name: "global::training-visibility", config: { level } }];

const GOLDEN: Record<string, PolicySpec[]> = {
  "api::acknowledgement.acknowledgement.find": ["global::acknowledgement-visibility"],
  "api::acknowledgement.acknowledgement.findOne": ["global::acknowledgement-visibility"],
  "api::acknowledgement.acknowledgement.create": [],
  "api::acknowledgement.acknowledgement.update": [],
  "api::acknowledgement.acknowledgement.delete": [],

  "api::announcement.announcement.find": ["global::announcement-visibility"],
  "api::announcement.announcement.findOne": ["global::announcement-visibility"],
  "api::announcement.announcement.create": canAuthor(ANNOUNCEMENT),
  "api::announcement.announcement.update": canAuthor(ANNOUNCEMENT),
  "api::announcement.announcement.delete": ADMIN_OR_EDITOR,
  ...authoringRoutes(ANNOUNCEMENT, DP_INTENTS),

  "api::classified.classified.find": [],
  "api::classified.classified.findOne": [],
  "api::classified.classified.create": [],
  "api::classified.classified.update": [
    { name: "global::is-classified-author", config: { bypassRoles: ["admin_role"] } },
  ],
  "api::classified.classified.delete": [
    { name: "global::is-classified-author", config: { bypassRoles: ["admin_role", "editor"] } },
  ],
  "api::classified.classified.cleanupUploads": [],

  "api::comment.comment.find": ["global::comment-target-visibility"],
  "api::comment.comment.findOne": ["global::comment-target-visibility"],
  "api::comment.comment.create": [],
  // PL03: author, or admin_role/editor; the controller keeps the id translation and the 404.
  "api::comment.comment.delete": ["global::is-comment-author"],

  "api::course.course.find": training("course"),
  "api::course.course.findOne": training("course"),
  "api::course.course.create": canAuthorAction("api::course.course", "create"),
  "api::course.course.update": canAuthorAction("api::course.course", "update"),
  ...authoringRoutes("api::course.course", DP_INTENTS),

  "api::department.department.find": ["global::published-only"],
  "api::department.department.findOne": ["global::published-only"],
  "api::department.department.create": [
    { name: "global::can-edit-department", config: { intent: "create" } },
  ],
  "api::department.department.update": ["global::can-edit-department"],
  "api::department.department.delete": [
    { name: "global::can-edit-department", config: { intent: "delete" } },
  ],
  "api::department.department.editable": [
    { name: "global::can-edit-department", config: { intent: "editable" } },
  ],

  // D-ENTRA-01: auth:false, authenticated in the controller (shared secret +
  // ID-token verification), 404 while ENTRA_ENABLED is not '1'.
  "api::entra-auth.entra-auth.exchange": [],
  // v0.25.0: the OIDC exchange, the same way (404 while OIDC_ENABLED is not '1').
  "api::oidc-auth.oidc-auth.exchange": [],
  // v0.27: set-password links, auth:false, only for the web server (the
  // shared secret INTERNAL_UPLOAD_TOKEN), 404 without it.
  "api::password-auth.password-auth.forgot": [],
  "api::password-auth.password-auth.set": [],

  "api::document.document.find": ["global::document-visibility"],
  "api::document.document.findOne": ["global::document-visibility"],
  "api::document.document.create": canAuthor(DOCUMENT),
  "api::document.document.update": canAuthor(DOCUMENT),
  "api::document.document.delete": ADMIN_OR_EDITOR,
  ...authoringRoutes(DOCUMENT, DP_INTENTS),

  "api::duty-plan.duty-plan.find": ["global::published-only"],
  "api::duty-plan.duty-plan.findOne": ["global::published-only"],
  "api::duty-plan.duty-plan.create": canAuthor(DUTY_PLAN),
  "api::duty-plan.duty-plan.update": canAuthor(DUTY_PLAN),
  "api::duty-plan.duty-plan.delete": ADMIN_OR_EDITOR,
  ...authoringRoutes(DUTY_PLAN, DP_INTENTS),

  "api::kpi.kpi.find": ["global::published-only"],
  "api::kpi.kpi.findOne": ["global::published-only"],
  "api::kpi.kpi.create": canAuthor(KPI),
  "api::kpi.kpi.update": canAuthor(KPI),
  "api::kpi.kpi.delete": ADMIN_OR_EDITOR,
  ...authoringRoutes(KPI, DP_INTENTS),

  "api::event.event.find": ["global::published-only"],
  "api::event.event.findOne": ["global::published-only"],
  "api::event.event.create": canAuthor(EVENT),
  "api::event.event.update": canAuthor(EVENT),
  "api::event.event.delete": ADMIN_OR_EDITOR,
  ...authoringRoutes(EVENT, DP_INTENTS),
  "api::event.event.ics": [],

  "api::event-rsvp.event-rsvp.find": ["global::event-rsvp-own-rows"],
  "api::event-rsvp.event-rsvp.findOne": ["global::event-rsvp-own-rows"],
  "api::event-rsvp.event-rsvp.create": [],
  "api::event-rsvp.event-rsvp.update": ["global::is-event-rsvp-owner"],
  "api::event-rsvp.event-rsvp.delete": [],
  "api::event-rsvp.event-rsvp.summary": [],

  "api::kudos.kudos.find": [],
  "api::kudos.kudos.findOne": [],
  "api::kudos.kudos.create": [],
  "api::kudos.kudos.delete": ADMIN_OR_EDITOR,
  "api::kudos.kudos.celebrations": [],

  "api::lesson.lesson.find": training("lesson"),
  "api::lesson.lesson.findOne": training("lesson"),
  "api::lesson.lesson.create": canAuthorAction("api::lesson.lesson", "create"),
  "api::lesson.lesson.update": canAuthorAction("api::lesson.lesson", "update"),
  ...authoringRoutes("api::lesson.lesson", DP_INTENTS),
  // Fixed learner actions enforce published targets inside the controller.
  "api::lesson.lesson.player": [],
  "api::lesson.lesson.check": [],
  // The named training report (v0.20): the controller checks role and department.
  "api::course.course.report": [],
  "api::course.course.reportCourse": [],

  "api::lesson-progress.lesson-progress.find": ["global::lesson-progress-visibility"],
  "api::lesson-progress.lesson-progress.findOne": ["global::lesson-progress-visibility"],
  "api::lesson-progress.lesson-progress.create": [],

  "api::notification.notification.find": ["global::notification-visibility"],
  "api::notification.notification.findOne": ["global::notification-visibility"],
  "api::notification.notification.delete": ["global::is-notification-recipient"],
  "api::notification.notification.markRead": [],
  "api::notification.notification.markAllRead": [],

  "api::poll.poll.find": ["global::poll-visibility"],
  "api::poll.poll.findOne": ["global::poll-visibility"],
  "api::poll.poll.create": canAuthor(POLL),
  "api::poll.poll.update": canAuthor(POLL),
  "api::poll.poll.delete": ADMIN_OR_EDITOR,
  ...authoringRoutes(POLL, POLL_INTENTS),
  // WD04: canSeePoll per poll in the controller, like the single results.
  "api::poll.poll.batchResults": [],

  "api::poll-vote.poll-vote.vote": [],
  "api::poll-vote.poll-vote.results": [],

  "api::audit-event.audit-event.list": [],
  // User administration (v0.23): admin_role grants, the controller checks again.
  "api::user-management.user-management.list": [],
  "api::user-management.user-management.findOne": [],
  "api::user-management.user-management.update": [],
  "api::user-management.user-management.roleToEntra": [],
  // v0.27: invitations, links, second-factor resets (admin_role, checked again).
  "api::user-management.user-management.invite": [],
  "api::user-management.user-management.sendLink": [],
  "api::user-management.user-management.resetMfa": [],
  // v0.28: training evidence, export, anonymisation (admin_role; the controller checks again).
  "api::user-management.user-management.trainingEvidence": [],
  "api::user-management.user-management.export": [],
  "api::user-management.user-management.anonymisePreview": [],
  "api::user-management.user-management.anonymise": [],
  "api::profile.profile.me": [],
  "api::profile.profile.updateMe": [],
  // v0.27: the caller's own second factor.
  "api::profile.profile.mfaSetup": [],
  "api::profile.profile.mfaActivate": [],
  "api::profile.profile.mfaDisable": [],

  "api::quick-link.quick-link.find": ["global::quick-link-visibility"],
  "api::quick-link.quick-link.findOne": ["global::quick-link-visibility"],
  "api::quick-link.quick-link.create": canAuthor(QUICK_LINK),
  "api::quick-link.quick-link.update": canAuthor(QUICK_LINK),
  "api::quick-link.quick-link.delete": ADMIN_OR_EDITOR,
  ...authoringRoutes(QUICK_LINK, DP_INTENTS),

  "api::reaction.reaction.find": ["global::comment-target-visibility"],
  "api::reaction.reaction.findOne": ["global::comment-target-visibility"],
  "api::reaction.reaction.create": [],
  "api::reaction.reaction.delete": ["global::is-reaction-author"],

  "api::search-log.search-log.create": [],
  "api::search-log.search-log.summary": ADMIN_OR_EDITOR,

  "api::team.team.find": ["global::published-only"],
  "api::team.team.findOne": ["global::published-only"],
  "api::team.team.create": [{ name: "global::can-edit-team", config: { intent: "create" } }],
  "api::team.team.update": ["global::can-edit-team"],
  "api::team.team.delete": [{ name: "global::can-edit-team", config: { intent: "delete" } }],
  "api::team.team.editable": [{ name: "global::can-edit-team", config: { intent: "editable" } }],

  "api::wiki-page.wiki-page.find": wiki("page"),
  "api::wiki-page.wiki-page.findOne": wiki("page"),
  // Batch 16: the rebuilt row gate (moderator class, no bypass), the
  // authoring controller, and the actions of §J2.
  "api::wiki-page.wiki-page.create": canEditWiki(),
  "api::wiki-page.wiki-page.update": canEditWiki(),
  "api::wiki-page.wiki-page.delete": ADMIN_OR_EDITOR,
  ...Object.fromEntries(
    Object.keys(WIKI_PAGE_ACTION_ROLES).map((intent) => [
      `${WIKI_PAGE}.${intent}`,
      canEditWiki(intent),
    ]),
  ),

  // api::wiki-revision.wiki-revision: no route (batch 15.1, S01 v2 rule 4).

  "api::wiki-space.wiki-space.find": wiki("space"),
  "api::wiki-space.wiki-space.findOne": wiki("space"),
  // Batch 16: the v2 write gate, always published.
  "api::wiki-space.wiki-space.create": canAuthor(WIKI_SPACE),
  "api::wiki-space.wiki-space.update": canAuthor(WIKI_SPACE),
  "api::wiki-space.wiki-space.delete": ADMIN_OR_EDITOR,
  ...authoringRoutes(WIKI_SPACE, WIKI_SPACE_INTENTS),
};

// ---------------------------------------------------------------------------
// (b) Granted core actions that run without policy and without controller
// override. Each needs a reason; an entry that stops matching (route gone,
// grant gone, policy added) fails the stale check, so the list cannot rot.
// ---------------------------------------------------------------------------

const ALLOWLIST: Record<string, string> = {
  "api::acknowledgement.acknowledgement.update": "admin_role-only correction of read receipts",
  "api::acknowledgement.acknowledgement.delete": "admin_role-only correction of read receipts",
  "api::classified.classified.find": "internal flea market, staff-readable (guest holds no grant)",
  "api::classified.classified.findOne":
    "internal flea market, staff-readable (guest holds no grant)",
  "api::event-rsvp.event-rsvp.delete": "admin_role-only correction",
  "api::kudos.kudos.find": "staff-public kudos wall (guest revoked)",
  "api::kudos.kudos.findOne": "staff-public kudos wall (guest revoked)",
};

/**
 * Granted, unpoliced, not overridden — and NOT acceptable. Empty since FX01
 * removed the generic poll-vote writes and notification.update.
 */
const KNOWN_UNGATED = new Set<string>([]);

/**
 * Core actions FX01 removed with `only:` — the web never called them. Their
 * permission rows must be revoked for every role (a removed route leaves its
 * row behind on existing databases).
 */
const FX01_REMOVED = [
  ...CORE_ACTIONS.map((a) => `api::poll-vote.poll-vote.${a}`),
  "api::notification.notification.create",
  "api::notification.notification.update",
  "api::comment.comment.update",
  "api::kudos.kudos.update",
  "api::reaction.reaction.update",
  "api::lesson-progress.lesson-progress.update",
  "api::lesson-progress.lesson-progress.delete",
];

// ---------------------------------------------------------------------------
// Draft & publish (§5.24). Ids from strapi.db.query span draft AND published
// rows and `getFetchParams` lets a client `?status=draft` win, so every read
// route of a D&P type needs a policy that calls forcePublishedStatus after
// the admin/editor bypass. These policies do (each pins it in its own test).
// ---------------------------------------------------------------------------

const PUBLISHED_PINNING_POLICIES = new Set([
  "global::announcement-visibility",
  "global::document-visibility",
  "global::poll-visibility",
  "global::published-only",
  "global::quick-link-visibility",
  "global::training-visibility",
  "global::wiki-visibility",
]);

/**
 * D&P types whose reads still honour a client `?status=draft`. Empty since
 * FX06 put global::published-only on event/poll/department/team (poll has
 * pinned it through global::poll-visibility since decision 02).
 */
const KNOWN_DRAFT_READS = new Set<string>([]);

// ---------------------------------------------------------------------------
// Relation side channels (FX05). Filter policies act on the ROOT query of
// their own routes only: a relation from a type OUTSIDE a filtered type's
// policy domain hands the filtered rows out through populate, filters or
// sort. It works from every route whose model reaches that relation, at any
// depth, on writes as well as reads. So the check is per RELATION, not per
// route: the global guard (registerRestrictedRelationGuard in
// bootstrap/restricted-relation-guard.ts, pinned in index.register.test.ts)
// applies RESTRICTED_RELATION_TARGETS on every content-api query, and this
// block derives every such relation from the schemas (src/api + the
// users-permissions user extension). Coverage is transitive: a path into a
// filtered type either crosses one of these relations or starts at a root
// that the type's own policy narrows, and every trusted source must itself
// sit in the target's policy domain.
// ---------------------------------------------------------------------------

/** Read policies that decide WHICH rows a caller may see. */
const VISIBILITY_FILTER_POLICIES = new Set([
  "global::acknowledgement-visibility",
  "global::announcement-visibility",
  "global::comment-target-visibility",
  "global::document-visibility",
  "global::event-rsvp-own-rows",
  "global::lesson-progress-visibility",
  "global::notification-visibility",
  "global::poll-visibility",
  "global::quick-link-visibility",
  "global::training-visibility",
  "global::wiki-visibility",
]);

const USER_SCHEMA_FILE = join(
  __dirname,
  "extensions",
  "users-permissions",
  "content-types",
  "user",
  "schema.json",
);

/**
 * `<source uid>.<relation>` paths that still leak. Empty since FX05 cut
 * department.pages and team.pages globally.
 */
const KNOWN_RELATION_LEAKS = new Set<string>([]);

// ---------------------------------------------------------------------------
// Write allowlists (FX07). The relation guard TRUSTS wiki-page.parent/
// children, wiki-space.pages and wiki-revision.page to stay inside one wiki
// space; that only holds while no caller can write them freely. The same goes for department.pages and team.pages
// (they move pages between owners, which feeds can-edit-wiki). So every
// relation that touches the wiki filter domain is checked per write route:
// the route's policy enforces utils/write-allowlist.ts and no role class
// may write the relation except
// through a named relation check.
// ---------------------------------------------------------------------------

/**
 * The policy that calls enforceWriteAllowlist() for each allowlist entry,
 * with the role classes it enforces (batch 15 plan S10: action → { policy,
 * classes }). The classes must be exactly the allowlist's for that
 * (uid, action).
 */
const WRITE_ALLOWLIST_ENFORCERS: Record<string, { policy: string; classes: readonly string[] }> = {
  "api::lesson.lesson.create": { policy: "global::can-author", classes: ["moderator"] },
  "api::lesson.lesson.update": { policy: "global::can-author", classes: ["moderator"] },
  "api::course.course.create": { policy: "global::can-author", classes: ["moderator"] },
  "api::course.course.update": { policy: "global::can-author", classes: ["moderator"] },
  // create is admin_role's alone (v0.22, the org gate's `create` intent).
  "api::department.department.create": {
    policy: "global::can-edit-department",
    classes: ["moderator"],
  },
  "api::department.department.update": {
    policy: "global::can-edit-department",
    classes: ["departmentHead", "moderator"],
  },
  "api::team.team.create": { policy: "global::can-edit-team", classes: ["moderator"] },
  "api::team.team.update": {
    policy: "global::can-edit-team",
    classes: ["departmentHead", "moderator", "teamLead"],
  },
  "api::wiki-page.wiki-page.create": {
    policy: "global::can-edit-wiki",
    classes: ["author", "moderator"],
  },
  "api::wiki-page.wiki-page.update": {
    policy: "global::can-edit-wiki",
    classes: ["author", "departmentHead", "moderator", "teamLead"],
  },
  "api::wiki-space.wiki-space.create": { policy: "global::can-author", classes: ["moderator"] },
  "api::wiki-space.wiki-space.update": { policy: "global::can-author", classes: ["moderator"] },
  "api::announcement.announcement.create": {
    policy: "global::can-author",
    classes: ["departmentAuthor", "moderator"],
  },
  "api::announcement.announcement.update": {
    policy: "global::can-author",
    classes: ["departmentAuthor", "moderator"],
  },
  "api::event.event.create": {
    policy: "global::can-author",
    classes: ["departmentAuthor", "moderator"],
  },
  "api::event.event.update": {
    policy: "global::can-author",
    classes: ["departmentAuthor", "moderator"],
  },
  "api::document.document.create": {
    policy: "global::can-author",
    classes: ["departmentAuthor", "moderator"],
  },
  "api::document.document.update": {
    policy: "global::can-author",
    classes: ["departmentAuthor", "moderator"],
  },
  "api::duty-plan.duty-plan.create": {
    policy: "global::can-author",
    classes: ["departmentAuthor", "moderator"],
  },
  "api::duty-plan.duty-plan.update": {
    policy: "global::can-author",
    classes: ["departmentAuthor", "moderator"],
  },
  "api::kpi.kpi.create": {
    policy: "global::can-author",
    classes: ["departmentAuthor", "moderator"],
  },
  "api::kpi.kpi.update": {
    policy: "global::can-author",
    classes: ["departmentAuthor", "moderator"],
  },
  "api::quick-link.quick-link.create": { policy: "global::can-author", classes: ["moderator"] },
  "api::quick-link.quick-link.update": { policy: "global::can-author", classes: ["moderator"] },
  "api::poll.poll.create": { policy: "global::can-author", classes: ["moderator"] },
  "api::poll.poll.update": { policy: "global::can-author", classes: ["moderator"] },
};

const WIKI_REVISION = "api::wiki-revision.wiki-revision";

/** The authored types of decision 06 §A (phase 1 through 3). */
const AUTHORED_TYPES_V2 = [
  ...AUTHORED_UIDS,
  "api::wiki-revision.wiki-revision",
  "api::course.course",
  "api::lesson.lesson",
  "api::department.department",
  "api::team.team",
];

describe("route → policy matrix (S01)", async () => {
  const { routes, controllerMethods, schemas } = await load();

  const policiesOf = (action: string) => routes.get(action)?.config.policies ?? [];
  const isOverridden = (action: string) => {
    const [controller, method] = splitAction(action);
    return controllerMethods.get(controller)?.includes(method) ?? false;
  };
  const isGated = (action: string) => policiesOf(action).length > 0 || isOverridden(action);
  /** The find/findOne permission keys of `uid` that have a live route. */
  const liveReads = (uid: string) =>
    READ_ACTIONS.map((a) => `${uid}.${a}`).filter((a) => routes.has(a));

  /** action → roles holding it via PERMISSION_MATRIX. */
  const matrixGrants = new Map<string, string[]>();
  for (const [role, matrix] of Object.entries(PERMISSION_MATRIX)) {
    for (const [uid, actions] of Object.entries(matrix)) {
      for (const action of actions ?? []) {
        const key = `${uid}.${action}`;
        matrixGrants.set(key, [...(matrixGrants.get(key) ?? []), role]);
      }
    }
  }
  const matrixRoles = Object.keys(PERMISSION_MATRIX);
  /** The matrix by any role string (the typed keys are pinned by tsc). */
  const matrixByRole: Readonly<Record<string, Partial<Record<string, readonly string[]>>>> =
    PERMISSION_MATRIX;
  const customGrantRoles = (grant: readonly string[] | "*"): readonly string[] =>
    grant === "*" ? matrixRoles : grant;

  /** Every action key a role holds after the bootstrap sync. */
  function effectiveGrants(role: string): Set<string> {
    const grants = new Set(USER_READ_GRANTS);
    for (const [uid, actions] of Object.entries(matrixByRole[role] ?? {})) {
      for (const action of actions ?? []) grants.add(`${uid}.${action}`);
    }
    for (const [action, grant] of Object.entries(CUSTOM_ACTION_GRANTS)) {
      if (customGrantRoles(grant).includes(role)) grants.add(action);
    }
    return grants;
  }

  it("loads every router, controller and schema under src/api", () => {
    // Sanity floor: an import or discovery bug must not make the whole
    // matrix pass vacuously.
    expect(routes.size).toBeGreaterThanOrEqual(90);
    expect(schemas.size).toBeGreaterThanOrEqual(22);
    expect(controllerMethods.get("api::poll-vote.poll-vote")).toContain("vote");
  });

  it("(a) matches the golden action → policies table", () => {
    const actual = Object.fromEntries(
      [...routes].map(([action, e]) => [action, e.config.policies ?? []]),
    );
    expect(actual).toEqual(GOLDEN);
  });

  it("only the exchanges and the set-password links disable authentication (auth: false)", () => {
    // An exchange authenticates its caller itself (shared secret + the
    // cms's own ID-token verification, src/entra/provision.ts and
    // src/oidc/provision.ts); a caller has no Strapi JWT before it. The
    // v0.27 link routes take only the web server (shared secret). Any
    // other auth:false route is a hole.
    const publicRoutes = [...routes.values()].filter((e) => e.config.auth === false);
    expect(publicRoutes.map((e) => ({ action: e.action, method: e.method, path: e.path }))).toEqual(
      [
        {
          action: "api::entra-auth.entra-auth.exchange",
          method: "POST",
          path: "/auth/entra/exchange",
        },
        {
          action: "api::oidc-auth.oidc-auth.exchange",
          method: "POST",
          path: "/auth/oidc/exchange",
        },
        {
          action: "api::password-auth.password-auth.forgot",
          method: "POST",
          path: "/auth/password/forgot",
        },
        {
          action: "api::password-auth.password-auth.set",
          method: "POST",
          path: "/auth/password/set",
        },
      ],
    );
  });

  describe("(b) every granted core action is gated", () => {
    for (const [action, roles] of matrixGrants) {
      const test = KNOWN_UNGATED.has(action) ? it.fails : it;
      test(`${action} [${roles.join(", ")}]`, () => {
        expect(isGated(action) || action in ALLOWLIST).toBe(true);
      });
    }

    it("every PERMISSION_MATRIX grant has a live core route (no dead grants)", () => {
      const dead = [...matrixGrants.keys()].filter((a) => routes.get(a)?.kind !== "core");
      expect(dead).toEqual([]);
    });

    it("ALLOWLIST entries are granted, live and still ungated (no stale entries)", () => {
      const stale = Object.keys(ALLOWLIST).filter(
        (a) => !matrixGrants.has(a) || !routes.has(a) || isGated(a) || KNOWN_UNGATED.has(a),
      );
      expect(stale).toEqual([]);
    });

    it("KNOWN_UNGATED entries are granted live routes (flip them when fixed)", () => {
      const stale = [...KNOWN_UNGATED].filter((a) => !matrixGrants.has(a) || !routes.has(a));
      expect(stale).toEqual([]);
    });
  });

  describe("(c) custom routes and CUSTOM_ACTION_GRANTS", () => {
    const customActions = [...routes.values()]
      .filter((e) => e.kind === "custom")
      .map((e) => e.action);

    it("every custom handler resolves to a controller method", () => {
      expect(customActions.filter((a) => !isOverridden(a))).toEqual([]);
    });

    const isPublicRoute = (action: string) => routes.get(action)?.config.auth === false;

    it("every custom handler has a CUSTOM_ACTION_GRANTS key (else it 403s for everyone)", () => {
      expect(
        customActions.filter((a) => !(a in CUSTOM_ACTION_GRANTS) && !isPublicRoute(a)),
      ).toEqual([]);
    });

    it("an auth:false route has no grant (users-permissions never checks one there)", () => {
      const granted = new Set(computeDesiredGrants().map((grant) => grant.action));
      expect(customActions.filter((a) => isPublicRoute(a) && granted.has(a))).toEqual([]);
      expect(customActions.filter(isPublicRoute)).toEqual([
        "api::entra-auth.entra-auth.exchange",
        "api::oidc-auth.oidc-auth.exchange",
        "api::password-auth.password-auth.forgot",
        "api::password-auth.password-auth.set",
      ]);
    });

    it("every api:: CUSTOM_ACTION_GRANTS key has a custom route (no dead grants)", () => {
      const dead = Object.keys(CUSTOM_ACTION_GRANTS).filter(
        (a) => a.startsWith("api::") && routes.get(a)?.kind !== "custom",
      );
      expect(dead).toEqual([]);
    });

    it("CUSTOM_ACTION_GRANTS only names roles of the matrix", () => {
      const unknown = Object.values(CUSTOM_ACTION_GRANTS)
        .flatMap((grant) => customGrantRoles(grant))
        .filter((role) => !matrixRoles.includes(role));
      expect(unknown).toEqual([]);
    });

    /**
     * A custom `GET /<plural>/<word>` also matches the core
     * `GET /<plural>/:id` of the same type. @strapi/core registers an API's
     * route files in file-name order (loaders/apis.js readdir, which libuv
     * returns sorted) and @koa/router runs the first matching route, so the
     * custom file must sort before the core router file — otherwise the
     * core findOne answers with "<word>" as the id.
     */
    it("a custom GET route shadowing a core findOne comes from a file that sorts first", () => {
      const checked: string[] = [];
      const misordered: string[] = [];
      for (const entry of routes.values()) {
        if (entry.kind !== "custom" || entry.method !== "GET" || !entry.path) continue;
        const [plural, word, ...rest] = entry.path.split("/").filter(Boolean);
        if (!plural || !word || rest.length > 0 || word.startsWith(":")) continue;
        for (const [uid, schema] of schemas) {
          const core = routes.get(`${uid}.findOne`);
          if (core?.kind !== "core" || schema.info?.pluralName !== plural) continue;
          checked.push(entry.path);
          const [customApi, , customFile] = entry.source.split("/");
          const [coreApi, , coreFile] = core.source.split("/");
          if (customApi !== coreApi || !(customFile! < coreFile!)) {
            misordered.push(`${entry.source} ${entry.path} vs ${core.source}`);
          }
        }
      }
      expect(checked).toContain("/event-rsvps/summary");
      expect(checked).toEqual(
        expect.arrayContaining([
          "/announcements/authoring",
          "/events/authoring",
          "/quick-links/authoring",
          "/documents/authoring",
          "/duty-plans/authoring",
          "/kpis/authoring",
          "/polls/authoring",
          "/wiki-spaces/authoring",
          "/wiki-pages/authoring",
        ]),
      );
      expect(misordered).toEqual([]);
    });

    /**
     * B04 in CI for the keys the mocked routers cannot see: every plugin::
     * grant must be an action of the INSTALLED plugin's controllers, loaded
     * the way Strapi's controller registry instantiates them. The boot runs
     * the same check (assertKnownActions) over everything Strapi loaded.
     */
    it("every plugin:: grant is an action of the installed plugin's controllers (B04)", () => {
      const plugins = {
        "users-permissions": {
          controllers: installedControllers(cmsPackageDir("@strapi/plugin-users-permissions")),
        },
        upload: { controllers: installedControllers(strapiPackageDir("@strapi/upload")) },
      };
      const known = knownActions({ apis: {}, plugins });
      expect(known.has("plugin::users-permissions.auth.register")).toBe(true);
      const pluginGrants = computeDesiredGrants().filter((grant) =>
        grant.action.startsWith("plugin::"),
      );
      expect([...new Set(pluginGrants.map((grant) => grant.action))].sort()).toEqual([
        "plugin::upload.content-api.upload",
        "plugin::users-permissions.auth.changePassword",
        "plugin::users-permissions.role.find",
        "plugin::users-permissions.user.find",
        "plugin::users-permissions.user.findOne",
        "plugin::users-permissions.user.me",
      ]);
      expect(unknownActions(pluginGrants, known)).toEqual([]);
    });
  });

  describe("(d) REVOKED_PERMISSIONS", () => {
    it("is disjoint from PERMISSION_MATRIX, CUSTOM_ACTION_GRANTS and the user reads", () => {
      const overlaps = Object.entries(REVOKED_PERMISSIONS).flatMap(([role, actions]) => {
        const granted = effectiveGrants(role);
        return actions.filter((a) => granted.has(a)).map((a) => `${role}: ${a}`);
      });
      expect(overlaps).toEqual([]);
    });

    it("only names roles of the matrix, plus the anonymous `public` role", () => {
      expect(Object.keys(REVOKED_PERMISSIONS).filter((r) => !matrixRoles.includes(r))).toEqual([
        "public",
      ]);
    });

    it("D-ENTRA-01: revokes the anonymous forgot/reset-password flow", () => {
      // Neither users-permissions action checks the account's provider, so
      // the e-mail reset would give an Entra-only account a local password.
      expect(REVOKED_PERMISSIONS.public).toEqual([
        "plugin::users-permissions.auth.forgotPassword",
        "plugin::users-permissions.auth.resetPassword",
        // v0.27: no self-registration, no plugin e-mail confirmation, no provider connect.
        "plugin::users-permissions.auth.register",
        "plugin::users-permissions.auth.sendEmailConfirmation",
        "plugin::users-permissions.auth.emailConfirmation",
        "plugin::users-permissions.auth.connect",
        // The plugin's generic user writes (v0.23): no field allowlist, revoked everywhere.
        "plugin::users-permissions.user.create",
        "plugin::users-permissions.user.update",
        "plugin::users-permissions.user.destroy",
      ]);
      const granted = new Set(computeDesiredGrants().map((grant) => grant.action));
      for (const action of REVOKED_PERMISSIONS.public)
        expect(granted.has(action), action).toBe(false);
    });
  });

  describe("draft & publish reads pin status=published (§5.24)", () => {
    const draftTypes = [...schemas]
      .filter(([uid, s]) => s.options?.draftAndPublish && liveReads(uid).length > 0)
      .map(([uid]) => uid);

    for (const uid of draftTypes) {
      const test = KNOWN_DRAFT_READS.has(uid) ? it.fails : it;
      test(`${uid} find/findOne carry a publish-pinning policy`, () => {
        for (const action of liveReads(uid)) {
          const pins = policiesOf(action).some((p) =>
            PUBLISHED_PINNING_POLICIES.has(policyName(p)),
          );
          expect(pins, action).toBe(true);
        }
      });
    }

    it("KNOWN_DRAFT_READS only lists readable draft & publish types", () => {
      expect([...KNOWN_DRAFT_READS].filter((uid) => !draftTypes.includes(uid))).toEqual([]);
    });
  });

  describe("no relation from outside a filter domain into a visibility-filtered type", () => {
    const filterDomain = (uid: string) =>
      new Set(
        policiesOf(`${uid}.find`)
          .map(policyName)
          .filter((n) => VISIBILITY_FILTER_POLICIES.has(n)),
      );

    // Every model a query can walk through — not only types with a route:
    // /api/users reaches department and teams through the user model.
    const models = new Map(schemas);
    models.set(
      "plugin::users-permissions.user",
      JSON.parse(readFileSync(USER_SCHEMA_FILE, "utf8")) as ContentTypeSchema,
    );

    /** `<source>.<relation>` → relation definition + the target's filter policies. */
    const sideChannels = new Map<string, { def: AttributeSchema; domain: string[] }>();
    for (const [source, schema] of models) {
      const sourceDomain = filterDomain(source);
      for (const [attr, def] of Object.entries(schema.attributes)) {
        if (def.type !== "relation" || !def.target) continue;
        const targetDomain = [...filterDomain(def.target)];
        // Unfiltered target, or both sides decided by the same policy
        // family (e.g. wiki-space.pages under wiki-visibility): the relation
        // cannot reach rows the root filter would hide.
        if (targetDomain.length === 0 || targetDomain.some((n) => sourceDomain.has(n))) continue;
        sideChannels.set(`${source}.${attr}`, { def, domain: targetDomain });
      }
    }

    it("sees the department/team → wiki-page and poll-vote → poll relations (rule sanity)", () => {
      expect([...sideChannels.keys()]).toEqual(
        expect.arrayContaining([
          "api::department.department.pages",
          "api::team.team.pages",
          "api::poll-vote.poll-vote.poll",
        ]),
      );
    });

    for (const [path, { def, domain }] of sideChannels) {
      const [source] = splitAction(path);
      const test = KNOWN_RELATION_LEAKS.has(path) ? it.fails : it;
      test(`${path} → ${def.target} cannot bypass ${domain.join(", ")}`, () => {
        expect(isRestrictedRelation({ uid: source }, def, RESTRICTED_RELATION_TARGETS)).toBe(true);
      });
    }

    it("every trusted source sits in its target's filter domain", () => {
      for (const [target, sources] of Object.entries(RESTRICTED_RELATION_TARGETS)) {
        const domain = filterDomain(target);
        expect(domain.size, target).toBeGreaterThan(0);
        for (const source of sources) {
          expect(
            [...filterDomain(source)].some((n) => domain.has(n)),
            `${source} → ${target}`,
          ).toBe(true);
        }
      }
    });

    it("KNOWN_RELATION_LEAKS only lists detected side channels", () => {
      expect([...KNOWN_RELATION_LEAKS].filter((p) => !sideChannels.has(p))).toEqual([]);
    });
  });

  describe("write allowlists (FX07)", () => {
    const allowlist: WriteAllowlist = WRITE_ALLOWLIST;
    const WRITE_ACTIONS = ["create", "update"] as const;
    /** Every role holding the grant is subject to the field rules. */
    const grantHolders = (action: string) => matrixGrants.get(action) ?? [];
    const enforcedBy = (action: string) =>
      policiesOf(action)
        .map(policyName)
        .includes(WRITE_ALLOWLIST_ENFORCERS[action]?.policy ?? "");

    it("every allowlist entry has a live route whose policy enforces it, for exactly its classes", () => {
      const entries = Object.entries(allowlist).flatMap(([uid, actions]) =>
        Object.keys(actions ?? {}).map((write) => `${uid}.${write}`),
      );
      expect(entries.sort()).toEqual(Object.keys(WRITE_ALLOWLIST_ENFORCERS).sort());
      for (const action of entries) {
        expect(routes.get(action)?.kind, action).toBe("core");
        expect(enforcedBy(action), action).toBe(true);
        const [uid, write] = splitAction(action);
        expect([...WRITE_ALLOWLIST_ENFORCERS[action].classes].sort(), action).toEqual(
          writeClassesFor(uid, write as "create" | "update"),
        );
      }
    });

    // The write-side twin of §5.24: enforceWriteAllowlist pins
    // status=published (write-allowlist.test.ts and each enforcing policy's
    // test pin that). A draft & publish write route a restricted role holds
    // outside the allowlist would still honour ?status=draft and answer with
    // draft rows through populate.
    const draftWrites = [...schemas]
      .filter(([, schema]) => schema.options?.draftAndPublish)
      .flatMap(([uid]) => WRITE_ACTIONS.map((write) => `${uid}.${write}`))
      .filter((action) => routes.has(action) && grantHolders(action).length > 0);

    it("sees the wiki-page writes (rule sanity)", () => {
      expect(draftWrites).toEqual(
        expect.arrayContaining([
          "api::wiki-page.wiki-page.create",
          "api::wiki-page.wiki-page.update",
        ]),
      );
    });

    // department and team are single-row since decision 05 (draftAndPublish
    // off, content-type-flags.test.ts), so they left the draft & publish
    // set. Their update routes stay allowlisted (FX07): the next test and
    // this one keep them enforced.
    it("keeps the department and team updates enforced outside the draft & publish set", () => {
      for (const action of ["api::department.department.update", "api::team.team.update"]) {
        expect(draftWrites, action).not.toContain(action);
        expect(grantHolders(action).length, action).toBeGreaterThan(0);
        expect(enforcedBy(action), action).toBe(true);
      }
    });

    // The FX07 gates pin status=published; global::can-author leaves the
    // status to the authoring controller, which takes it explicitly per
    // type, refuses every other query key and answers a fixed DTO (no
    // populate on a write response; authoring-controller.test.ts), so its
    // routes must be overridden by that controller.
    for (const action of draftWrites) {
      it(`${action} is enforced for [${grantHolders(action).join(", ")}] (status pinned or explicit)`, () => {
        expect(action in WRITE_ALLOWLIST_ENFORCERS, `${action} allowlist entry`).toBe(true);
        expect(enforcedBy(action), `${action} policy`).toBe(true);
        const policy = WRITE_ALLOWLIST_ENFORCERS[action].policy;
        if (policy === "global::can-author" || policy === "global::can-edit-wiki") {
          expect(isOverridden(action), `${action} authoring controller`).toBe(true);
        }
      });
    }

    it("every write a restricted role holds on an allowlisted type is enforced", () => {
      for (const uid of Object.keys(allowlist)) {
        for (const write of WRITE_ACTIONS) {
          const action = `${uid}.${write}`;
          if (!routes.has(action) || grantHolders(action).length === 0) continue;
          expect(enforcedBy(action), action).toBe(true);
        }
      }
    });

    /**
     * Every model a trusted or restricted wiki relation starts or ends at:
     * the guard targets that TRUST some sources, with those sources. A
     * target without trusted sources (poll, decision 02) has no relation
     * whose consistency the write side has to keep.
     */
    const wikiDomain = new Set(
      Object.entries(RESTRICTED_RELATION_TARGETS)
        .filter(([, sources]) => sources.length > 0)
        .flatMap(([target, sources]) => [target, ...sources]),
    );
    /** `<uid>.<relation> <write>` for every write route a restricted role holds. */
    const guardedWrites = [...schemas].flatMap(([uid, schema]) =>
      Object.entries(schema.attributes)
        .filter(
          ([, def]) =>
            def.type === "relation" &&
            def.target !== undefined &&
            (wikiDomain.has(uid) || wikiDomain.has(def.target)),
        )
        .flatMap(([attr]) =>
          WRITE_ACTIONS.filter((write) => {
            const action = `${uid}.${write}`;
            return routes.has(action) && grantHolders(action).length > 0;
          }).map((write) => ({ uid, attr, write })),
        ),
    );

    it("sees the wiki-page relations and the department/team pages (rule sanity)", () => {
      expect(guardedWrites.map(({ uid, attr, write }) => `${uid}.${attr} ${write}`)).toEqual(
        expect.arrayContaining([
          "api::wiki-page.wiki-page.space create",
          "api::wiki-page.wiki-page.space update",
          "api::wiki-page.wiki-page.parent update",
          "api::wiki-page.wiki-page.children update",
          "api::wiki-page.wiki-page.revisions update",
          "api::department.department.pages update",
          "api::team.team.pages update",
        ]),
      );
    });

    // wiki-revision has no route at all (S01 v2 rule 4).
    it("wiki-space writes stay with admin_role/editor", () => {
      const writes = [...WRITE_ACTIONS, "delete"].map(
        (write) => `api::wiki-space.wiki-space.${write}`,
      );
      for (const action of writes) expect(grantHolders(action), action).toEqual([...MODERATORS]);
    });

    for (const { uid, attr, write } of guardedWrites) {
      const action = `${uid}.${write}`;
      const holders = grantHolders(action).join(", ");
      it(`${uid}.${attr} has no unchecked ${write} path [${holders}]`, () => {
        expect(enforcedBy(action), `${action} policy`).toBe(true);
        const classes = allowlist[uid]?.[write];
        expect(classes, `${action} allowlist entry`).toBeDefined();
        for (const [roleClass, rule] of Object.entries(classes ?? {})) {
          const spec = Object.prototype.hasOwnProperty.call(rule.fields, attr)
            ? rule.fields[attr]
            : undefined;
          expect(
            spec === undefined ||
              spec.kind === "relation" ||
              (spec.kind === "roleTypes" &&
                schemas.get(uid)?.attributes[attr].target === "plugin::users-permissions.role"),
            `${roleClass}.${attr}`,
          ).toBe(true);
        }
      });
    }
  });

  describe("v2 authoring (decision 06, batch 15)", () => {
    const writes = ["create", "update"] as const;
    const NEVER = ["guest", "authenticated"];

    it("rule 1: every create/update a moderator holds on an authored type enforces the moderator class", () => {
      for (const uid of AUTHORED_TYPES_V2) {
        for (const write of writes) {
          const action = `${uid}.${write}`;
          if (!routes.has(action)) continue;
          const moderators = (matrixGrants.get(action) ?? []).filter((role) =>
            (MODERATORS as readonly string[]).includes(role),
          );
          if (moderators.length === 0) continue;
          const enforcer = WRITE_ALLOWLIST_ENFORCERS[action];
          const enforced =
            enforcer !== undefined &&
            enforcer.classes.includes(MODERATOR_CLASS) &&
            policiesOf(action).map(policyName).includes(enforcer.policy);
          expect(enforced, action).toBe(true);
        }
      }
    });

    it("the bypass ends on the authored types: no route of theirs is is-admin-or-editor but delete", () => {
      for (const uid of AUTHORED_UIDS) {
        // Wiki pages have their own row gate on the same model (batch 16).
        const gate = uid === WIKI_PAGE ? "global::can-edit-wiki" : "global::can-author";
        for (const write of writes) {
          expect(policiesOf(`${uid}.${write}`).map(policyName), `${uid}.${write}`).toEqual([gate]);
        }
        if (uid === "api::course.course" || uid === "api::lesson.lesson") {
          expect(routes.has(`${uid}.delete`), `${uid}.delete`).toBe(false);
          continue;
        }
        expect(policiesOf(`${uid}.delete`).map(policyName), `${uid}.delete`).toEqual([
          "global::is-admin-or-editor",
        ]);
        // delete is the authoring controller's (If-Match), not the core's.
        expect(isOverridden(`${uid}.delete`), `${uid}.delete`).toBe(true);
      }
    });

    it("rule 2: every authoring custom action goes to exactly its roles, never guest or authenticated", () => {
      const expected: Record<string, readonly string[]> = {};
      // The always-published types have no publish, unpublish or discard.
      const intentsOf: Record<string, readonly string[]> = {
        [POLL]: POLL_INTENTS,
        [WIKI_SPACE]: WIKI_SPACE_INTENTS,
      };
      for (const uid of AUTHORED_UIDS) {
        if (uid === WIKI_PAGE) continue; // can-edit-wiki's actions: the next test.
        const intents = intentsOf[uid] ?? DP_INTENTS;
        // Department heads on every department-authored type, team leads on duty plans.
        const roles = [...MODERATORS, ...departmentAuthorRolesOf(uid)];
        for (const intent of intents) expected[`${uid}.${intent}`] = roles;
      }
      const authoringCustom = [...routes.values()].filter(
        (entry) =>
          entry.kind === "custom" &&
          (entry.config.policies ?? []).some((spec) => policyName(spec) === "global::can-author"),
      );
      expect(authoringCustom.map((entry) => entry.action).sort()).toEqual(
        Object.keys(expected).sort(),
      );
      for (const [action, roles] of Object.entries(expected)) {
        const grant = CUSTOM_ACTION_GRANTS[action];
        expect(grant, action).not.toBe("*");
        expect([...(grant as readonly string[])].sort(), action).toEqual([...roles].sort());
        for (const role of NEVER)
          expect(effectiveGrants(role).has(action), `${role} ${action}`).toBe(false);
      }
    });

    it("rule 2: every wiki-page action of §J2 goes to exactly its roles, never guest or authenticated", () => {
      const wikiCustom = [...routes.values()].filter(
        (entry) =>
          entry.kind === "custom" &&
          (entry.config.policies ?? []).some(
            (spec) => policyName(spec) === "global::can-edit-wiki",
          ),
      );
      expect(wikiCustom.map((entry) => entry.action).sort()).toEqual(
        Object.keys(WIKI_PAGE_ACTION_ROLES)
          .map((intent) => `${WIKI_PAGE}.${intent}`)
          .sort(),
      );
      // Eleven actions (§J2): the plan's +52 grant rows with the two of wiki-space.
      expect(wikiCustom).toHaveLength(11);
      let rows = 0;
      for (const [intent, roles] of Object.entries(WIKI_PAGE_ACTION_ROLES)) {
        const action = `${WIKI_PAGE}.${intent}`;
        const grant = CUSTOM_ACTION_GRANTS[action];
        expect(grant, action).not.toBe("*");
        expect([...(grant as readonly string[])].sort(), action).toEqual([...roles].sort());
        for (const role of NEVER)
          expect(effectiveGrants(role).has(action), `${role} ${action}`).toBe(false);
        rows += roles.length;
      }
      const spaceRows = WIKI_SPACE_INTENTS.length * MODERATORS.length;
      expect(rows + spaceRows).toBe(52);
    });

    it("every global::can-edit-wiki route carries the wiki-page uid (and a custom route its intent)", () => {
      for (const entry of routes.values()) {
        for (const spec of entry.config.policies ?? []) {
          if (policyName(spec) !== "global::can-edit-wiki") continue;
          const config = typeof spec === "string" ? undefined : spec.config;
          const [uid, action] = splitAction(entry.action);
          expect(uid, entry.action).toBe(WIKI_PAGE);
          expect(config?.uid, entry.action).toBe(WIKI_PAGE);
          if (entry.kind === "custom") expect(config?.intent, entry.action).toBe(action);
          else expect(config?.intent, entry.action).toBeUndefined();
        }
      }
    });

    it("every global::can-author route carries its own uid (and a custom route its intent)", () => {
      for (const entry of routes.values()) {
        for (const spec of entry.config.policies ?? []) {
          if (policyName(spec) !== "global::can-author") continue;
          const config = typeof spec === "string" ? undefined : spec.config;
          const [uid, action] = splitAction(entry.action);
          expect(config?.uid, entry.action).toBe(uid);
          if (
            entry.kind === "custom" ||
            uid === "api::course.course" ||
            uid === "api::lesson.lesson"
          )
            expect(config?.intent, entry.action).toBe(action);
          else expect(config?.intent, entry.action).toBeUndefined();
        }
      }
    });

    /**
     * Batch 15.1 (decision 06 §J3 "Generic routes", §B4): a revision holds
     * the page body before an edit, draft text included. No route, no grant
     * for any role (a batch-15 database holds 18 rows, revoked at boot), and
     * every relation into the type is closed for every caller, admin_role
     * and editor included: without `find` the core drops a populate and
     * refuses a root filter or sort, the guard the filter and sort nested in
     * a populate, which the core does not check.
     */
    it("rule 4: wiki-revision exposes no route and is revoked for every role", () => {
      expect([...routes.keys()].filter((action) => action.startsWith(`${WIKI_REVISION}.`))).toEqual(
        [],
      );
      for (const role of matrixRoles) {
        expect(
          [...effectiveGrants(role)].filter((action) => action.startsWith(`${WIKI_REVISION}.`)),
          role,
        ).toEqual([]);
        for (const action of CORE_ACTIONS) {
          expect(REVOKED_PERMISSIONS[role] ?? [], `${role}: ${action}`).toContain(
            `${WIKI_REVISION}.${action}`,
          );
        }
      }
      expect(
        computeDesiredGrants().filter((grant) => grant.action.startsWith(`${WIKI_REVISION}.`)),
      ).toEqual([]);
    });

    it("rule 4: every relation into wiki-revision is closed for every caller", () => {
      const models = new Map(schemas);
      models.set(
        "plugin::users-permissions.user",
        JSON.parse(readFileSync(USER_SCHEMA_FILE, "utf8")) as ContentTypeSchema,
      );
      const into = [...models].flatMap(([source, schema]) =>
        Object.entries(schema.attributes)
          .filter(([, def]) => def.type === "relation" && def.target === WIKI_REVISION)
          .map(([attr, def]) => ({ path: `${source}.${attr}`, source, def })),
      );
      expect(into.map(({ path }) => path)).toEqual(["api::wiki-page.wiki-page.revisions"]);
      expect(CLOSED_RELATION_TARGETS[WIKI_REVISION]).toEqual([]);
      for (const { path, source, def } of into) {
        expect(isRestrictedRelation({ uid: source }, def, CLOSED_RELATION_TARGETS), path).toBe(
          true,
        );
      }
    });

    it("rule 5: no role.find for editor or department_head", () => {
      for (const role of ["editor", "department_head"]) {
        expect(effectiveGrants(role).has("plugin::users-permissions.role.find"), role).toBe(false);
      }
    });

    it("rule 7: department_head holds exactly the department-author grants", () => {
      // Actions every role holds ("*": the event's ICS download, poll results) are not authoring.
      const grants = new Set(
        [...effectiveGrants("department_head")].filter(
          (action) => CUSTOM_ACTION_GRANTS[action] !== "*",
        ),
      );
      for (const uid of DEPARTMENT_AUTHORED_UIDS) {
        const held = [...grants]
          .filter((action) => action.startsWith(`${uid}.`))
          .map((action) => splitAction(action)[1])
          .sort();
        expect(held, uid).toEqual(
          [
            "authoringList",
            "create",
            "discardDraft",
            "editable",
            "find",
            "findOne",
            "publish",
            "unpublish",
            "update",
          ].sort(),
        );
      }
      for (const uid of [
        QUICK_LINK,
        POLL,
        "api::wiki-space.wiki-space",
        "api::course.course",
        "api::lesson.lesson",
      ]) {
        const authoring = [...grants].filter(
          (action) =>
            action.startsWith(`${uid}.`) &&
            !["find", "findOne"].includes(splitAction(action)[1]) &&
            ![
              "api::lesson.lesson.player",
              "api::lesson.lesson.check",
              "api::course.course.report",
              "api::course.course.reportCourse",
            ].includes(action),
        );
        expect(authoring, uid).toEqual([]);
      }
      // The department-author class is admitted by global::can-author only.
      for (const [action, enforcer] of Object.entries(WRITE_ALLOWLIST_ENFORCERS)) {
        if (enforcer.classes.includes(DEPARTMENT_AUTHOR_CLASS)) {
          expect(enforcer.policy, action).toBe("global::can-author");
        }
      }
      const withClass = Object.entries(WRITE_ALLOWLIST_ENFORCERS)
        .filter(([, enforcer]) => enforcer.classes.includes(DEPARTMENT_AUTHOR_CLASS))
        .map(([action]) => action)
        .sort();
      expect(withClass).toEqual(
        DEPARTMENT_AUTHORED_UIDS.flatMap((uid) => [`${uid}.create`, `${uid}.update`]).sort(),
      );
    });
  });

  describe("duty plans (v0.18, owner decision 2026-10-20)", () => {
    it("team_lead authors duty plans and no other department-authored type", () => {
      const grants = new Set(
        [...effectiveGrants("team_lead")].filter((action) => CUSTOM_ACTION_GRANTS[action] !== "*"),
      );
      const authoring = (uid: string) =>
        [...grants]
          .filter((action) => action.startsWith(`${uid}.`))
          .map((action) => splitAction(action)[1])
          .filter((action) => !["find", "findOne"].includes(action))
          .sort();
      expect(authoring(DUTY_PLAN)).toEqual(
        [
          "authoringList",
          "create",
          "discardDraft",
          "editable",
          "publish",
          "unpublish",
          "update",
        ].sort(),
      );
      for (const uid of [ANNOUNCEMENT, EVENT, DOCUMENT, QUICK_LINK, POLL, KPI]) {
        expect(authoring(uid), uid).toEqual([]);
      }
    });

    it("every staff role and authenticated read published plans and KPIs; guests do not", () => {
      for (const role of matrixRoles) {
        for (const uid of [DUTY_PLAN, KPI]) {
          expect(effectiveGrants(role).has(`${uid}.find`), `${role} ${uid}`).toBe(role !== "guest");
        }
      }
    });
  });

  describe("fixed holes (regressions)", () => {
    it("player and feedback are granted exactly to lesson readers", () => {
      const readers = [...(matrixGrants.get("api::lesson.lesson.find") ?? [])].sort();
      for (const action of ["api::lesson.lesson.player", "api::lesson.lesson.check"]) {
        expect(matrixRoles.filter((role) => effectiveGrants(role).has(action)).sort()).toEqual(
          readers,
        );
      }
    });

    it("FX01: POST/PUT/DELETE /api/poll-votes are gone or gated (forged votes)", () => {
      for (const write of ["create", "update", "delete"]) {
        const action = `api::poll-vote.poll-vote.${write}`;
        expect(!routes.has(action) || isGated(action), action).toBe(true);
      }
    });

    it("FX01: the generic poll-vote router exposes no route at all (decisions/02)", () => {
      expect([...routes.keys()].filter((a) => a.startsWith("api::poll-vote.poll-vote."))).toEqual([
        "api::poll-vote.poll-vote.vote",
        "api::poll-vote.poll-vote.results",
      ]);
    });

    it("decision 02: poll reads are filtered by poll-visibility alone (not stacked on published-only)", () => {
      for (const action of ["api::poll.poll.find", "api::poll.poll.findOne"]) {
        expect(policiesOf(action).map(policyName), action).toEqual(["global::poll-visibility"]);
      }
    });

    it("decision 02: vote and results are granted to every role, guest included", () => {
      expect(matrixRoles).toEqual(
        expect.arrayContaining([
          "admin_role",
          "editor",
          "department_head",
          "team_lead",
          "member",
          "guest",
          "authenticated",
        ]),
      );
      for (const action of ["api::poll-vote.poll-vote.vote", "api::poll-vote.poll-vote.results"]) {
        expect(CUSTOM_ACTION_GRANTS[action], action).toBe("*");
        for (const role of matrixRoles) {
          expect(effectiveGrants(role).has(action), `${role}: ${action}`).toBe(true);
        }
      }
    });

    it("WD04: the batched results are granted like poll reads today, guest included", () => {
      const batch = "api::poll.poll.batchResults";
      expect(routes.get(batch)).toMatchObject({
        kind: "custom",
        method: "GET",
        path: "/poll-results",
      });
      expect(controllerMethods.get("api::poll.poll")).toContain("batchResults");
      expect(CUSTOM_ACTION_GRANTS[batch]).toBe("*");
      const holders = matrixRoles.filter((role) => effectiveGrants(role).has(batch)).sort();
      expect(holders).toEqual([...(matrixGrants.get("api::poll.poll.find") ?? [])].sort());
      for (const role of holders) {
        expect(effectiveGrants(role).has("api::poll-vote.poll-vote.results"), role).toBe(true);
      }
      expect(holders).toContain("guest");
    });

    it("decision 02: vote and results stay custom routes on the poll-vote controller", () => {
      expect(routes.get("api::poll-vote.poll-vote.vote")?.kind).toBe("custom");
      expect(routes.get("api::poll-vote.poll-vote.results")?.kind).toBe("custom");
      expect(controllerMethods.get("api::poll-vote.poll-vote")).toEqual(
        expect.arrayContaining(["vote", "results"]),
      );
    });

    it("FX21: raw RSVP reads are narrowed to the caller's own rows", () => {
      for (const action of [
        "api::event-rsvp.event-rsvp.find",
        "api::event-rsvp.event-rsvp.findOne",
      ]) {
        expect(policiesOf(action).map(policyName), action).toEqual(["global::event-rsvp-own-rows"]);
      }
    });

    it("FX21: the RSVP summary is granted exactly like event-rsvp find, never to guest", () => {
      const summary = "api::event-rsvp.event-rsvp.summary";
      expect(routes.get(summary)?.kind).toBe("custom");
      expect(controllerMethods.get("api::event-rsvp.event-rsvp")).toContain("summary");
      const holders = matrixRoles.filter((role) => effectiveGrants(role).has(summary)).sort();
      expect(holders).toEqual(
        [...(matrixGrants.get("api::event-rsvp.event-rsvp.find") ?? [])].sort(),
      );
      expect(holders).not.toContain("guest");
    });

    it("B02: the classified ownership bypasses are ADMIN (update) and MODERATORS (delete)", () => {
      const bypassOf = (action: string) =>
        policiesOf(action)
          .map((spec) => (typeof spec === "string" ? undefined : spec.config?.bypassRoles))
          .find((roles) => roles !== undefined);
      expect(bypassOf("api::classified.classified.update")).toEqual([ADMIN]);
      expect(bypassOf("api::classified.classified.delete")).toEqual([...MODERATORS]);
    });

    it("PL03: comment and reaction delete are owner-gated by a route policy, not in the controller alone", () => {
      expect(policiesOf("api::comment.comment.delete").map(policyName)).toEqual([
        "global::is-comment-author",
      ]);
      expect(policiesOf("api::reaction.reaction.delete").map(policyName)).toEqual([
        "global::is-reaction-author",
      ]);
      // Both controllers still override delete: the numeric id → documentId
      // translation the v5 core delete lacks.
      expect(isOverridden("api::comment.comment.delete")).toBe(true);
      expect(isOverridden("api::reaction.reaction.delete")).toBe(true);
    });

    it("FX01: removed core actions have no route, no grant and are revoked for every role", () => {
      for (const action of FX01_REMOVED) {
        expect(routes.has(action), action).toBe(false);
        expect(matrixGrants.has(action), action).toBe(false);
        for (const role of matrixRoles) {
          expect(REVOKED_PERMISSIONS[role] ?? [], `${role}: ${action}`).toContain(action);
        }
      }
    });
  });
});
