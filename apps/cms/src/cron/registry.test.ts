import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildCronTasks,
  cronEnabled,
  cronRegistry,
  guardedTask,
  type CronStrapi,
  type CronTaskSpec,
} from "./registry";

/**
 * LF03: the task table, the CRON_ENABLED switch and the wrapper every task
 * runs through (duration line, error line, in-process overlap guard).
 * config/server.test.ts runs the built tasks through Strapi's own cron
 * service and provider.
 */

/** A Strapi stand-in with log spies; the tasks under test never touch db. */
function fakeStrapi() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const strapi = { log } as unknown as CronStrapi;
  return { strapi, log };
}

/** A promise and the handle that resolves it. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const spec = (fn: CronTaskSpec["fn"]): CronTaskSpec => ({
  name: "test-task",
  rule: "0 4 * * *",
  tz: "Europe/Berlin",
  fn,
});

describe("cronRegistry", () => {
  it("lists the three tasks with their rules, all in the given zone", () => {
    const table = cronRegistry("Pacific/Auckland").map(({ name, rule, tz }) => ({
      name,
      rule,
      tz,
    }));
    expect(table).toEqual([
      { name: "uploads-janitor", rule: "30 3 * * *", tz: "Pacific/Auckland" },
      { name: "search-log-janitor", rule: "35 3 * * *", tz: "Pacific/Auckland" },
      { name: "digest-mailer", rule: "30 7 * * *", tz: "Pacific/Auckland" },
    ]);
  });

  it("runs the janitors after the 03:00 host backup, and every task once a day", () => {
    for (const { name, rule } of cronRegistry("Europe/Berlin")) {
      const [minute, hour, ...rest] = rule.split(" ");
      expect(rest, name).toEqual(["*", "*", "*"]);
      const minutes = Number(hour) * 60 + Number(minute);
      // 03:00 is pg-backup.sh in the host crontab (docs/DEPLOYMENT.md §7.3);
      // anything it deletes must still be in that night's backup.
      if (name.endsWith("-janitor")) {
        expect(minutes, name).toBeGreaterThan(3 * 60);
        expect(minutes, name).toBeLessThan(4 * 60);
      }
    }
  });

  it("is pure: two calls give equal tables and share no state", () => {
    const a = cronRegistry("Europe/Berlin");
    const b = cronRegistry("Europe/Berlin");
    expect(a).not.toBe(b);
    expect(a.map(({ name, rule, tz }) => [name, rule, tz])).toEqual(
      b.map(({ name, rule, tz }) => [name, rule, tz]),
    );
  });
});

describe("cronEnabled (CRON_ENABLED)", () => {
  it.each([
    [undefined, true],
    ["", true],
    ["  ", true],
    ["1", true],
    ["true", true],
    [" TRUE ", true],
    ["yes", true],
    ["on", true],
    ["0", false],
    ["false", false],
    ["no", false],
    ["off", false],
    ["OFF", false],
    ["disabled", false],
  ])("%j -> %s", (value, expected) => {
    expect(cronEnabled(value)).toBe(expected);
  });
});

describe("CRON_ENABLED as compose and the env examples hand it over (lanes 5A and 5B)", () => {
  const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
  const read = (...parts: string[]) =>
    readFileSync(join(REPO_ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

  it("switches the crons on with compose's default and the examples' value", () => {
    // `${CRON_ENABLED:-<default>}`: compose hands over the default for an
    // unset and for an empty value alike.
    const fallback = /^ +CRON_ENABLED: \$\{CRON_ENABLED:-([^}]*)\}$/m.exec(
      read("infra", "docker-compose.yml"),
    )?.[1];
    expect(fallback).toBe("true");
    expect(cronEnabled(fallback)).toBe(true);
    for (const file of [
      ["infra", ".env.example"],
      ["apps", "cms", ".env.example"],
    ]) {
      const value = /^CRON_ENABLED=(.*)$/m.exec(read(...file))?.[1];
      expect(value, file.join("/")).toBeDefined();
      expect(cronEnabled(value), file.join("/")).toBe(true);
    }
  });

  it("switches them off with every value the examples document as off", () => {
    for (const file of [
      ["infra", ".env.example"],
      ["apps", "cms", ".env.example"],
    ]) {
      expect(read(...file), file.join("/")).toContain("false (also 0/no/off)");
    }
    for (const value of ["false", "0", "no", "off"]) {
      expect(cronEnabled(value), value).toBe(false);
    }
  });
});

describe("guardedTask", () => {
  it("logs the duration of a run", async () => {
    const { strapi, log } = fakeStrapi();
    let now = 1_000;
    const task = guardedTask(
      spec(async () => {
        now += 250;
      }),
      () => now,
    );
    await task({ strapi });
    expect(log.info).toHaveBeenCalledWith("[cron] test-task took 250ms");
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("passes the Strapi instance to the task", async () => {
    const { strapi } = fakeStrapi();
    const fn = vi.fn(async () => {});
    await guardedTask(spec(fn))({ strapi });
    expect(fn).toHaveBeenCalledWith(strapi);
  });

  it("logs a failing run with its duration and does not throw", async () => {
    const { strapi, log } = fakeStrapi();
    let now = 0;
    const task = guardedTask(
      spec(async () => {
        now += 40;
        throw new Error("db gone");
      }),
      () => now,
    );
    await expect(task({ strapi })).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith("[cron] test-task failed after 40ms: db gone");
    expect(log.info).not.toHaveBeenCalled();
  });

  it("logs a non-Error rejection as text", async () => {
    const { strapi, log } = fakeStrapi();
    const task = guardedTask(
      spec(() => Promise.reject("plain string")),
      () => 0,
    );
    await task({ strapi });
    expect(log.error).toHaveBeenCalledWith("[cron] test-task failed after 0ms: plain string");
  });

  it("skips a run while the previous one is still in flight, and runs again afterwards", async () => {
    const { strapi, log } = fakeStrapi();
    const gate = deferred();
    const fn = vi.fn(() => gate.promise);
    const task = guardedTask(spec(fn), () => 0);

    const first = task({ strapi });
    await task({ strapi });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "[cron] test-task skipped: the previous run is still in progress",
    );

    gate.resolve();
    await first;
    expect(log.info).toHaveBeenCalledTimes(1);

    fn.mockImplementation(async () => {});
    await task({ strapi });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("releases the guard after a failed run", async () => {
    const { strapi, log } = fakeStrapi();
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    const task = guardedTask(spec(fn), () => 0);
    await task({ strapi });
    await task({ strapi });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it("guards each task on its own", async () => {
    const { strapi, log } = fakeStrapi();
    const gate = deferred();
    const tasks = buildCronTasks([
      { ...spec(() => gate.promise), name: "slow" },
      { ...spec(async () => {}), name: "fast" },
    ]);
    const slow = tasks.slow.task({ strapi });
    await tasks.fast.task({ strapi });
    expect(log.warn).not.toHaveBeenCalled();
    gate.resolve();
    await slow;
    expect(log.info.mock.calls.map(([line]) => String(line).replace(/\d+ms$/, "Nms"))).toEqual([
      "[cron] fast took Nms",
      "[cron] slow took Nms",
    ]);
  });
});

describe("buildCronTasks", () => {
  it("keys the tasks by name, with Strapi's rule/tz options", () => {
    const tasks = buildCronTasks(cronRegistry("Europe/Berlin"));
    expect(Object.keys(tasks)).toEqual(["uploads-janitor", "search-log-janitor", "digest-mailer"]);
    for (const [name, { task, options }] of Object.entries(tasks)) {
      expect(typeof task, name).toBe("function");
      expect(Object.keys(options).sort(), name).toEqual(["rule", "tz"]);
      expect(options.tz, name).toBe("Europe/Berlin");
    }
  });

  it("refuses two tasks with one name", () => {
    const one = spec(async () => {});
    expect(() => buildCronTasks([one, { ...one }])).toThrow(/duplicate task name "test-task"/);
  });

  it("gives every build its own guard state", async () => {
    const { strapi, log } = fakeStrapi();
    const gate = deferred();
    const specs = [spec(() => gate.promise)];
    const a = buildCronTasks(specs);
    const b = buildCronTasks(specs);
    const runs = [a["test-task"].task({ strapi }), b["test-task"].task({ strapi })];
    expect(log.warn).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all(runs);
    expect(log.info).toHaveBeenCalledTimes(2);
  });
});
