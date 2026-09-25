import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import serverConfig from "./server";

/**
 * Pins FX11: Strapi 5.49 builds its Koa app with
 * `proxy: strapi.config.get('server.proxy.koa')` (@strapi/core
 * dist/services/server/index.js:23). The v4 form `proxy: true` has no `koa`
 * key, so X-Forwarded-For was ignored and every local sign-in shared the web
 * container's throttle bucket (verified on a booted 5.49: a second client IP
 * got 429 with `proxy: true`, its own bucket with `proxy: { koa: true }`).
 */
type EnvStore = Record<string, string>;

/** Minimal stand-in for Strapi's env helper (only what server.ts uses). */
const makeEnv = (store: EnvStore = {}) => {
  const env = (key: string, def?: unknown) => store[key] ?? def;
  env.int = (key: string, def?: number) =>
    key in store ? parseInt(store[key], 10) : (def as number);
  env.bool = (key: string, def?: boolean) =>
    key in store ? store[key] === "true" : (def as boolean);
  env.array = (key: string, def?: string[]) =>
    key in store ? store[key].split(",") : (def as string[]);
  return env;
};

/** The slice of @strapi/core's cron service (dist/services/cron.js) used here. */
interface CronService {
  add(tasks: Record<string, unknown>): CronService;
  destroy(): CronService;
  readonly jobs: { name: string | null; job: { nextInvocation(): Date | null } }[];
}

/**
 * Strapi's own cron service from the installed @strapi/core, loaded by file
 * path (the package exports only its entry point). Since 5.54 it runs on
 * croner instead of node-schedule, and a schedule it cannot parse is only
 * logged (`Could not schedule cron job …`) while the boot carries on.
 */
function loadStrapiCronService(): () => CronService {
  const requireFromCms = createRequire(join(__dirname, "..", "package.json"));
  const requireFromStrapi = createRequire(requireFromCms.resolve("@strapi/strapi/package.json"));
  const coreDir = dirname(requireFromStrapi.resolve("@strapi/core/package.json"));
  return requireFromStrapi(join(coreDir, "dist", "services", "cron.js")) as () => CronService;
}

const berlinClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

describe("config/server", () => {
  it("trusts the proxy headers under the key Strapi 5 reads (server.proxy.koa)", () => {
    const config = serverConfig({ env: makeEnv() });
    expect(config.proxy).toEqual({ koa: true });
  });

  it("schedules every cron task in Strapi's cron service at its Europe/Berlin wall-clock time", () => {
    const { tasks } = serverConfig({ env: makeEnv() }).cron;
    const errors: unknown[] = [];
    const scope = globalThis as unknown as { strapi?: unknown };
    const previous = scope.strapi;
    // The service reports an unparseable schedule through the global logger.
    scope.strapi = { log: { error: (...args: unknown[]) => errors.push(args) } };
    const cron = loadStrapiCronService()();
    try {
      cron.add(tasks);
      expect(errors).toEqual([]);
      expect(cron.jobs.map(({ name }) => name).sort()).toEqual(Object.keys(tasks).sort());
      for (const [name, { options }] of Object.entries(tasks)) {
        const [minute, hour] = options.rule.split(" ");
        const next = cron.jobs.find((spec) => spec.name === name)?.job.nextInvocation();
        expect(next, name).toBeInstanceOf(Date);
        expect(berlinClock.format(next as Date), name).toBe(
          `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`,
        );
      }
    } finally {
      cron.destroy();
      scope.strapi = previous;
    }
  });
});
