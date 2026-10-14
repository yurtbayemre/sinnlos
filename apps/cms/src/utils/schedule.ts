import { errors } from "@strapi/utils";

import { ANNOUNCEMENT_UID, isScheduledUid, isUnpublishScheduledUid } from "./authoring-uids";
import { NotPublishableError } from "./publish-readiness";

/**
 * Scheduled publishing (decision 06 §D; batch 15 plan item 5): the shared
 * vocabulary, the scheduler's pure decisions and the schedule-clear
 * middleware. The task itself is cron/scheduled-publish.ts.
 *
 * THE FIELDS live on the DRAFT row (rule 2): `publishAt` on the seven
 * scheduled types, `unpublishAt` on documents and quick links, and
 * `scheduleError`. The published row's copies are ignored; a published row
 * never carries a pending `publishAt` or a `scheduleError`, because every
 * publish clears both first.
 *
 * `scheduleError` holds one of SCHEDULE_ERROR_CODES after a scheduled
 * publish failed for good; the next Document Service save of the draft
 * clears it (rule 7):
 *   - notPublishable: the publish-readiness check refused the draft
 *     (a required field missing, a course or parent not published);
 *   - invalid: Strapi's published validation refused it (ValidationError);
 *   - rejected: a lifecycle refused it (ApplicationError);
 *   - windowExpired: its window had ended when the task reached it (the
 *     announcement's `expiresAt`, or `unpublishAt`); nothing was published
 *     and nobody was notified;
 *   - retryExhausted: SCHEDULE_TRANSIENT_ATTEMPTS transient failures in a
 *     row for the same revision.
 *
 * SCHEDULE-CLEAR (rule 6), slot 5 of bootstrap/document-middlewares.ts,
 * inside the document lock's transaction, for the scheduled types:
 *   - a publish clears the draft's `publishAt` and `scheduleError` before
 *     the publish copies the draft; a create/update with `status:
 *     'published'` (which publishes inside the action, C3) writes them as
 *     null with the draft, so publishing now wins over a schedule sent
 *     with it. The admin panel publishes through the Document Service
 *     (C19), so a panel publish clears the schedule too;
 *   - an unpublish clears the draft's `publishAt`: withdrawn content never
 *     comes back through an older schedule;
 *   - a clone starts unscheduled: `publishAt`, `unpublishAt` and
 *     `scheduleError` are null in the clone's data (clone merges data over
 *     the copy, C35);
 *   - any other save of the draft (create/update without `published`)
 *     clears `scheduleError`;
 *   - a discard needs nothing: the draft is rebuilt from the published row,
 *     which carries neither (C20).
 * The raw clears use `updateMany` with an object payload, which leaves
 * `updatedAt` alone (@strapi/database timestamps subscriber), so the admin
 * panel keeps "Published", not "Modified".
 */

export const SCHEDULE_ERROR_CODES = [
  "notPublishable",
  "invalid",
  "rejected",
  "windowExpired",
  "retryExhausted",
] as const;

export type ScheduleErrorCode = (typeof SCHEDULE_ERROR_CODES)[number];

/** Due drafts per type and run (§D rule 4). */
export const SCHEDULE_BATCH = 50;

/** Transient failures per (uid, documentId, revision) and process before retryExhausted. */
export const SCHEDULE_TRANSIENT_ATTEMPTS = 5;

/**
 * Minutes a failed withdrawal waits before its next attempt, by the number
 * of failed episodes so far (the last value repeats): a withdrawal is
 * never given up, only spaced out.
 */
export const WITHDRAWAL_BACKOFF_MINUTES: readonly number[] = [5, 15, 60];

/**
 * Failed withdrawals (`scheduleError` set) each unpublish pass attempts at
 * most, whatever the healthy ones hold: their reserved share of
 * SCHEDULE_BATCH (issue #73; cron/scheduled-publish.ts dueUnpublishes).
 */
export const WITHDRAWAL_RETRY_QUOTA = 10;

/** Failed withdrawals the retry tier examines per type and run, at most. */
export const WITHDRAWAL_RETRY_SCAN = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// The scheduler's decisions.

