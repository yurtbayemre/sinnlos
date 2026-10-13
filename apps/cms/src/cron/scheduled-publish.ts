import { SCHEDULED_UIDS, isUnpublishScheduledUid } from "../utils/authoring-uids";
import { recordAuditEvent, type AuditHost } from "../utils/audit";
import {
  advanceRevision,
  lockDocument,
  readRevision,
  runInAuthoringScope,
  type DocumentLockHost,
} from "../utils/document-lock";
import {
  SCHEDULE_BATCH,
  TransientAttempts,
  classifyScheduleFailure,
  instantOf,
  windowExpired,
  type ScheduleErrorCode,
} from "../utils/schedule";

/**
 * Scheduled publishing on Strapi CE (decision 06 §D rules 2-13; batch 15
 * plan item 5): the `scheduled-publisher` cron task, every minute in
 * APP_TIME_ZONE through `guardedTask` (cron/registry.ts). CE has no
 * Releases scheduling (spike 9, C12/C13); this task publishes and
 * unpublishes due drafts through the Document Service, so every middleware
 * (the lock, schedule-clear, readiness, the audit recorder), the lifecycles
 * and the after-commit notification fan-out run as for a manual publish.
 *
 * PER TYPE (SCHEDULED_UIDS; no poll), due unpublishes first, then due
 * publishes, each ordered by the due time, then the row id, at most
 * SCHEDULE_BATCH per run (the next minute takes the rest). The selection
 * reads the due DRAFT rows (rule 2: the draft holds the schedule) through
 * the partial indexes, and each document's revision `r`, outside any
 * transaction. Then ONE transaction per document:
 *   1. lock the document (utils/document-lock.ts lockDocument) and re-read:
 *      the revision must still be `r` and the draft still due; otherwise
 *      skip (a save, a manual action or another runner came first, also in
 *      another process: the lock serialises them);
 *   2. the raw claim: `publishAt` on the draft, or `unpublishAt` on both
 *      rows, cleared with `updateMany` (an object payload leaves `updatedAt`
 *      alone, so the panel keeps "Published"; rule 9);
 *   3. `strapi.documents(uid).publish()` or `unpublish()` in the same
 *      transaction, which advances the revision (the nested lock joins).
 * Everything runs in an authoring scope with source `cron`: the audit rows
 * read `schedulePublish` / `scheduleUnpublish`, actor `system`.
 *
 * UNPUBLISHES (documents, quick links): due when the draft's `unpublishAt`
 * has passed and the document has a published row. Without one the claim
 * only clears the field (advance + audit `scheduleUnpublish`, "nothing was
 * published"), and only when no publish is pending; a pending publish
 * keeps `unpublishAt`, so the publish pass sees the ended window (rule 4).
 * An unpublish also cancels a pending publish (schedule-clear).
 *
 * EXPIRED WINDOW (rule 5): a due publish whose announcement `expiresAt` or
 * document/quick-link `unpublishAt` already passed is not published: the
 * task clears `publishAt` and `unpublishAt`, sets `scheduleError =
 * windowExpired`, advances the revision and writes `scheduleFailed`. After
 * downtime this keeps expired content out and notifies nobody.
 *
 * FAILURES (rule 7). A throwing publish rolls back with its claim. Then:
 *   - permanent (readiness `notPublishable`, a ValidationError `invalid`, a
 *     lifecycle ApplicationError `rejected`): a short transaction locks the
 *     document and, only if the revision is still `r` (otherwise a newer
 *     save or a manual action supersedes the failure: nothing recorded),
 *     sets `scheduleError` and clears the schedule field raw, advances the
 *     revision and writes `scheduleFailed`;
 *   - transient (lock or serialisation failures, a lost connection,
 *     SQLITE_BUSY, anything unknown): the schedule stays and the next
 *     minute retries; the SCHEDULE_TRANSIENT_ATTEMPTS-th failure for the
 *     same (uid, documentId, r) in this process is recorded as
 *     `retryExhausted`. A restart forgets the count (only adds retries).
 * Each recorded failure logs `[scheduler] <uid> <documentId> failed: <code>`.
 *
 * NOTIFICATIONS run after the commit through the unchanged lifecycles
 * (rule 8); the dedup is per recipient. Two cms processes publishing the
 * same document at once is prevented by the lock and the generation check;
 * the documented deployment runs one cms process anyway.
 */

export const SCHEDULER_LOG = "[scheduler]";

/** The slice of the Strapi instance the task uses. */
export interface ScheduledPublishStrapi {
  db: Omit<DocumentLockHost["db"], "query"> & {
    query(uid: string): {
      findMany(params: Record<string, unknown>): Promise<Record<string, unknown>[]>;
      findOne(params: Record<string, unknown>): Promise<Record<string, unknown> | null>;
      count(params: Record<string, unknown>): Promise<number>;
      updateMany(params: Record<string, unknown>): Promise<{ count?: number } | undefined>;
      create(params: { data: Record<string, unknown> }): Promise<unknown>;
    };
  };
  documents(uid: string): {
    publish(params: { documentId: string }): Promise<unknown>;
    unpublish(params: { documentId: string }): Promise<unknown>;
  };
  requestContext?: AuditHost["requestContext"];
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
}

