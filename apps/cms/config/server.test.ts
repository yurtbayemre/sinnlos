import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import serverConfig from "./server";

/**
 * Pins FX11: Strapi 5.49 builds its Koa app with
 * `proxy: strapi.config.get('server.proxy.koa')` (@strapi/core
 * dist/services/server/index.js:23). The v4 form `proxy: true` has no `koa`
 * key, so X-Forwarded-For was ignored and every local sign-in shared the web
 * container's throttle bucket (verified on a booted 5.49: a second client IP
 * got 429 with `proxy: true`, its own bucket with `proxy: { koa: true }`).
 *
 * And the cron wiring (LF03): the tasks of src/cron/registry.ts
 * (registry.test.ts tests the table and the wrapper on their own), run
 * through Strapi's own cron service and provider: their wall-clock times in
 * APP_TIME_ZONE, CRON_ENABLED, and the overlap guard under the real service.
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

type Tasks = ReturnType<typeof serverConfig>["cron"]["tasks"];

/** The slice of @strapi/core's cron service (dist/services/cron.js) used here. */
interface CronService {
  add(tasks: Record<string, unknown>): CronService;
  start(): CronService;
  destroy(): CronService;
  readonly jobs: {
    name: string | null;
    job: { nextInvocation(): Date | null; invoke(): Promise<void> };
  }[];
}

/** The slice of the Strapi instance @strapi/core's cron provider touches. */
interface ProviderHost {
  config: { get(path: string, fallback?: unknown): unknown };
  add(name: string, factory: () => unknown): void;
  get(name: string): unknown;
}

/** @strapi/core's cron provider (dist/providers/cron.js). */
interface CronProvider {
  init(strapi: ProviderHost): void;
  bootstrap(strapi: ProviderHost): Promise<void>;
  destroy(strapi: ProviderHost): Promise<void>;
}

/**
 * A module of the installed @strapi/core, loaded by file path (the package
 * exports only its entry point).
 */
function loadStrapiCore<T>(...path: string[]): T {
  const requireFromCms = createRequire(join(__dirname, "..", "package.json"));
  const requireFromStrapi = createRequire(requireFromCms.resolve("@strapi/strapi/package.json"));
  const coreDir = dirname(requireFromStrapi.resolve("@strapi/core/package.json"));
  return requireFromStrapi(join(coreDir, "dist", ...path)) as T;
}

/**
 * Strapi's own cron service. Since 5.54 it runs on croner instead of
 * node-schedule, and a schedule it cannot parse is only logged (`Could not
 * schedule cron job …`) while the boot carries on.
 */
const loadStrapiCronService = () => loadStrapiCore<() => CronService>("services", "cron.js");

/** HH:mm of an instant on the wall clock of a zone. */
const wallClock = (timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

/**
 * Runs `body` with the global `strapi` the cron service logs through (and
 * hands to every task) set to a stand-in with log spies.
 */
async function withGlobalStrapi<T>(
  body: (log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  }) => Promise<T> | T,
): Promise<T> {
  const scope = globalThis as unknown as { strapi?: unknown };
  const previous = scope.strapi;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  scope.strapi = { log };
  try {
    return await body(log);
  } finally {
    scope.strapi = previous;
  }
}

/**
 * Registers the tasks in Strapi's real cron service and asserts each next
 * run falls on its rule's wall-clock time in the given zone.
 */
async function expectScheduledAt(tasks: Tasks, timeZone: string) {
  await withGlobalStrapi((log) => {
    const cron = loadStrapiCronService()();
    try {
      cron.add(tasks);
      expect(log.error.mock.calls).toEqual([]);
      expect(cron.jobs.map(({ name }) => name).sort()).toEqual(Object.keys(tasks).sort());
      for (const [name, { options }] of Object.entries(tasks)) {
        expect(options.tz, name).toBe(timeZone);
        const [minute, hour] = options.rule.split(" ");
        const next = cron.jobs.find((spec) => spec.name === name)?.job.nextInvocation();
        expect(next, name).toBeInstanceOf(Date);
        expect(wallClock(timeZone).format(next as Date), name).toBe(
          `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`,
        );
      }
    } finally {
      cron.destroy();
    }
  });
}

/**
 * Boots @strapi/core's cron provider on the given config (init, bootstrap)
 * and returns the names of the jobs it scheduled, then destroys it.
 */