/** An instant as the query engine returns it (ISO string or Date), or null. */
export function instantOf(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The end of a draft's window, when it has one (rule 5): the
 * announcement's `expiresAt`, or `unpublishAt` on documents and quick links.
 */
export function windowEnd(uid: string, draft: Record<string, unknown>): Date | null {
  if (uid === ANNOUNCEMENT_UID) return instantOf(draft.expiresAt);
  if (isUnpublishScheduledUid(uid)) return instantOf(draft.unpublishAt);
  return null;
}

/** Whether a due publish must be skipped because its window already ended. */
export function windowExpired(uid: string, draft: Record<string, unknown>, now: Date): boolean {
  const end = windowEnd(uid, draft);
  return end !== null && end.getTime() <= now.getTime();
}

/** How a failed scheduled publish is recorded (rule 7). */
export type ScheduleFailure =
  | { kind: "permanent"; code: ScheduleErrorCode; detail: string }
  | { kind: "transient"; detail: string };

/** Postgres SQLSTATEs and driver codes that a later attempt can survive. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "40P01", // deadlock_detected
  "40001", // serialization_failure
  "55P03", // lock_not_available (lock_timeout)
  "57014", // query_canceled (statement_timeout)
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
]);

const nameOf = (error: unknown): string =>
  error instanceof Error && error.name ? error.name : typeof error;

const codeOf = (error: unknown): string =>
  isRecord(error) && typeof error.code === "string" ? error.code : "";

/** The field paths a Strapi ValidationError names (yup `details.errors`, or `details.keys`). */
function validationPaths(error: { details?: unknown }): string[] {
  const details = isRecord(error.details) ? error.details : {};
  const fromErrors = Array.isArray(details.errors)
    ? details.errors
        .map((entry) => (isRecord(entry) && Array.isArray(entry.path) ? entry.path.join(".") : ""))
        .filter((path) => path !== "")
    : [];
  const fromKeys = Array.isArray(details.keys)
    ? details.keys.filter((key): key is string => typeof key === "string")
    : [];
  return [...new Set([...fromErrors, ...fromKeys])].sort();
}

/**
 * A description of a failure that names no content: the error class, a
 * driver code (SQLSTATE) and field NAMES, never an error message. A
 * database error's message is the SQL with its bound values (knex), and a
 * lifecycle's message may quote a value, so neither reaches the audit row
 * (§H: names, never values) or the log.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof NotPublishableError) return `keys: ${error.keys.join(", ")}`;
  if (error instanceof errors.ValidationError) {
    const paths = validationPaths(error);
    return paths.length > 0 ? `${error.name}: ${paths.join(", ")}` : error.name;
  }
  const code = codeOf(error);
  return code ? `${nameOf(error)} ${code}` : nameOf(error);
}

/**
 * Permanent (rule 7): the readiness refusal, a ValidationError, a
 * lifecycle ApplicationError. Transient: lock and serialisation failures,
 * lost connections, SQLITE_BUSY, a pool timeout, and anything unknown (it
 * is retried, and SCHEDULE_TRANSIENT_ATTEMPTS bounds it). The detail is
 * `describeFailure`: never a message.
 */
export function classifyScheduleFailure(error: unknown): ScheduleFailure {
  const detail = describeFailure(error).slice(0, 200);
  if (error instanceof NotPublishableError) {
    return { kind: "permanent", code: "notPublishable", detail };
  }
  if (error instanceof errors.ValidationError) {
    return { kind: "permanent", code: "invalid", detail };
  }
  if (error instanceof errors.ApplicationError) {
    return { kind: "permanent", code: "rejected", detail };
  }
  return { kind: "transient", detail };
}

/** Whether `error` is one of the driver codes a later attempt survives (for the log). */
export const isKnownTransient = (error: unknown): boolean => TRANSIENT_CODES.has(codeOf(error));

/**
 * Transient failures per (uid, documentId, revision, pass) in this process
 * (rule 7). A restart forgets them, which only adds retries. Bounded: the
 * oldest entries go first past `limit` keys.
 */
export class TransientAttempts {
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly max: number = SCHEDULE_TRANSIENT_ATTEMPTS,
    private readonly limit = 10_000,
  ) {}

  private static key(uid: string, documentId: string, revision: number, pass: string): string {
    return `${uid}\u0000${documentId}\u0000${revision}\u0000${pass}`;
  }

  /** Counts one more failure; true when the bound is reached (record retryExhausted). */
  fail(uid: string, documentId: string, revision: number, pass = "publish"): boolean {
    const key = TransientAttempts.key(uid, documentId, revision, pass);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.delete(key);
    this.counts.set(key, count);
    while (this.counts.size > this.limit) {
      const oldest = this.counts.keys().next().value;
      if (oldest === undefined) break;
      this.counts.delete(oldest);
    }
    return count >= this.max;
  }

  /** Forgets a document's failures at a revision (it published, or was recorded). */
  clear(uid: string, documentId: string, revision: number, pass = "publish"): void {
    this.counts.delete(TransientAttempts.key(uid, documentId, revision, pass));
  }

  get size(): number {
    return this.counts.size;
  }

  // -------------------------------------------------------------------------
  // Failed withdrawals: never given up, retried with a bounded backoff.

  private readonly withdrawals = new Map<
    string,
    { failures: number; at: number; revision: number }
  >();

  private static documentKey(uid: string, documentId: string): string {
    return `${uid}\u0000${documentId}`;
  }

  /** How many failed episodes a withdrawal has had (0: none, or it succeeded since). */
  withdrawalFailures(uid: string, documentId: string): number {
    return this.withdrawals.get(TransientAttempts.documentKey(uid, documentId))?.failures ?? 0;
  }

  /**
   * Defers a failed withdrawal by the next WITHDRAWAL_BACKOFF_MINUTES step,
   * remembering the revision it failed at; returns when it is due again.
   */
  deferWithdrawal(uid: string, documentId: string, now: Date, revision: number): Date {
    const key = TransientAttempts.documentKey(uid, documentId);
    const failures = (this.withdrawals.get(key)?.failures ?? 0) + 1;
    const steps = WITHDRAWAL_BACKOFF_MINUTES;
    const minutes = steps[Math.min(failures, steps.length) - 1];
    const at = now.getTime() + minutes * 60_000;
    this.withdrawals.delete(key);
    this.withdrawals.set(key, { failures, at, revision });
    while (this.withdrawals.size > this.limit) {
      const oldest = this.withdrawals.keys().next().value;
      if (oldest === undefined) break;
      this.withdrawals.delete(oldest);
    }
    return new Date(at);
  }

  /**
   * Whether a withdrawal may be attempted now: never deferred, its backoff
   * over, or the document changed since (a save or another runner moved
   * the revision: the author may have re-planned it).
   */
  withdrawalReady(uid: string, documentId: string, now: Date, revision: number): boolean {
    const record = this.withdrawals.get(TransientAttempts.documentKey(uid, documentId));
    return !record || record.revision !== revision || now.getTime() >= record.at;
  }

  /** Forgets a withdrawal's failures (it succeeded, or the deadline was cleared). */
  clearWithdrawal(uid: string, documentId: string): void {
    this.withdrawals.delete(TransientAttempts.documentKey(uid, documentId));
  }

  // -------------------------------------------------------------------------
  // The retry tier's keyset cursor (issue #73): per uid, the id of the last
  // draft row it examined (0: start at the beginning). A restart starts over,
  // which only adds retries.

  private readonly cursors = new Map<string, number>();

  withdrawalCursor(uid: string): number {
    return this.cursors.get(uid) ?? 0;
  }

  setWithdrawalCursor(uid: string, id: number): void {
    this.cursors.set(uid, id);
  }
}

