/**
 * The module and feature switches on the cms side (v0.28, S2 + M11). The
 * names and the parser are the domain's (`FEATURES_OFF`,
 * packages/domain/src/features.ts); this file maps them onto the cms:
 *
 *   - every content-API route of a module's APIs refuses with 404 while the
 *     module is off: `global::module-enabled` is put in FRONT of each route's
 *     policies at register() (decorateSwitchedRoutes), structurally, so a new
 *     route of such an API is covered without an edit here;
 *   - single routes of a feature refuse the same way (`global::feature-enabled`,
 *     by handler, so the route files stay untouched);
 *   - the background paths (scheduler, fan-outs, crons, digest, search index)
 *     ask `isModuleOff` / `isUidOff` themselves.
 *
 * Every route is decorated whatever the env says; the policies read the
 * env per request, so a switch needs no second code path in the tests. A
 * change of FEATURES_OFF still takes a restart in production: the crons
 * and the web read it at start.
 *
 * The data of a switched-off module stays, and the rights operations
 * (export, anonymisation) and the retention jobs run regardless.
 */
import {
  MODULE_NAMES,
  featuresOff,
  isSwitchedOff,
  type FeatureName,
  type ModuleName,
  type SwitchName,
} from "@sinnlos/domain";
import { errors } from "@strapi/utils";

/** The APIs (`strapi.apis` keys) whose every route belongs to a module. */
export const MODULE_APIS: Readonly<Record<ModuleName, readonly string[]>> = {
  events: ["event", "event-rsvp"],
  training: ["course", "lesson", "lesson-progress"],
  marketplace: ["classified"],
  kudos: ["kudos"],
  // GET /celebrations lives in the kudos API (HANDLER_MODULE).
  celebrations: [],
  polls: ["poll", "poll-vote"],
  "duty-plans": ["duty-plan"],
  kpis: ["kpi"],
};

/** Routes whose module is not their API's, by handler. */
export const HANDLER_MODULE: Readonly<Record<string, ModuleName>> = {
  "api::kudos.kudos.celebrations": "celebrations",
};

/** Single routes of a feature, by handler. */
export const HANDLER_FEATURE: Readonly<Record<string, FeatureName>> = {
  "api::acknowledgement.acknowledgement.create": "read-confirmations",
  "api::course.course.report": "training-reports",
  "api::course.course.reportCourse": "training-reports",
  "api::search-log.search-log.summary": "search-logging",
};

export const MODULE_POLICY = "global::module-enabled";
export const FEATURE_POLICY = "global::feature-enabled";

const API_MODULE = new Map<string, ModuleName>(
  MODULE_NAMES.flatMap((module) => MODULE_APIS[module].map((api) => [api, module] as const)),
);

/** The module a content type belongs to (`api::event.event` → events), or null for the base. */
export function moduleOfUid(uid: string): ModuleName | null {
  const match = /^api::([^.]+)\./.exec(uid);
  return match ? (API_MODULE.get(match[1]) ?? null) : null;
}

/** Whether `name` is switched off (process.env by default). */
export function isOff(
  name: SwitchName,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isSwitchedOff(env, name);
}

/** Whether the module of content type `uid` is off; base types never are. */
export function isUidOff(uid: string, env: Record<string, string | undefined> = process.env) {
  const module = moduleOfUid(uid);
  return module !== null && isSwitchedOff(env, module);
}

/**
 * register(): one line naming what is off, and the boot check: an unknown
 * FEATURES_OFF value throws here (FeaturesOffError), before any route exists.
 */
export function switchesStatusLine(env: Record<string, string | undefined>): string {
  const off = [...featuresOff(env)].sort();
  return off.length > 0 ? `[switches] off: ${off.join(", ")}` : "[switches] everything on";
}

/** The policies' refusal: the same 404 as a route that does not exist. */
export function assertSwitchedOn(name: SwitchName): void {
  if (isOff(name)) throw new errors.NotFoundError("Not Found");
}

type PolicySpec = string | { name?: unknown; config?: unknown };

interface DecoratedRoute {
  handler?: unknown;
  config?: { policies?: PolicySpec[]; [key: string]: unknown };
}

/** The slice of the Strapi instance decorateSwitchedRoutes walks. */
export interface SwitchedRoutesHost {
  apis: Record<string, { routes?: Record<string, unknown> } | undefined>;
}

const policyName = (spec: PolicySpec) => (typeof spec === "string" ? spec : spec?.name);

/** Puts `gates` in front of the route's policies, once each, in their order. */
function prependPolicies(route: DecoratedRoute, gates: readonly SwitchGate[]) {
  route.config ??= {};
  const policies = route.config.policies ?? [];
  const missing = gates.filter(
    (gate) => !policies.some((existing) => policyName(existing) === gate.name),
  );
  route.config.policies = [...missing, ...policies];
}

/** One switch policy with its config. */
export interface SwitchGate {
  name: string;
  config: { module: ModuleName } | { feature: FeatureName };
}

/**
 * The switch policies of one route of `apiName`, in order: its module (by
 * handler, else by API), then its feature. Empty for a base route.
 */
export function switchesOfRoute(apiName: string, handler: unknown): SwitchGate[] {
  const key = typeof handler === "string" ? handler : "";
  const gates: SwitchGate[] = [];
  const module = HANDLER_MODULE[key] ?? API_MODULE.get(apiName);
  if (module) gates.push({ name: MODULE_POLICY, config: { module } });
  const feature = HANDLER_FEATURE[key];
  if (feature) gates.push({ name: FEATURE_POLICY, config: { feature } });
  return gates;
}

/**
 * register(): puts the module and feature policies in front of every route
 * they govern. Runs before Strapi registers the routes (bootstrap()), so the
 * router objects are still the ones it will read. Throws when a router has
 * a shape it cannot walk (a function router, routes that are no list):
 * the switches must not silently miss a route.
 */
export function decorateSwitchedRoutes(strapi: SwitchedRoutesHost): number {
  if (strapi.apis === null || typeof strapi.apis !== "object") {
    throw new Error("[switches] strapi.apis not found; FEATURES_OFF cannot be enforced");
  }
  let decorated = 0;
  for (const [apiName, api] of Object.entries(strapi.apis)) {
    for (const [routerName, router] of Object.entries(api?.routes ?? {})) {
      const routes = (router as { routes?: unknown } | null)?.routes;
      if (typeof router === "function" || !Array.isArray(routes)) {
        throw new Error(
          `[switches] api::${apiName} router ${routerName} has no route list; FEATURES_OFF cannot be enforced`,
        );
      }
      for (const route of routes as DecoratedRoute[]) {
        const gates = switchesOfRoute(apiName, route.handler);
        if (gates.length === 0) continue;
        prependPolicies(route, gates);
        decorated += 1;
      }
    }
  }
  return decorated;
}
