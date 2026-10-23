import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { errors } from "@strapi/utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import featureEnabled from "../policies/feature-enabled";
import moduleEnabled from "../policies/module-enabled";
import {
  FEATURE_POLICY,
  HANDLER_FEATURE,
  HANDLER_MODULE,
  MODULE_APIS,
  MODULE_POLICY,
  decorateSwitchedRoutes,
  isUidOff,
  moduleOfUid,
  switchesStatusLine,
} from "./module-switches";

/**
 * FEATURES_OFF on the cms side (v0.28). The structural part runs the real
 * decoration over every router of src/api, built the way @strapi/core
 * builds them (core routers: one route per selected action, handler
 * `<uid>.<action>`, config per action), so a module route without its
 * policy, or a stale handler key, fails here. routes.matrix.test.ts pins
 * the static route configs; this pins what register() adds to them.
 */

interface Route {
  method?: string;
  path?: string;
  handler: string;
  config?: { policies?: unknown[] };
}

const CORE_ACTIONS = ["find", "findOne", "create", "update", "delete"];

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreRouter: (
      uid: string,
      options: {
        only?: string[];
        except?: string[];
        config?: Record<string, { policies?: unknown[] } | undefined>;
      } = {},
    ) => ({
      routes: CORE_ACTIONS.filter((action) => !options.except?.includes(action))
        .filter((action) => !options.only || options.only.includes(action))
        .map((action) => ({ handler: `${uid}.${action}`, config: options.config?.[action] ?? {} })),
    }),
    createCoreController: () => ({}),
  },
}));

const API_DIR = join(__dirname, "..", "api");
const tsModules = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    : [];

/** `strapi.apis` as Strapi holds it: api name → router name → router. */
async function loadApis(): Promise<
  Record<string, { routes: Record<string, { routes: Route[] }> }>
> {
  const apis: Record<string, { routes: Record<string, { routes: Route[] }> }> = {};
  for (const api of readdirSync(API_DIR)) {
    const routesDir = join(API_DIR, api, "routes");
    const routers: Record<string, { routes: Route[] }> = {};
    for (const file of tsModules(routesDir)) {
      const mod = await import(join(routesDir, file));
      // A fresh copy per load: the decoration mutates the route objects.
      routers[file.replace(/\.ts$/, "")] = structuredClone(mod.default);
    }
    apis[api] = { routes: routers };
  }
  return apis;
}

const policiesOf = (route: Route) => route.config?.policies ?? [];
const switchSpecs = (route: Route) =>
  policiesOf(route).filter(
    (spec) =>
      typeof spec === "object" &&
      spec !== null &&
      [MODULE_POLICY, FEATURE_POLICY].includes((spec as { name: string }).name),
  ) as { name: string; config: Record<string, string> }[];

afterEach(() => {
  delete process.env.FEATURES_OFF;
});

