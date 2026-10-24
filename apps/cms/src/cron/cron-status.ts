/**
 * Cron outcomes in the database (v0.29, S8), for infra/ops-check.sh: the
 * logs are lost when the cms container is recreated, the core store is not.
 *
 *  - `cron:<task>`: the last run of one task, written by `guardedTask`
 *    after the run (and its tracked work, run-context.ts) settled, outside
 *    any transaction. One key per task, so tasks running at the same time
 *    never overwrite each other; the task's overlap guard keeps the writes
 *    to one key in order. A failure, and the first success after one, is
 *    written at once; an unchanged success only when the stored one is ten
 *    minutes old, so the two minute tasks write about every ten minutes.
 *    `lastFailedAt` survives later successes, so a failure that recovered
 *    before the hourly check is still reported.
 *  - `cron:expected`: written at boot, the tasks this process schedules
 *    (none with CRON_ENABLED off), each with the time it first became
 *    expected; a restart keeps that time, so a task that never runs is
 *    reported once its grace has passed instead of after every boot.
 *
 * The rows: `strapi_core_store_settings`, key `plugin_sinnlos_cron:<task>`,
 * type `object`, environment and tag NULL, the value JSON. No error text is
 * stored; the details are in the log lines.
 */
import type { CronTaskSpec } from "./registry";

export const CRON_STATUS_STORE = { type: "plugin", name: "sinnlos" } as const;

/** How long an unchanged success goes unwritten. */
export const UNCHANGED_OK_WRITE_MS = 10 * 60_000;

export type CronOutcome = "ok" | "failed";

export interface CronTaskStatus {
  lastStartedAt: string;
  lastFinishedAt: string;
  lastOutcome: CronOutcome;
  lastFailedAt: string | null;
  everyMinutes: number;
}

export interface ExpectedCronTasks {
  bootedAt: string;
  cronEnabled: boolean;
  tasks: { name: string; everyMinutes: number; firstExpectedAt: string }[];
}

interface ScopedStore {
  get(params: Record<string, never>): Promise<unknown>;
  set(params: { value: unknown }): Promise<unknown>;
}

/** The slice of Strapi this needs; `store` is optional for test doubles. */
export interface CronStatusStrapi {
  store?: (params: { type: string; name: string; key: string }) => ScopedStore;
}

const storeFor = (strapi: CronStatusStrapi, key: string): ScopedStore | null =>
  typeof strapi.store === "function" ? strapi.store({ ...CRON_STATUS_STORE, key }) : null;

/**
 * Minutes between two runs of a 5-field rule: every minute (`* * * * *`),
 * daily (`M H * * *`) or weekly (`M H * * D`). Any other shape throws, so a
 * new schedule cannot silently get a wrong threshold.
 */
export function everyMinutes(rule: string): number {
  const [minute, hour, dom, month, dow, ...rest] = rule.trim().split(/\s+/);
  if (rest.length === 0 && dom === "*" && month === "*") {
    if (minute === "*" && hour === "*" && dow === "*") return 1;
    if (/^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "")) {
      if (dow === "*") return 1440;
      if (/^\d$/.test(dow ?? "")) return 10080;
    }
  }
  throw new Error(`[cron] no interval for the rule "${rule}"`);
}

const isIso = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

function parseStatus(value: unknown): CronTaskStatus | null {
  const v = value as Partial<CronTaskStatus> | null;
  if (!v || typeof v !== "object" || !isIso(v.lastFinishedAt)) return null;
  if (v.lastOutcome !== "ok" && v.lastOutcome !== "failed") return null;
  return {
    lastStartedAt: isIso(v.lastStartedAt) ? v.lastStartedAt : v.lastFinishedAt,
    lastFinishedAt: v.lastFinishedAt,
    lastOutcome: v.lastOutcome,
    lastFailedAt: isIso(v.lastFailedAt) ? v.lastFailedAt : null,
    everyMinutes: typeof v.everyMinutes === "number" ? v.everyMinutes : 0,
  };
}

/** The last written status per task in this process (`null`: none stored). */
export type CronStatusState = Map<string, CronTaskStatus | null>;

const processState: CronStatusState = new Map();

/** Records one finished run of `spec` (see the module comment). */
export async function recordCronRun(
  strapi: CronStatusStrapi,
  spec: Pick<CronTaskSpec, "name" | "rule">,
  outcome: CronOutcome,
  startedAt: number,
  finishedAt: number,
  state: CronStatusState = processState,
): Promise<void> {
  const store = storeFor(strapi, `cron:${spec.name}`);
  if (!store) return;
  let last = state.get(spec.name);
  if (last === undefined) last = parseStatus(await store.get({}));
  const unchangedOk = last !== null && outcome === "ok" && last.lastOutcome === "ok";
  if (unchangedOk && finishedAt - Date.parse(last!.lastFinishedAt) < UNCHANGED_OK_WRITE_MS) {
    state.set(spec.name, last);
    return;
  }
  const next: CronTaskStatus = {
    lastStartedAt: new Date(startedAt).toISOString(),
    lastFinishedAt: new Date(finishedAt).toISOString(),
    lastOutcome: outcome,
    lastFailedAt:
      outcome === "failed" ? new Date(finishedAt).toISOString() : (last?.lastFailedAt ?? null),
    everyMinutes: everyMinutes(spec.rule),
  };
  await store.set({ value: next });
  state.set(spec.name, next);
}

/** Writes `cron:expected` at boot (see the module comment). */
export async function recordExpectedCronTasks(
  strapi: CronStatusStrapi,
  specs: readonly Pick<CronTaskSpec, "name" | "rule">[],
  enabled: boolean,
  now: Date = new Date(),
): Promise<void> {
  const store = storeFor(strapi, "cron:expected");
  if (!store) return;
  const previous = (await store.get({})) as Partial<ExpectedCronTasks> | null;
  const firstSeen = new Map<string, string>();
  for (const task of Array.isArray(previous?.tasks) ? previous.tasks : []) {
    if (typeof task?.name === "string" && isIso(task.firstExpectedAt)) {
      firstSeen.set(task.name, task.firstExpectedAt);
    }
  }
  const value: ExpectedCronTasks = {
    bootedAt: now.toISOString(),
    cronEnabled: enabled,
    tasks: enabled
      ? specs.map((spec) => ({
          name: spec.name,
          everyMinutes: everyMinutes(spec.rule),
          firstExpectedAt: firstSeen.get(spec.name) ?? now.toISOString(),
        }))
      : [],
  };
  await store.set({ value });
}
