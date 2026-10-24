/**
 * The run context of one cron task (v0.29, S8). `guardedTask` runs every
 * task inside `runCronTask`, an AsyncLocalStorage scope that follows the
 * task through its awaits, Document Service transactions and their commit
 * callbacks. Code a task reaches reports what it swallows:
 *
 *  - `reportRunFailure(err, detail)`: a failure the code catches and logs
 *    on its own (one event of a batch, a fail-open read). The run ends
 *    "failed" (cron-status.ts) and `[cron] <name> failed: <detail>` is
 *    logged, the one line an operator greps for.
 *  - `trackRunWork(promise)`: work that outlives the task's own promise
 *    (a fan-out after commit, the image cleanup of a deleted ad). The run
 *    waits for it before it records its outcome; a rejection is a failure.
 *
 * Both are no-ops outside a run: an HTTP request that hits the same code
 * never marks a cron run failed.
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface CronRun {
  readonly name: string;
  readonly log: { error(message: string): void };
  failed: boolean;
  readonly pending: Promise<unknown>[];
}

const runs = new AsyncLocalStorage<CronRun>();

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Marks the current cron run failed and logs it; a no-op outside a run. */
export function reportRunFailure(err: unknown, detail?: string): void {
  const run = runs.getStore();
  if (!run) return;
  run.failed = true;
  run.log.error(`[cron] ${run.name} failed: ${detail ?? messageOf(err)}`);
}

/** Lets the current run wait for `work`; returns `work` unchanged. */
export function trackRunWork<T>(work: Promise<T>): Promise<T> {
  const run = runs.getStore();
  if (run) run.pending.push(work.catch((err: unknown) => reportRunFailure(err)));
  return work;
}

/**
 * Runs `fn` as the cron task `name`. Resolves with whether anything
 * reported a failure; rejects with `fn`'s own error. Either way only after
 * the tracked work has settled, including work that work tracked.
 */
export async function runCronTask(
  name: string,
  log: CronRun["log"],
  fn: () => Promise<void>,
): Promise<{ failed: boolean }> {
  const run: CronRun = { name, log, failed: false, pending: [] };
  await runs.run(run, async () => {
    try {
      await fn();
    } finally {
      while (run.pending.length > 0) await Promise.allSettled(run.pending.splice(0));
    }
  });
  return { failed: run.failed };
}