// ---------------------------------------------------------------------------
// The schedule-clear middleware.

/** The slice of the Strapi instance the middleware uses. */
export interface ScheduleClearHost {
  db: {
    query(uid: string): {
      updateMany(params: Record<string, unknown>): Promise<{ count?: number } | undefined>;
    };
  };
}

interface ScheduleContext {
  uid?: string;
  action?: string;
  params?: unknown;
  contentType?: { attributes?: Record<string, unknown> };
}

/** The schedule fields `uid` has (from the content type, else from the uid lists). */
function scheduleFields(context: ScheduleContext, uid: string): string[] {
  const attributes = context.contentType?.attributes;
  const fields = ["publishAt", "unpublishAt", "scheduleError"];
  if (isRecord(attributes)) return fields.filter((field) => field in attributes);
  return isUnpublishScheduledUid(uid) ? fields : ["publishAt", "scheduleError"];
}

// The keys schedule-clear added to an action's data that the writer did not
// send, per action context (one context object per action, C4): the audit
// recorder leaves them out of the row's `keys`, which lists what the
// writer sent.
const addedKeys = new WeakMap<object, readonly string[]>();

/** The schedule fields schedule-clear added to this action's data (not sent by the writer). */
export function scheduleClearAddedKeys(context: object): readonly string[] {
  return addedKeys.get(context) ?? [];
}

/** `data` with `fields` set to null (only the fields the type has); records the added keys. */
function nulled(
  context: object,
  data: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  const base = isRecord(data) ? { ...data } : {};
  const added = fields.filter((field) => !(field in base));
  for (const field of fields) base[field] = null;
  if (added.length > 0) addedKeys.set(context, added);
  return base;
}

/** Sets `fields` to null on the document's draft row, where any of them is set. */
async function clearDraft(
  strapi: ScheduleClearHost,
  uid: string,
  documentId: unknown,
  fields: readonly string[],
): Promise<void> {
  if (typeof documentId !== "string" || documentId === "" || fields.length === 0) return;
  await strapi.db.query(uid).updateMany({
    where: {
      documentId,
      publishedAt: null,
      $or: fields.map((field) => ({ [field]: { $notNull: true } })),
    },
    data: Object.fromEntries(fields.map((field) => [field, null])),
  });
}

/** The schedule-clear middleware (see the module comment). */
export function createScheduleClear(strapi: ScheduleClearHost) {
  return async (context: ScheduleContext, next: () => Promise<unknown>): Promise<unknown> => {
    const uid = context.uid;
    if (!isScheduledUid(uid)) return next();
    const params = isRecord(context.params) ? context.params : null;
    const fields = scheduleFields(context, uid);
    const has = (field: string) => fields.includes(field);
    switch (context.action) {
      case "publish":
        await clearDraft(
          strapi,
          uid,
          params?.documentId,
          ["publishAt", "scheduleError"].filter(has),
        );
        return next();
      case "unpublish":
        await clearDraft(strapi, uid, params?.documentId, ["publishAt"].filter(has));
        return next();
      case "clone":
        if (params) params.data = nulled(context, params.data, fields);
        return next();
      case "create":
      case "update":
        if (params) {
          const published = params.status === "published";
          const clear = published
            ? ["publishAt", "scheduleError"].filter(has)
            : ["scheduleError"].filter(has);
          params.data = nulled(context, params.data, clear);
        }
        return next();
      default:
        return next();
    }
  };
}