/** What one run did, per outcome (documentIds prefixed with the uid). */
export interface ScheduleRunResult {
  published: string[];
  unpublished: string[];
  /** `unpublishAt` passed on a document that was not published: cleared only. */
  cleared: string[];
  expired: string[];
  failed: string[];
  retrying: string[];
  skipped: string[];
}

export type SchedulePass = "publish" | "unpublish";
type Pass = SchedulePass;

/** An empty run result. */
export const emptyResult = (): ScheduleRunResult => ({
  published: [],
  unpublished: [],
  cleared: [],
  expired: [],
  failed: [],
  retrying: [],
  skipped: [],
});

/** Transient failures of this process (rule 7). */
const processAttempts = new TransientAttempts();

const label = (uid: string, documentId: string) => `${uid} ${documentId}`;

const isDocumentId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** The due draft rows of one pass, ordered and bounded (rule 4). */
async function dueDrafts(
  strapi: ScheduledPublishStrapi,
  uid: string,
  field: "publishAt" | "unpublishAt",
  now: Date,
): Promise<string[]> {
  const rows = await strapi.db.query(uid).findMany({
    where: { publishedAt: null, [field]: { $notNull: true, $lte: now } },
    select: ["id", "documentId", field],
    orderBy: [{ [field]: "asc" }, { id: "asc" }],
    limit: SCHEDULE_BATCH,
  });
  return rows.map((row) => row.documentId).filter(isDocumentId);
}

const draftOf = (strapi: ScheduledPublishStrapi, uid: string, documentId: string) =>
  strapi.db.query(uid).findOne({ where: { documentId, publishedAt: null } });

const isDue = (value: unknown, now: Date): boolean => {
  const at = instantOf(value);
  return at !== null && at.getTime() <= now.getTime();
};

/** The audit row of a raw scheduler write (its own, rule 7). */
async function auditScheduleFailed(
  strapi: ScheduledPublishStrapi,
  uid: string,
  documentId: string,
  revision: number,
  detail: string,
  action: "scheduleFailed" | "scheduleUnpublish" = "scheduleFailed",
): Promise<void> {
  await recordAuditEvent(strapi, {
    action,
    targetUid: uid,
    targetDocumentId: documentId,
    revision,
    actorKind: "system",
    source: "cron",
    detail,
  });
}

/** Unpublish pass, one document (see the module comment). */
async function unpublishOne(
  strapi: ScheduledPublishStrapi,
  uid: string,
  documentId: string,
  r: number,
  now: Date,
): Promise<keyof ScheduleRunResult> {
  return strapi.db.transaction(async () => {
    if ((await lockDocument(strapi, uid, documentId)) !== r) return "skipped";
    const draft = await draftOf(strapi, uid, documentId);
    if (!draft || !isDue(draft.unpublishAt, now)) return "skipped";
    const published = await strapi.db.query(uid).count({
      where: { documentId, publishedAt: { $notNull: true } },
    });
    if (published === 0 && draft.publishAt !== null && draft.publishAt !== undefined) {
      // A pending publish keeps the end of its window for the publish pass.
      return "skipped";
    }
    const claim = await strapi.db.query(uid).updateMany({
      where: { documentId, unpublishAt: { $notNull: true } },
      data: { unpublishAt: null },
    });
    if ((claim?.count ?? 0) < 1) return "skipped";
    if (published === 0) {
      const revision = await advanceRevision(strapi, uid, documentId);
      await auditScheduleFailed(
        strapi,
        uid,
        documentId,
        revision,
        "nothing was published; the withdrawal time passed",
        "scheduleUnpublish",
      );
      return "cleared";
    }
    await strapi.documents(uid).unpublish({ documentId });
    return "unpublished";
  });
}

/** Publish pass, one document (see the module comment). */
async function publishOne(
  strapi: ScheduledPublishStrapi,
  uid: string,
  documentId: string,
  r: number,
  now: Date,
): Promise<keyof ScheduleRunResult> {
  return strapi.db.transaction(async () => {
    if ((await lockDocument(strapi, uid, documentId)) !== r) return "skipped";
    const draft = await draftOf(strapi, uid, documentId);
    if (!draft || !isDue(draft.publishAt, now)) return "skipped";
    if (windowExpired(uid, draft, now)) {
      await strapi.db.query(uid).updateMany({
        where: { documentId, publishedAt: null },
        data: {
          publishAt: null,
          ...(isUnpublishScheduledUid(uid) ? { unpublishAt: null } : {}),
          scheduleError: "windowExpired",
        },
      });
      const revision = await advanceRevision(strapi, uid, documentId);
      await auditScheduleFailed(strapi, uid, documentId, revision, "windowExpired");
      strapi.log.warn(`${SCHEDULER_LOG} ${label(uid, documentId)} failed: windowExpired`);
      return "expired";
    }
    const claim = await strapi.db.query(uid).updateMany({
      where: { id: draft.id, publishAt: { $notNull: true } },
      data: { publishAt: null },
    });
    if ((claim?.count ?? 0) !== 1) return "skipped";
    await strapi.documents(uid).publish({ documentId });
    return "published";
  });
}

