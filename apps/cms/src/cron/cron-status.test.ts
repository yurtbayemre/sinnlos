import { describe, expect, it, vi } from "vitest";

import {
  everyMinutes,
  recordCronRun,
  recordExpectedCronTasks,
  UNCHANGED_OK_WRITE_MS,
  type CronStatusState,
  type CronStatusStrapi,
} from "./cron-status";
import { cronRegistry, guardedTask, type CronStrapi } from "./registry";
import { reportRunFailure } from "./run-context";

/** An in-memory core store, keyed like Strapi's (`plugin_sinnlos_<key>`). */
function fakeStore() {
  const rows = new Map<string, unknown>();
  const sets = vi.fn();
  const strapi: CronStatusStrapi = {
    store: ({ type, name, key }) => {
      const k = `${type}_${name}_${key}`;
      return {
        get: async () => (rows.has(k) ? structuredClone(rows.get(k)) : null),
        set: async ({ value }) => {
          sets(k, value);
          rows.set(k, structuredClone(value));
        },
      };
    },
  };
  return { strapi, rows, sets };
}

const MIN = 60_000;
const spec = { name: "scheduled-publisher", rule: "* * * * *" };

describe("everyMinutes", () => {
  it("knows every rule of the registry", () => {
    for (const task of cronRegistry("UTC", { MEILISEARCH_ENABLED: "1" })) {
      expect([1, 1440]).toContain(everyMinutes(task.rule));
    }
    expect(everyMinutes("0 7 * * 1")).toBe(10080);
  });

  it("refuses a rule it cannot place", () => {
    expect(() => everyMinutes("*/5 * * * *")).toThrow(/no interval/);
    expect(() => everyMinutes("0 7 1 * *")).toThrow(/no interval/);
  });
});

describe("recordCronRun", () => {
  it("writes the first run, then an unchanged success only every ten minutes", async () => {
    const { strapi, rows, sets } = fakeStore();
    const state: CronStatusState = new Map();
    await recordCronRun(strapi, spec, "ok", 0, 1_000, state);
    await recordCronRun(strapi, spec, "ok", MIN, MIN + 1_000, state);
    await recordCronRun(strapi, spec, "ok", 9 * MIN, 9 * MIN + 500, state);
    expect(sets).toHaveBeenCalledTimes(1);
    await recordCronRun(strapi, spec, "ok", 10 * MIN, UNCHANGED_OK_WRITE_MS + 1_000, state);
    expect(sets).toHaveBeenCalledTimes(2);
    expect(rows.get("plugin_sinnlos_cron:scheduled-publisher")).toEqual({
      lastStartedAt: new Date(10 * MIN).toISOString(),
      lastFinishedAt: new Date(UNCHANGED_OK_WRITE_MS + 1_000).toISOString(),
      lastOutcome: "ok",
      lastFailedAt: null,
      everyMinutes: 1,
    });
  });

  it("writes a failure at once and the recovery at once, and keeps lastFailedAt", async () => {
    const { strapi, rows, sets } = fakeStore();
    const state: CronStatusState = new Map();
    await recordCronRun(strapi, spec, "ok", 0, 1_000, state);
    await recordCronRun(strapi, spec, "failed", MIN, MIN + 1_000, state);
    await recordCronRun(strapi, spec, "failed", 2 * MIN, 2 * MIN + 1_000, state);
    await recordCronRun(strapi, spec, "ok", 3 * MIN, 3 * MIN + 1_000, state);
    expect(sets).toHaveBeenCalledTimes(4);
    const stored = rows.get("plugin_sinnlos_cron:scheduled-publisher") as Record<string, unknown>;
    expect(stored.lastOutcome).toBe("ok");
    expect(stored.lastFailedAt).toBe(new Date(2 * MIN + 1_000).toISOString());
  });

  it("reads the stored status once after a restart, keeping its lastFailedAt", async () => {
    const { strapi, rows } = fakeStore();
    rows.set("plugin_sinnlos_cron:scheduled-publisher", {
      lastStartedAt: new Date(0).toISOString(),
      lastFinishedAt: new Date(1_000).toISOString(),
      lastOutcome: "failed",
      lastFailedAt: new Date(1_000).toISOString(),
      everyMinutes: 1,
    });
    await recordCronRun(strapi, spec, "ok", MIN, MIN + 1_000, new Map());
    const stored = rows.get("plugin_sinnlos_cron:scheduled-publisher") as Record<string, unknown>;
    expect(stored).toMatchObject({
      lastOutcome: "ok",
      lastFailedAt: new Date(1_000).toISOString(),
    });
  });

  it("is a no-op without a core store (test doubles)", async () => {
    await expect(recordCronRun({}, spec, "failed", 0, 1, new Map())).resolves.toBeUndefined();
  });
});

