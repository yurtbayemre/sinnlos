/**
 * The cms cron tasks in one table (LF03). config/server.ts builds Strapi's
 * `server.cron` from it; this module runs no code at load time (config files
 * load before the `strapi` global exists) and holds no schedule state of its
 * own: the overlap flag lives in the closure `buildCronTasks` returns.
 *
 * Order: the janitors run at 03:30 and 03:35 APP_TIME_ZONE, AFTER the 03:00
 * pg-backup of the host crontab (infra/backup/pg-backup.sh; the host runs in
 * APP_TIME_ZONE, docs/DEPLOYMENT.md §7.3), so every row or file they remove
 * is still in the previous night's backup. The digest mails at 07:30.
 *
 * Every task runs through `guardedTask`:
 *  - one `[cron] <name> took <n>ms` info line per run, or `[cron] <name>
 *    failed after <n>ms: <message>` (error) when the task throws; the task
 *    functions log their own results (`[uploads-janitor] …`, `[digest] …`);
 *  - an in-process overlap guard: a run that starts while the previous run
 *    of the same task is still in flight (a slow digest, a manual invoke) is
 *    skipped with a warn line instead of running twice. One cms process runs
 *    the crons (compose runs one cms container), so the guard is enough; it
 *    is not a cluster lock.
 *
 * CRON_ENABLED switches every task off (`cronEnabled`), for a second cms
 * pointed at the same database (a rehearsal, a restore drill) that must not
 * mail digests or sweep uploads.
 */
import { parseEnvFlag, sendDigests, type DigestStrapi } from "../digest/send-digests";
import { pruneSearchLogs } from "./prune-search-logs";
import { sweepOrphanedUploads } from "./sweep-orphaned-uploads";

/** The slice of the Strapi instance the tasks use (the digest run needs the most). */
export type CronStrapi = DigestStrapi;

/** One cron task: a pure description, no state. */
export interface CronTaskSpec {
  /** Strapi's job name (the key of `server.cron.tasks`), unique. */
  readonly name: string;
  /** A 5-field cron pattern: minute, hour, day of month, month, day of week. */
  readonly rule: string;
  /** The IANA zone the rule's wall-clock time is read in (APP_TIME_ZONE). */
  readonly tz: string;
  readonly fn: (strapi: CronStrapi) => Promise<void>;
}

/** What Strapi's cron service takes per named task (@strapi/core services/cron.js). */
export interface StrapiCronTask {
  task: (context: { strapi: CronStrapi }) => Promise<void>;
  options: { rule: string; tz: string };
}

/**
 * The tasks, in firing order, every one in `timeZone` (APP_TIME_ZONE,
 * resolved and validated by config/server.ts).
 */
export function cronRegistry(timeZone: string): readonly CronTaskSpec[] {
  return [
    // Nightly orphan sweep of stamped marketplace uploads (issue #13).
    {
      name: "uploads-janitor",
      rule: "30 3 * * *",
      tz: timeZone,
      fn: (strapi) => sweepOrphanedUploads(strapi),
    },
    // 90-day retention for the anonymous search telemetry (issue #19).
    {
      name: "search-log-janitor",
      rule: "35 3 * * *",
      tz: timeZone,
      fn: (strapi) => pruneSearchLogs(strapi),
    },
    // Morning e-mail digests (issue #18): daily users every day, weekly users
    // on Mondays (digest-plan.ts); without SMTP_* env a logged no-op.
    {
      name: "digest-mailer",
      rule: "30 7 * * *",
      tz: timeZone,
      fn: (strapi) => sendDigests(strapi),
    },
  ];
}

/**
 * CRON_ENABLED: unset or blank keeps the crons on (the default); otherwise
 * it is read like every other on/off switch of the cms (`parseEnvFlag`:
 * 1/true/yes/on, trimmed, any case), so `0`, `false`, `no` or `off` switch
 * every task off. Strapi's `env.bool` would read `1` and a blank value as
 * off, the opposite of what the repo's other switches mean.
 */
export function cronEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  return parseEnvFlag(value);
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The Strapi task for one spec: duration logging and the in-process overlap
 * guard (see the module comment). A task that throws is logged and does not
 * reach croner, which would log it a second time without the task's name
 * in the message. `clock` is injectable for the tests.
 */
export function guardedTask(
  spec: CronTaskSpec,
  clock: () => number = Date.now,
): StrapiCronTask["task"] {
  let inFlight = false;
  return async ({ strapi }) => {
    if (inFlight) {
      strapi.log.warn(`[cron] ${spec.name} skipped: the previous run is still in progress`);
      return;
    }
    inFlight = true;
    const started = clock();
    try {
      await spec.fn(strapi);
      strapi.log.info(`[cron] ${spec.name} took ${clock() - started}ms`);
    } catch (err) {
      strapi.log.error(
        `[cron] ${spec.name} failed after ${clock() - started}ms: ${errorMessage(err)}`,
      );
    } finally {
      inFlight = false;
    }
  };
}

/** `server.cron.tasks` for Strapi: one guarded task per spec, keyed by name. */
export function buildCronTasks(specs: readonly CronTaskSpec[]): Record<string, StrapiCronTask> {
  const tasks: Record<string, StrapiCronTask> = {};
  for (const spec of specs) {
    if (Object.prototype.hasOwnProperty.call(tasks, spec.name)) {
      throw new Error(`[cron] duplicate task name "${spec.name}"`);
    }
    tasks[spec.name] = { task: guardedTask(spec), options: { rule: spec.rule, tz: spec.tz } };
  }
  return tasks;
}
