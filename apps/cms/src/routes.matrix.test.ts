import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CUSTOM_ACTION_GRANTS, PERMISSION_MATRIX, REVOKED_PERMISSIONS } from "./index";
import { RESTRICTED_RELATION_TARGETS, isRestrictedRelation } from "./utils/restricted-relations";

/**
 * Route → policy golden matrix and grant cross-check (roadmap S01).
 *
 * Every content-API call passes two independent gates (docs/architecture.md
 * §5.8): the users-permissions GRANT (a permission row `<uid>.<action>`,
 * seeded by src/index.ts) and the route's POLICIES (`config.policies` in
 * src/api/*\/routes/*.ts). The shipped authorization defects sat in the seam
 * between the two — router config that the pure unit suite never sees:
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
 * into that type is cut by the global relation guard (FX05).
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
 * (USER_READ_ACTIONS in src/index.ts, USER_READ_EXCLUDED_ROLES is empty on
 * purpose — see the guest OPEN ISSUE note there).
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
}

interface Loaded {
  routes: Map<string, RouteEntry>;
  /** Controller uid → own (overriding or custom) method names. */
  controllerMethods: Map<string, string[]>;
  schemas: Map<string, ContentTypeSchema>;
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
          add({ action: route.handler, kind: "custom", source, config: route.config ?? {} });
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
  "api::announcement.announcement.create": ADMIN_OR_EDITOR,
  "api::announcement.announcement.update": ADMIN_OR_EDITOR,
  "api::announcement.announcement.delete": ADMIN_OR_EDITOR,

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
  "api::comment.comment.delete": [],

  "api::course.course.find": training("course"),
  "api::course.course.findOne": training("course"),

  "api::department.department.find": ["global::published-only"],
  "api::department.department.findOne": ["global::published-only"],
  "api::department.department.create": ADMIN_OR_EDITOR,
  "api::department.department.update": ["global::is-department-head"],
  "api::department.department.delete": ADMIN_OR_EDITOR,

  "api::document.document.find": ["global::document-visibility"],
  "api::document.document.findOne": ["global::document-visibility"],
  "api::document.document.create": ADMIN_OR_EDITOR,
  "api::document.document.update": ADMIN_OR_EDITOR,
  "api::document.document.delete": ADMIN_OR_EDITOR,

  "api::event.event.find": ["global::published-only"],
  "api::event.event.findOne": ["global::published-only"],
  "api::event.event.create": ADMIN_OR_EDITOR,
  "api::event.event.update": ADMIN_OR_EDITOR,
  "api::event.event.delete": ADMIN_OR_EDITOR,
  "api::event.event.ics": [],

  "api::event-rsvp.event-rsvp.find": [],
  "api::event-rsvp.event-rsvp.findOne": [],
  "api::event-rsvp.event-rsvp.create": [],
  "api::event-rsvp.event-rsvp.update": ["global::is-event-rsvp-owner"],
  "api::event-rsvp.event-rsvp.delete": [],

  "api::kudos.kudos.find": [],
  "api::kudos.kudos.findOne": [],
  "api::kudos.kudos.create": [],
  "api::kudos.kudos.delete": ADMIN_OR_EDITOR,
  "api::kudos.kudos.celebrations": [],

  "api::lesson.lesson.find": training("lesson"),
  "api::lesson.lesson.findOne": training("lesson"),

  "api::lesson-progress.lesson-progress.find": ["global::lesson-progress-visibility"],
  "api::lesson-progress.lesson-progress.findOne": ["global::lesson-progress-visibility"],
  "api::lesson-progress.lesson-progress.create": [],

  "api::notification.notification.find": ["global::notification-visibility"],
  "api::notification.notification.findOne": ["global::notification-visibility"],
  "api::notification.notification.delete": ["global::is-notification-recipient"],
  "api::notification.notification.markRead": [],
  "api::notification.notification.markAllRead": [],

  "api::poll.poll.find": ["global::published-only"],
  "api::poll.poll.findOne": ["global::published-only"],
  "api::poll.poll.create": ADMIN_OR_EDITOR,
  "api::poll.poll.update": ADMIN_OR_EDITOR,
  "api::poll.poll.delete": ADMIN_OR_EDITOR,

  "api::poll-vote.poll-vote.vote": [],
  "api::poll-vote.poll-vote.results": [],

  "api::profile.profile.me": [],
  "api::profile.profile.updateMe": [],

  "api::quick-link.quick-link.find": ["global::quick-link-visibility"],
  "api::quick-link.quick-link.findOne": ["global::quick-link-visibility"],
  "api::quick-link.quick-link.create": ADMIN_OR_EDITOR,
  "api::quick-link.quick-link.update": ADMIN_OR_EDITOR,
  "api::quick-link.quick-link.delete": ADMIN_OR_EDITOR,

  "api::reaction.reaction.find": ["global::comment-target-visibility"],
  "api::reaction.reaction.findOne": ["global::comment-target-visibility"],
  "api::reaction.reaction.create": [],
  "api::reaction.reaction.delete": ["global::is-reaction-author"],

  "api::search-log.search-log.create": [],
  "api::search-log.search-log.summary": ADMIN_OR_EDITOR,

  "api::team.team.find": ["global::published-only"],
  "api::team.team.findOne": ["global::published-only"],
  "api::team.team.create": ADMIN_OR_EDITOR,
  "api::team.team.update": ["global::is-team-member-or-lead"],
  "api::team.team.delete": ADMIN_OR_EDITOR,

  "api::wiki-page.wiki-page.find": wiki("page"),
  "api::wiki-page.wiki-page.findOne": wiki("page"),
  "api::wiki-page.wiki-page.create": ["global::can-edit-wiki"],
  "api::wiki-page.wiki-page.update": ["global::can-edit-wiki"],
  "api::wiki-page.wiki-page.delete": ADMIN_OR_EDITOR,

  "api::wiki-revision.wiki-revision.find": wiki("revision"),
  "api::wiki-revision.wiki-revision.findOne": wiki("revision"),
  "api::wiki-revision.wiki-revision.create": ADMIN_OR_EDITOR,
  "api::wiki-revision.wiki-revision.update": ADMIN_OR_EDITOR,
  "api::wiki-revision.wiki-revision.delete": ADMIN_OR_EDITOR,

  "api::wiki-space.wiki-space.find": wiki("space"),
  "api::wiki-space.wiki-space.findOne": wiki("space"),
  "api::wiki-space.wiki-space.create": ADMIN_OR_EDITOR,
  "api::wiki-space.wiki-space.update": ADMIN_OR_EDITOR,
  "api::wiki-space.wiki-space.delete": ADMIN_OR_EDITOR,
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
  "global::published-only",
  "global::quick-link-visibility",
  "global::training-visibility",
  "global::wiki-visibility",
]);

