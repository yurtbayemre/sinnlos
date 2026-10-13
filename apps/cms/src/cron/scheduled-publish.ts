import {
  COURSE_UID,
  LESSON_UID,
  SCHEDULED_UIDS,
  WIKI_PAGE_UID,
  isUnpublishScheduledUid,
} from "../utils/authoring-uids";
import { recordAuditEvent, type AuditHost } from "../utils/audit";
import {
  advanceRevision,
  lockDocument,
  readRevision,
  runInAuthoringScope,
  type DocumentLockHost,
} from "../utils/document-lock";
import { NotPublishableError } from "../utils/publish-readiness";
import {
  SCHEDULE_BATCH,
  TransientAttempts,
  classifyScheduleFailure,
  describeFailure,
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
 * Such waiting drafts are passed over when the selection is read, so they
 * never fill the batch in front of due withdrawals. An unpublish also
 * cancels a pending publish (schedule-clear), and so does a withdrawal
 * that failed for good. The publish pass never publishes a published
 * document whose withdrawal is due: that is the unpublish pass's, also
 * while it is being retried.
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
 *     SQLITE_BUSY, anything unknown), and a readiness refusal whose course
 *     or parent is itself due this minute (a child page sorted before its
 *     parent): the schedule stays and the next minute retries; the
 *     SCHEDULE_TRANSIENT_ATTEMPTS-th failure for the same (uid, documentId,
 *     r, pass) in this process is recorded as `retryExhausted`. A restart
 *     forgets the count (only adds retries).
 * Each recorded failure logs `[scheduler] <uid> <documentId> failed: <code>`.
 * Details (in the audit row and the logs) name the error class, a driver
 * code and field names, never an error message: a database error's message
 * carries the SQL's values (utils/schedule.ts describeFailure).
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

/** Rows per page of the unpublish selection, and pages per run. */
const UNPUBLISH_PAGE = 200;
const UNPUBLISH_MAX_PAGES = 10;

/** The due publishes: draft rows with publishAt passed, ordered and bounded (rule 4). */
async function duePublishes(
  strapi: ScheduledPublishStrapi,
  uid: string,
  now: Date,
): Promise<string[]> {
  const rows = await strapi.db.query(uid).findMany({
    where: { publishedAt: null, publishAt: { $notNull: true, $lte: now } },
    select: ["id", "documentId", "publishAt"],
    orderBy: [{ publishAt: "asc" }, { id: "asc" }],
    limit: SCHEDULE_BATCH,
  });
  return rows.map((row) => row.documentId).filter(isDocumentId);
}

/**
 * The due unpublishes (rule 4): draft rows with unpublishAt passed whose
 * document is published, or that have no pending publish (the claim then
 * only clears the field). A draft with a pending publish and no published
 * row is the publish pass's (its window ended), so it is passed over here
 * and never fills the page: up to UNPUBLISH_MAX_PAGES pages are read until
 * SCHEDULE_BATCH actionable documents are found.
 */
async function dueUnpublishes(
  strapi: ScheduledPublishStrapi,
  uid: string,
  now: Date,
): Promise<string[]> {
  const query = strapi.db.query(uid);
  const actionable: string[] = [];
  for (let page = 0; page < UNPUBLISH_MAX_PAGES && actionable.length < SCHEDULE_BATCH; page += 1) {
    const rows = await query.findMany({
      where: { publishedAt: null, unpublishAt: { $notNull: true, $lte: now } },
      select: ["id", "documentId", "unpublishAt", "publishAt"],
      orderBy: [{ unpublishAt: "asc" }, { id: "asc" }],
      offset: page * UNPUBLISH_PAGE,
      limit: UNPUBLISH_PAGE,
    });
    const documentIds = rows.map((row) => row.documentId).filter(isDocumentId);
    const published = new Set(
      documentIds.length === 0
        ? []
        : (
            await query.findMany({
              where: { documentId: { $in: documentIds }, publishedAt: { $notNull: true } },
              select: ["documentId"],
            })
          ).map((row) => row.documentId),
    );
    for (const row of rows) {
      if (!isDocumentId(row.documentId)) continue;
      const pendingPublish = row.publishAt !== null && row.publishAt !== undefined;
      if (published.has(row.documentId) || !pendingPublish) actionable.push(row.documentId);
      if (actionable.length >= SCHEDULE_BATCH) break;
    }
    if (rows.length < UNPUBLISH_PAGE) break;
  }
  return actionable;
}

const draftOf = (strapi: ScheduledPublishStrapi, uid: string, documentId: string) =>
  strapi.db.query(uid).findOne({ where: { documentId, publishedAt: null } });