describe("recordExpectedCronTasks", () => {
  const specs = [
    { name: "scheduled-publisher", rule: "* * * * *" },
    { name: "digest-mailer", rule: "30 7 * * *" },
  ];
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 24) + minutes * MIN);

  it("keeps the first-expected time across restarts, new and dropped tasks aside", async () => {
    const { strapi, rows } = fakeStore();
    await recordExpectedCronTasks(strapi, specs, true, at(0));
    await recordExpectedCronTasks(
      strapi,
      [specs[1]!, { name: "search-index", rule: "* * * * *" }],
      true,
      at(60),
    );
    expect(rows.get("plugin_sinnlos_cron:expected")).toEqual({
      bootedAt: at(60).toISOString(),
      cronEnabled: true,
      tasks: [
        { name: "digest-mailer", everyMinutes: 1440, firstExpectedAt: at(0).toISOString() },
        { name: "search-index", everyMinutes: 1, firstExpectedAt: at(60).toISOString() },
      ],
    });
  });

  it("expects nothing with CRON_ENABLED off; switching back on starts a fresh grace", async () => {
    const { strapi, rows } = fakeStore();
    await recordExpectedCronTasks(strapi, specs, true, at(0));
    await recordExpectedCronTasks(strapi, specs, false, at(10));
    expect(rows.get("plugin_sinnlos_cron:expected")).toEqual({
      bootedAt: at(10).toISOString(),
      cronEnabled: false,
      tasks: [],
    });
    await recordExpectedCronTasks(strapi, specs, true, at(20));
    const value = rows.get("plugin_sinnlos_cron:expected") as {
      tasks: { firstExpectedAt: string }[];
    };
    expect(value.tasks.map((t) => t.firstExpectedAt)).toEqual([
      at(20).toISOString(),
      at(20).toISOString(),
    ]);
  });
});

describe("guardedTask records the outcome", () => {
  function cronStrapi() {
    const { strapi, rows } = fakeStore();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return { strapi: { ...strapi, log } as unknown as CronStrapi, rows, log };
  }
  const outcomeOf = (rows: Map<string, unknown>, name: string) =>
    (rows.get(`plugin_sinnlos_cron:${name}`) as { lastOutcome?: string } | undefined)?.lastOutcome;

  it("records a swallowed failure the task reported", async () => {
    const { strapi, rows } = cronStrapi();
    const task = guardedTask({
      name: "a11y-swallow",
      rule: "20 3 * * *",
      tz: "UTC",
      fn: async () => reportRunFailure(new Error("one row failed")),
    });
    await task({ strapi });
    expect(outcomeOf(rows, "a11y-swallow")).toBe("failed");
  });

  it("records a throwing task as failed and a clean one as ok", async () => {
    const { strapi, rows } = cronStrapi();
    await guardedTask({
      name: "throws",
      rule: "20 3 * * *",
      tz: "UTC",
      fn: async () => {
        throw new Error("db gone");
      },
    })({ strapi });
    await guardedTask({ name: "clean", rule: "20 3 * * *", tz: "UTC", fn: async () => {} })({
      strapi,
    });
    expect(outcomeOf(rows, "throws")).toBe("failed");
    expect(outcomeOf(rows, "clean")).toBe("ok");
  });

  it("logs a failed write and releases the guard", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const strapi = {
      log,
      store: () => ({
        get: async () => null,
        set: async () => {
          throw new Error("db locked");
        },
      }),
    } as unknown as CronStrapi;
    const fn = vi.fn(async () => {});
    const task = guardedTask({ name: "write-fails", rule: "20 3 * * *", tz: "UTC", fn });
    await task({ strapi });
    await task({ strapi });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith(
      "[cron] write-fails: recording the outcome failed: db locked",
    );
  });
});
