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

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Permanent (rule 7): the readiness refusal, a ValidationError, a
 * lifecycle ApplicationError. Transient: lock and serialisation failures,
 * lost connections, SQLITE_BUSY, a pool timeout, and anything unknown (it
 * is retried, and SCHEDULE_TRANSIENT_ATTEMPTS bounds it).
 */
export function classifyScheduleFailure(error: unknown): ScheduleFailure {
  const detail = messageOf(error).slice(0, 200);
  if (error instanceof NotPublishableError) {
    return { kind: "permanent", code: "notPublishable", detail };
  }
  if (error instanceof errors.ValidationError)
    return { kind: "permanent", code: "invalid", detail };
  if (error instanceof errors.ApplicationError) {
    return { kind: "permanent", code: "rejected", detail };
  }
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  if (TRANSIENT_CODES.has(code)) return { kind: "transient", detail: `${code} ${detail}` };
  return { kind: "transient", detail };
}

/**
 * Transient failures per (uid, documentId, revision) in this process
 * (rule 7). A restart forgets them, which only adds retries. Bounded: the
 * oldest entries go first past `limit` keys.
 */
export class TransientAttempts {
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly max: number = SCHEDULE_TRANSIENT_ATTEMPTS,
    private readonly limit = 10_000,
  ) {}

  private static key(uid: string, documentId: string, revision: number): string {
    return `${uid}\u0000${documentId}\u0000${revision}`;
  }

  /** Counts one more failure; true when the bound is reached (record retryExhausted). */
  fail(uid: string, documentId: string, revision: number): boolean {
    const key = TransientAttempts.key(uid, documentId, revision);
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
  clear(uid: string, documentId: string, revision: number): void {
    this.counts.delete(TransientAttempts.key(uid, documentId, revision));
  }

  get size(): number {
    return this.counts.size;
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

/** `data` with `fields` set to null (only the fields the type has). */
function nulled(data: unknown, fields: readonly string[]): Record<string, unknown> {
  const base = isRecord(data) ? { ...data } : {};
  for (const field of fields) base[field] = null;
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
        if (params) params.data = nulled(params.data, fields);
        return next();
      case "create":
      case "update":
        if (params) {
          const published = params.status === "published";
          const clear = published
            ? ["publishAt", "scheduleError"].filter(has)
            : ["scheduleError"].filter(has);
          params.data = nulled(params.data, clear);
        }
        return next();
      default:
        return next();
    }
  };
}