describe("decorateSwitchedRoutes over every router of src/api", () => {
  it("puts the module policy in front of every route of a module's APIs, and only there", async () => {
    const apis = await loadApis();
    const apiModule = new Map(
      Object.entries(MODULE_APIS).flatMap(([module, names]) => names.map((api) => [api, module])),
    );
    for (const name of apiModule.keys()) expect(Object.keys(apis), name).toContain(name);

    const decorated = decorateSwitchedRoutes({ apis });
    expect(decorated).toBeGreaterThan(40);

    const failures: string[] = [];
    for (const [api, { routes }] of Object.entries(apis)) {
      for (const router of Object.values(routes)) {
        for (const route of router.routes) {
          const module = HANDLER_MODULE[route.handler] ?? apiModule.get(api);
          const feature = HANDLER_FEATURE[route.handler];
          const expected = [
            ...(module ? [{ name: MODULE_POLICY, config: { module } }] : []),
            ...(feature ? [{ name: FEATURE_POLICY, config: { feature } }] : []),
          ];
          // In front, exactly once each, so their 404 comes before any other policy.
          const front = policiesOf(route).slice(0, expected.length);
          if (
            JSON.stringify(switchSpecs(route)) !== JSON.stringify(expected) ||
            JSON.stringify(front) !== JSON.stringify(expected)
          ) {
            failures.push(`${route.handler}: ${JSON.stringify(policiesOf(route))}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("names only handlers that exist (no stale keys)", async () => {
    const apis = await loadApis();
    const handlers = new Set(
      Object.values(apis).flatMap(({ routes }) =>
        Object.values(routes).flatMap((router) => router.routes.map((route) => route.handler)),
      ),
    );
    for (const handler of [...Object.keys(HANDLER_MODULE), ...Object.keys(HANDLER_FEATURE)]) {
      expect(handlers, handler).toContain(handler);
    }
  });

  it("covers the routes the plan names: ICS, summary, results, player, reports, celebrations", async () => {
    const apis = await loadApis();
    decorateSwitchedRoutes({ apis });
    const byHandler = new Map(
      Object.values(apis).flatMap(({ routes }) =>
        Object.values(routes).flatMap((router) =>
          router.routes.map((route) => [route.handler, route]),
        ),
      ),
    );
    const moduleOf = (handler: string) => switchSpecs(byHandler.get(handler)!)[0]?.config;
    const gatesOf = (handler: string) => switchSpecs(byHandler.get(handler)!).map((s) => s.config);
    expect(moduleOf("api::event.event.ics")).toEqual({ module: "events" });
    expect(moduleOf("api::event-rsvp.event-rsvp.summary")).toEqual({ module: "events" });
    expect(moduleOf("api::poll.poll.batchResults")).toEqual({ module: "polls" });
    expect(moduleOf("api::poll-vote.poll-vote.vote")).toEqual({ module: "polls" });
    expect(moduleOf("api::lesson.lesson.player")).toEqual({ module: "training" });
    expect(moduleOf("api::lesson.lesson.check")).toEqual({ module: "training" });
    // The report routes: the training module, then the training-reports feature.
    for (const handler of ["api::course.course.report", "api::course.course.reportCourse"]) {
      expect(gatesOf(handler)).toEqual([{ module: "training" }, { feature: "training-reports" }]);
    }
    expect(moduleOf("api::kudos.kudos.celebrations")).toEqual({ module: "celebrations" });
    expect(moduleOf("api::kudos.kudos.find")).toEqual({ module: "kudos" });
    expect(moduleOf("api::classified.classified.find")).toEqual({ module: "marketplace" });
    expect(moduleOf("api::acknowledgement.acknowledgement.create")).toEqual({
      feature: "read-confirmations",
    });
    expect(moduleOf("api::search-log.search-log.summary")).toEqual({ feature: "search-logging" });
    expect(moduleOf("api::search-log.search-log.create")).toBeUndefined();
    expect(moduleOf("api::announcement.announcement.find")).toBeUndefined();
  });

  it("decorates once, however often it runs", async () => {
    const apis = await loadApis();
    decorateSwitchedRoutes({ apis });
    decorateSwitchedRoutes({ apis });
    const route = apis.event.routes.event.routes.find(
      (r) => r.handler === "api::event.event.find",
    )!;
    expect(switchSpecs(route)).toHaveLength(1);
  });

  it("refuses a router it cannot walk, and a host without apis", () => {
    expect(() =>
      decorateSwitchedRoutes({ apis: { event: { routes: { x: () => ({}) } } } }),
    ).toThrow(/\[switches\] api::event router x/);
    expect(() =>
      decorateSwitchedRoutes({ apis: undefined as unknown as Record<string, never> }),
    ).toThrow(/strapi\.apis not found/);
  });
});

describe("the switch policies", () => {
  it("pass while on and answer 404 while off, whoever calls", () => {
    expect(moduleEnabled({}, { module: "events" })).toBe(true);
    expect(featureEnabled({}, { feature: "search-logging" })).toBe(true);
    process.env.FEATURES_OFF = "events,search-logging";
    expect(() => moduleEnabled({}, { module: "events" })).toThrow(errors.NotFoundError);
    expect(moduleEnabled({}, { module: "polls" })).toBe(true);
    expect(() => featureEnabled({}, { feature: "search-logging" })).toThrow(errors.NotFoundError);
    expect(featureEnabled({}, { feature: "read-confirmations" })).toBe(true);
  });

  it("closes training-reports with training", () => {
    process.env.FEATURES_OFF = "training";
    expect(() => featureEnabled({}, { feature: "training-reports" })).toThrow(errors.NotFoundError);
  });

  it("refuses without a known name in the config (fail closed)", () => {
    expect(moduleEnabled({}, undefined)).toBe(false);
    expect(moduleEnabled({}, { module: "wiki" })).toBe(false);
    expect(featureEnabled({}, { feature: "events" })).toBe(false);
  });
});

describe("moduleOfUid / isUidOff / switchesStatusLine", () => {
  it("maps content types to their module; base types have none", () => {
    expect(moduleOfUid("api::event.event")).toBe("events");
    expect(moduleOfUid("api::lesson-progress.lesson-progress")).toBe("training");
    expect(moduleOfUid("api::announcement.announcement")).toBeNull();
    expect(moduleOfUid("plugin::users-permissions.user")).toBeNull();
    expect(isUidOff("api::course.course", { FEATURES_OFF: "training" })).toBe(true);
    expect(isUidOff("api::course.course", {})).toBe(false);
    expect(isUidOff("api::document.document", { FEATURES_OFF: "training" })).toBe(false);
  });

  it("names what is off, and refuses an unknown value", () => {
    expect(switchesStatusLine({})).toBe("[switches] everything on");
    expect(switchesStatusLine({ FEATURES_OFF: "polls,events" })).toBe(
      "[switches] off: events, polls",
    );
    expect(() => switchesStatusLine({ FEATURES_OFF: "event" })).toThrow(/unknown value "event"/);
  });
});