const publishedCount = (strapi: ScheduledPublishStrapi, uid: string, documentId: string) =>
  strapi.db.query(uid).count({ where: { documentId, publishedAt: { $notNull: true } } });

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
    const published = await publishedCount(strapi, uid, documentId);
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
    if (isUnpublishScheduledUid(uid) && isDue(draft.unpublishAt, now)) {
      const published = await publishedCount(strapi, uid, documentId);
      // A published document whose withdrawal is due: the unpublish pass
      // withdraws it (and that cancels this pending publish, rule 6); never
      // publish over it, never drop the withdrawal here.
      if (published > 0) return "skipped";
    }
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
      // A failed withdrawal also cancels a pending publish (rule 6): an
      // update must not be published over a withdrawal that did not happen.
      data: {
        scheduleError: code,
        publishAt: null,
        ...(pass === "unpublish" ? { unpublishAt: null } : {}),
      },
    });
    const revision = await advanceRevision(strapi, uid, documentId);
    const prefix = pass === "unpublish" ? "unpublish " : "";
    await auditScheduleFailed(strapi, uid, documentId, revision, `${prefix}${code}: ${detail}`);
    return true;
  });
}

/** The readiness targets of a type (lesson → course, wiki page → parent page). */
const READINESS_TARGETS: Readonly<Record<string, { key: string; target: string }>> = {
  [LESSON_UID]: { key: "course", target: COURSE_UID },
  [WIKI_PAGE_UID]: { key: "parent", target: WIKI_PAGE_UID },
};

/**
 * Whether a readiness refusal names a target that is itself due in this
 * minute (a child page sorted before its parent, a lesson beyond the
 * course's batch): then it is retried like a transient failure instead of
 * dropping the schedule.
 */
async function blockedByDueTarget(
  strapi: ScheduledPublishStrapi,
  uid: string,
  documentId: string,
  error: unknown,
  now: Date,
): Promise<boolean> {
  const readiness = READINESS_TARGETS[uid];
  if (!readiness || !(error instanceof NotPublishableError)) return false;
  if (!error.keys.includes(readiness.key)) return false;
  const draft = await strapi.db.query(uid).findOne({
    where: { documentId, publishedAt: null },
    populate: { [readiness.key]: { select: ["documentId"] } },
  });
  const linked = draft?.[readiness.key] as { documentId?: unknown } | null | undefined;
  if (!linked || !isDocumentId(linked.documentId)) return false;
  const target = await strapi.db.query(readiness.target).findOne({
    where: { documentId: linked.documentId, publishedAt: null },
    select: ["id", "publishAt"],
  });
  return target !== null && isDue(target.publishAt, now);
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
    if (outcome !== "skipped") attempts.clear(uid, documentId, r, pass);
    return;
  } catch (error) {
    const failure = classifyScheduleFailure(error);
    const retry =
      failure.kind === "transient" ||
      (pass === "publish" && (await blockedByDueTarget(strapi, uid, documentId, error, now)));
    let code: ScheduleErrorCode;
    if (retry) {
      if (!attempts.fail(uid, documentId, r, pass)) {
        strapi.log.warn(`${SCHEDULER_LOG} ${key} ${pass} will be retried: ${failure.detail}`);
        result.retrying.push(key);
        return;
      }
      code = "retryExhausted";
    } else {
      code = failure.kind === "permanent" ? failure.code : "retryExhausted";
    }
    try {
      if (await recordScheduleFailure(strapi, uid, documentId, r, pass, code, failure.detail)) {
        attempts.clear(uid, documentId, r, pass);
        strapi.log.error(`${SCHEDULER_LOG} ${key} failed: ${code}`);
        result.failed.push(key);
      } else {
        result.skipped.push(key);
      }
    } catch (recordError) {
      // The next run retries the document (its schedule is untouched).
      strapi.log.error(
        `${SCHEDULER_LOG} ${key} failed: ${code}, and recording it failed too: ` +
          describeFailure(recordError),
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
  const runPass = async (uid: string, pass: Pass, documentIds: string[]) => {
    for (const documentId of documentIds) {
      const r = await readRevision(strapi, uid, documentId);
      await runScheduledDocument(strapi, uid, documentId, pass, now, attempts, result, r);
    }
  };
  await runInAuthoringScope({ source: "cron" }, async () => {
    for (const uid of SCHEDULED_UIDS) {
      if (isUnpublishScheduledUid(uid)) {
        await runPass(uid, "unpublish", await dueUnpublishes(strapi, uid, now));
      }
      await runPass(uid, "publish", await duePublishes(strapi, uid, now));
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
