import { describe, expect, it, vi } from "vitest";

import { afterCommit } from "../utils/after-commit";
import { reportRunFailure, runCronTask, trackRunWork } from "./run-context";

/**
 * v0.29 S8: the run context of a cron task. What the task's code swallows
 * reaches the run; work after a commit is waited for; nothing outside a
 * run is touched.
 */

const log = () => ({ error: vi.fn() });

describe("reportRunFailure", () => {
  it("does nothing outside a run (an HTTP request)", () => {
    expect(() => reportRunFailure(new Error("x"))).not.toThrow();
  });

  it("marks the run failed and logs the one grep-able line", async () => {
    const l = log();
    const run = await runCronTask("digest-mailer", l, async () => {
      reportRunFailure(new Error("smtp down"));
      reportRunFailure(null, "2 digest(s) not sent");
    });
    expect(run.failed).toBe(true);
    expect(l.error.mock.calls).toEqual([
      ["[cron] digest-mailer failed: smtp down"],
      ["[cron] digest-mailer failed: 2 digest(s) not sent"],
    ]);
  });

  it("keeps runs that overlap apart", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = runCronTask("a", log(), async () => {
      await gate;
      reportRunFailure(new Error("a broke"));
    });
    const b = runCronTask("b", log(), async () => {
      await gate;
    });
    release();
    expect(await a).toEqual({ failed: true });
    expect(await b).toEqual({ failed: false });
  });
});

describe("trackRunWork", () => {
  it("returns the work unchanged outside a run", async () => {
    await expect(trackRunWork(Promise.resolve(7))).resolves.toBe(7);
  });

  it("makes the run wait for tracked work, including work that work tracked", async () => {
    const order: string[] = [];
    const run = await runCronTask("t", log(), async () => {
      void trackRunWork(
        (async () => {
          await new Promise((r) => setTimeout(r, 5));
          order.push("first");
          void trackRunWork(
            (async () => {
              await new Promise((r) => setTimeout(r, 5));
              order.push("second");
            })(),
          );
        })(),
      );
      order.push("task done");
    });
    order.push("run done");
    expect(order).toEqual(["task done", "first", "second", "run done"]);
    expect(run.failed).toBe(false);
  });

  it("counts a rejected tracked promise as a failure", async () => {
    const l = log();
    const run = await runCronTask("t", l, async () => {
      void trackRunWork(Promise.reject(new Error("late"))).catch(() => undefined);
    });
    expect(run.failed).toBe(true);
    expect(l.error).toHaveBeenCalledWith("[cron] t failed: late");
  });

  it("rejects with the task's error, but only after the tracked work settled", async () => {
    let settled = false;
    const run = runCronTask("t", log(), async () => {
      void trackRunWork(
        new Promise<void>((r) =>
          setTimeout(() => {
            settled = true;
            r();
          }, 5),
        ),
      );
      throw new Error("task broke");
    });
    await expect(run).rejects.toThrow("task broke");
    expect(settled).toBe(true);
  });
});

describe("afterCommit inside a run", () => {
  /** A db double: one open transaction whose commit the test triggers. */
  function fakeDb() {
    const commits: (() => unknown)[] = [];
    const db = {
      inTransaction: () => true,
      transaction: async (cb: (scope: { onCommit: (fn: () => unknown) => void }) => unknown) =>
        cb({ onCommit: (fn) => commits.push(fn) }),
    };
    return { db, commit: () => commits.forEach((fn) => fn()) };
  }

  it("waits for the work after the commit and reports its failure", async () => {
    const { db, commit } = fakeDb();
    const onError = vi.fn();
    let ran = false;
    const l = log();
    const run = await runCronTask("classified-janitor", l, async () => {
      await afterCommit(
        db,
        async () => {
          await new Promise((r) => setTimeout(r, 5));
          ran = true;
          throw new Error("image cleanup failed");
        },
        onError,
      );
      commit();
    });
    expect(ran).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(run.failed).toBe(true);
    expect(l.error).toHaveBeenCalledWith("[cron] classified-janitor failed: image cleanup failed");
  });

  it("reports nothing for a request outside a run", async () => {
    const { db, commit } = fakeDb();
    const onError = vi.fn();
    await afterCommit(
      db,
      async () => {
        throw new Error("x");
      },
      onError,
    );
    commit();
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