/**
 * Records a failure for good (rule 7), unless the document moved on since
 * `r`. Returns whether it recorded.
 */
export async function recordScheduleFailure(
  strapi: ScheduledPublishStrapi,
  uid: string,
  documentId: string,
  r: number,
  pass: Pass,
  code: ScheduleErrorCode,
  detail: string,
): Promise<boolean> {
  return strapi.db.transaction(async () => {
    if ((await lockDocument(strapi, uid, documentId)) !== r) return false;
    await strapi.db.query(uid).updateMany({
      where: { documentId, publishedAt: null },
      data: {
        scheduleError: code,
        ...(pass === "publish" ? { publishAt: null } : { unpublishAt: null }),
      },
    });
    const revision = await advanceRevision(strapi, uid, documentId);
    const prefix = pass === "unpublish" ? "unpublish " : "";
    await auditScheduleFailed(strapi, uid, documentId, revision, `${prefix}${code}: ${detail}`);
    return true;
  });
}

/**
 * One document of one pass: the transaction, and the failure handling.
 * `r` is the revision the selection read (exported for the tests, which
 * hand it a stale one).
 */
export async function runScheduledDocument(
  strapi: ScheduledPublishStrapi,
  uid: string,
  documentId: string,
  pass: Pass,
  now: Date,
  attempts: TransientAttempts,
  result: ScheduleRunResult,
  r: number,
): Promise<void> {
  const key = label(uid, documentId);
  try {
    const outcome =
      pass === "publish"
        ? await publishOne(strapi, uid, documentId, r, now)
        : await unpublishOne(strapi, uid, documentId, r, now);
    result[outcome].push(key);
    if (outcome !== "skipped") attempts.clear(uid, documentId, r);
    return;
  } catch (error) {
    const failure = classifyScheduleFailure(error);
    let code: ScheduleErrorCode;
    if (failure.kind === "transient") {
      if (!attempts.fail(uid, documentId, r)) {
        strapi.log.warn(`${SCHEDULER_LOG} ${key} ${pass} will be retried: ${failure.detail}`);
        result.retrying.push(key);
        return;
      }
      code = "retryExhausted";
    } else {
      code = failure.code;
    }
    try {
      if (await recordScheduleFailure(strapi, uid, documentId, r, pass, code, failure.detail)) {
        attempts.clear(uid, documentId, r);
        strapi.log.error(`${SCHEDULER_LOG} ${key} failed: ${code}`);
        result.failed.push(key);
      } else {
        result.skipped.push(key);
      }
    } catch (recordError) {
      // The next run retries the document (its schedule is untouched).
      strapi.log.error(
        `${SCHEDULER_LOG} ${key} failed: ${code}, and recording it failed too: ` +
          (recordError instanceof Error ? recordError.message : String(recordError)),
      );
      result.retrying.push(key);
    }
  }
}

/**
 * One run of the task (see the module comment). `now` and `attempts` are
 * injectable for the tests.
 */
export async function runScheduledPublishing(
  strapi: ScheduledPublishStrapi,
  now: Date = new Date(),
  attempts: TransientAttempts = processAttempts,
): Promise<ScheduleRunResult> {
  const result = emptyResult();
  await runInAuthoringScope({ source: "cron" }, async () => {
    for (const uid of SCHEDULED_UIDS) {
      if (isUnpublishScheduledUid(uid)) {
        for (const documentId of await dueDrafts(strapi, uid, "unpublishAt", now)) {
          const r = await readRevision(strapi, uid, documentId);
          await runScheduledDocument(
            strapi,
            uid,
            documentId,
            "unpublish",
            now,
            attempts,
            result,
            r,
          );
        }
      }
      for (const documentId of await dueDrafts(strapi, uid, "publishAt", now)) {
        const r = await readRevision(strapi, uid, documentId);
        await runScheduledDocument(strapi, uid, documentId, "publish", now, attempts, result, r);
      }
    }
  });
  const acted =
    result.published.length +
    result.unpublished.length +
    result.cleared.length +
    result.expired.length +
    result.failed.length;
  if (acted > 0) {
    strapi.log.info(
      `${SCHEDULER_LOG} published ${result.published.length}, unpublished ${result.unpublished.length}, ` +
        `cleared ${result.cleared.length}, window expired ${result.expired.length}, failed ${result.failed.length}`,
    );
  }
  return result;
}