/**
 * D&P types whose reads still honour a client `?status=draft`. Empty since
 * FX06 put global::published-only on event/poll/department/team.
 */
const KNOWN_DRAFT_READS = new Set<string>([]);

// ---------------------------------------------------------------------------
// Relation side channels (FX05). Filter policies act on the ROOT query of
// their own routes only: a relation from a type OUTSIDE a filtered type's
// policy domain hands the filtered rows out through populate, filters or
// sort. It works from every route whose model reaches that relation, at any
// depth, on writes as well as reads. So the check is per RELATION, not per
// route: the global guard (registerRestrictedRelationGuard in src/index.ts,
// pinned in index.register.test.ts) applies RESTRICTED_RELATION_TARGETS on
// every content-api query, and this block derives every such relation from
// the schemas (src/api + the users-permissions user extension). Coverage is
// transitive: a path into a filtered type either crosses one of these
// relations or starts at a root that the type's own policy narrows, and
// every trusted source must itself sit in the target's policy domain.
// ---------------------------------------------------------------------------

/** Read policies that decide WHICH rows a caller may see. */
const VISIBILITY_FILTER_POLICIES = new Set([
  "global::acknowledgement-visibility",
  "global::announcement-visibility",
  "global::comment-target-visibility",
  "global::document-visibility",
  "global::lesson-progress-visibility",
  "global::notification-visibility",
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
  const customGrantRoles = (grant: string[] | "*") => (grant === "*" ? matrixRoles : grant);

  /** Every action key a role holds after the bootstrap sync. */
  function effectiveGrants(role: string): Set<string> {
    const grants = new Set(USER_READ_GRANTS);
    for (const [uid, actions] of Object.entries(PERMISSION_MATRIX[role] ?? {})) {
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

  it("no route disables authentication (auth: false)", () => {
    const publicRoutes = [...routes.values()].filter((e) => e.config.auth === false);
    expect(publicRoutes.map((e) => e.action)).toEqual([]);
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

    it("every custom handler has a CUSTOM_ACTION_GRANTS key (else it 403s for everyone)", () => {
      expect(customActions.filter((a) => !(a in CUSTOM_ACTION_GRANTS))).toEqual([]);
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
  });

  describe("(d) REVOKED_PERMISSIONS", () => {
    it("is disjoint from PERMISSION_MATRIX, CUSTOM_ACTION_GRANTS and the user reads", () => {
      const overlaps = Object.entries(REVOKED_PERMISSIONS).flatMap(([role, actions]) => {
        const granted = effectiveGrants(role);
        return actions.filter((a) => granted.has(a)).map((a) => `${role}: ${a}`);
      });
      expect(overlaps).toEqual([]);
    });

    it("only names roles of the matrix", () => {
      expect(Object.keys(REVOKED_PERMISSIONS).filter((r) => !matrixRoles.includes(r))).toEqual([]);
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

    it("sees the department/team → wiki-page relations (rule sanity)", () => {
      expect([...sideChannels.keys()]).toEqual(
        expect.arrayContaining(["api::department.department.pages", "api::team.team.pages"]),
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

  describe("fixed holes (regressions)", () => {
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