async function scheduledByProvider(config: ReturnType<typeof serverConfig>): Promise<string[]> {
  const provider = loadStrapiCore<CronProvider>("providers", "cron.js");
  return withGlobalStrapi(async () => {
    const services = new Map<string, unknown>();
    const values: Record<string, unknown> = {
      "server.cron.enabled": config.cron.enabled,
      "server.cron.tasks": config.cron.tasks,
    };
    const host: ProviderHost = {
      config: { get: (path, fallback) => (path in values ? values[path] : fallback) },
      add: (name, factory) => {
        services.set(name, factory());
      },
      get: (name) => services.get(name),
    };
    provider.init(host);
    await provider.bootstrap(host);
    try {
      return (host.get("cron") as CronService).jobs.map(({ name }) => String(name));
    } finally {
      await provider.destroy(host);
    }
  });
}

describe("config/server", () => {
  it("trusts the proxy headers under the key Strapi 5 reads (server.proxy.koa)", () => {
    const config = serverConfig({ env: makeEnv() });
    expect(config.proxy).toEqual({ koa: true });
  });

  it("builds the cron tasks from the registry (names, rules, zone)", () => {
    const { tasks } = serverConfig({ env: makeEnv() }).cron;
    expect(Object.entries(tasks).map(([name, { options }]) => ({ name, ...options }))).toEqual([
      { name: "uploads-janitor", rule: "30 3 * * *", tz: "Europe/Berlin" },
      { name: "search-log-janitor", rule: "35 3 * * *", tz: "Europe/Berlin" },
      { name: "digest-mailer", rule: "30 7 * * *", tz: "Europe/Berlin" },
    ]);
  });

  it("schedules every cron task at its wall-clock time in the default zone, Europe/Berlin", async () => {
    await expectScheduledAt(serverConfig({ env: makeEnv() }).cron.tasks, "Europe/Berlin");
  });

  it("schedules every cron task in APP_TIME_ZONE (datetime contract)", async () => {
    const { tasks } = serverConfig({ env: makeEnv({ APP_TIME_ZONE: "America/New_York" }) }).cron;
    await expectScheduledAt(tasks, "America/New_York");
  });

  it("refuses an empty or unknown APP_TIME_ZONE at config load", () => {
    expect(() => serverConfig({ env: makeEnv({ APP_TIME_ZONE: "" }) })).toThrow(/APP_TIME_ZONE/);
    expect(() => serverConfig({ env: makeEnv({ APP_TIME_ZONE: "Berlin" }) })).toThrow(/IANA/);
  });
});

describe("CRON_ENABLED through @strapi/core's cron provider", () => {
  it("schedules every task when unset or on", async () => {
    for (const store of [
      {},
      { CRON_ENABLED: "" },
      { CRON_ENABLED: "1" },
      { CRON_ENABLED: "true" },
    ]) {
      const config = serverConfig({ env: makeEnv(store) });
      expect(config.cron.enabled, JSON.stringify(store)).toBe(true);
      expect(await scheduledByProvider(config), JSON.stringify(store)).toEqual([
        "uploads-janitor",
        "search-log-janitor",
        "digest-mailer",
      ]);
    }
  });

  it("schedules no task when off", async () => {
    for (const value of ["0", "false", "no", "off"]) {
      const config = serverConfig({ env: makeEnv({ CRON_ENABLED: value }) });
      expect(config.cron.enabled, value).toBe(false);
      expect(await scheduledByProvider(config), value).toEqual([]);
    }
  });
});

describe("the overlap guard under Strapi's cron service", () => {
  it("skips an invoke while the same task is still running, and logs the duration", async () => {
    const { tasks } = serverConfig({ env: makeEnv() }).cron;
    await withGlobalStrapi(async (log) => {
      const cron = loadStrapiCronService()();
      try {
        cron.add(tasks);
        const job = cron.jobs.find(({ name }) => name === "search-log-janitor")?.job;
        expect(job).toBeDefined();
        // The janitor's db call never settles until released: the first run
        // stays in flight while the second one arrives.
        let release!: () => void;
        const pending = new Promise<number>((resolve) => {
          release = () => resolve(0);
        });
        const del = vi.fn(() => pending);
        const scope = globalThis as unknown as { strapi: Record<string, unknown> };
        scope.strapi.db = { connection: () => ({ where: () => ({ del }) }) };

        const first = job!.invoke();
        await job!.invoke();
        expect(del).toHaveBeenCalledTimes(1);
        expect(log.warn).toHaveBeenCalledWith(
          "[cron] search-log-janitor skipped: the previous run is still in progress",
        );
        release();
        await first;
        expect(log.info.mock.calls.map(([line]) => String(line))).toEqual([
          expect.stringMatching(/^\[cron\] search-log-janitor took \d+ms$/),
        ]);
      } finally {
        cron.destroy();
      }
    });
  });
});
