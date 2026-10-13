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
  isKnownTransient,
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
 * transaction.
 *
 * DEPENDENCIES. A lesson needs its course published, a wiki page its parent
 * (publish readiness). The publish selection passes over a draft whose
 * course or parent is itself unpublished and due (it waits for that one),
 * so it never fills the batch in front of the course or parent it waits
 * for: those come later in the order when their own time is later, and
 * would otherwise never be reached while enough children are due (50 child
 * pages scheduled before their parent kept the parent out of every batch,
 * and the children's retries ran out). Courses are walked before lessons,
 * so a due course is published before the lesson pass selects. A child
 * passed over is published the minute after its course or parent (one
 * level of a chain per minute). Up to PUBLISH_MAX_PAGES pages of
 * PUBLISH_PAGE rows are read until SCHEDULE_BATCH actionable drafts are
 * found. A refusal at publish time whose course or parent became due after
 * the selection is a wait, not a failure: it costs no retry attempt (the
 * course or parent runs on its own and either publishes, or fails for good
 * and loses its schedule, which ends the wait).
 *
 * Then ONE transaction per document:
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
 * cancels a pending publish (schedule-clear). The publish pass never
 * publishes a published document whose withdrawal is due: that is the
 * unpublish pass's, also while it is being retried.
 *
 * A WITHDRAWAL IS NEVER GIVEN UP. One that fails for good (a permanent
 * failure, or SCHEDULE_TRANSIENT_ATTEMPTS transient ones) records
 * `scheduleError` and an audit row once, keeps `unpublishAt` (and a pending
 * publish, which the publish pass then leaves alone), and is retried after
 * WITHDRAWAL_BACKOFF_MINUTES (5, 15, then every 60 minutes; sooner when the
 * document changed in between), until it succeeds (which clears the marker)
 * or an author changes or clears the deadline. The read paths do not
 * enforce `unpublishAt` (it is a draft-row setting, rule 2), so until then
 * the item stays visible: the `[scheduler] … failed` line and the marker
 * are the signal.
 *
 * THE CLOCK. The selection uses the run's start; every due, expiry and
 * withdrawal check is made with a time sampled after the document's lock
 * and its draft read, immediately before the claim, so a run that waited
 * for a lock, or worked through earlier documents, past a deadline does not
 * publish what the deadline ended.
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
 *     sets `scheduleError`, clears `publishAt` (a publish; a withdrawal
 *     keeps its deadline, above) raw, advances the revision and writes
 *     `scheduleFailed`;
 *   - transient (lock or serialisation failures, a lost connection,
 *     SQLITE_BUSY, anything unknown): the schedule stays and the next
 *     minute retries; the SCHEDULE_TRANSIENT_ATTEMPTS-th failure for the
 *     same (uid, documentId, r, pass) in this process is recorded as
 *     `retryExhausted`. A restart forgets the count (only adds retries);
 *   - a readiness refusal whose course or parent is itself unpublished and
 *     due (DEPENDENCIES above): the schedule stays, the next minute tries
 *     again, and no attempt is counted.
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

/** Transient failures and deferred withdrawals of this process (rule 7). */
const processAttempts = new TransientAttempts();

/** The time source of a run, sampled again after each document's lock (expiry, withdrawal). */
export type ScheduleClock = () => Date;

const label = (uid: string, documentId: string) => `${uid} ${documentId}`;

const isDocumentId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** Rows per page of the unpublish selection, and pages per run. */
const UNPUBLISH_PAGE = 200;
const UNPUBLISH_MAX_PAGES = 10;

/** Rows per page of the publish selection of a type with dependencies, and pages per run. */
const PUBLISH_PAGE = 200;
const PUBLISH_MAX_PAGES = 10;

/** The readiness targets of a type (lesson → course, wiki page → parent page). */
const READINESS_TARGETS: Readonly<Record<string, { key: string; target: string }>> = {
  [LESSON_UID]: { key: "course", target: COURSE_UID },
  [WIKI_PAGE_UID]: { key: "parent", target: WIKI_PAGE_UID },
};

const linkedDocumentId = (row: Record<string, unknown>, key: string): string | null => {
  const linked = row[key] as { documentId?: unknown } | null | undefined;
  return linked && isDocumentId(linked.documentId) ? linked.documentId : null;
};

/**
 * Of `targetIds` (documentIds of `targetUid`), those that wait for their own
 * publish: no published row, and a draft whose publishAt has passed.
 */
async function dueUnpublishedTargets(
  strapi: ScheduledPublishStrapi,
  targetUid: string,
  targetIds: readonly string[],
  now: Date,
): Promise<Set<string>> {
  if (targetIds.length === 0) return new Set();
  const query = strapi.db.query(targetUid);
  const published = new Set(
    (
      await query.findMany({
        where: { documentId: { $in: [...targetIds] }, publishedAt: { $notNull: true } },
        select: ["documentId"],
      })
    ).map((row) => row.documentId),
  );
  const unpublished = targetIds.filter((id) => !published.has(id));
  if (unpublished.length === 0) return new Set();
  return new Set(
    (
      await query.findMany({
        where: {
          documentId: { $in: unpublished },
          publishedAt: null,
          publishAt: { $notNull: true, $lte: now },
        },
        select: ["documentId"],
      })
    )
      .map((row) => row.documentId)
      .filter(isDocumentId),
  );
}

/**
 * The due publishes (rule 4): draft rows with publishAt passed, ordered and
 * bounded. For a type with a readiness target, a draft whose course or
 * parent is unpublished and due is passed over and never fills the page
 * (see DEPENDENCIES in the module comment).
 */
async function duePublishes(
  strapi: ScheduledPublishStrapi,
  uid: string,
  now: Date,
): Promise<string[]> {
  const query = strapi.db.query(uid);
  const where = { publishedAt: null, publishAt: { $notNull: true, $lte: now } };
  const orderBy = [{ publishAt: "asc" }, { id: "asc" }];
  const readiness = READINESS_TARGETS[uid];
  if (!readiness) {
    const rows = await query.findMany({
      where,
      select: ["id", "documentId", "publishAt"],
      orderBy,
      limit: SCHEDULE_BATCH,
    });
    return rows.map((row) => row.documentId).filter(isDocumentId);
  }
  const actionable: string[] = [];
  for (let page = 0; page < PUBLISH_MAX_PAGES && actionable.length < SCHEDULE_BATCH; page += 1) {
    const rows = await query.findMany({
      where,
      select: ["id", "documentId", "publishAt"],
      populate: { [readiness.key]: { select: ["documentId"] } },
      orderBy,
      offset: page * PUBLISH_PAGE,
      limit: PUBLISH_PAGE,
    });
    const targets = [
      ...new Set(rows.map((row) => linkedDocumentId(row, readiness.key)).filter(isDocumentId)),
    ];
    const waiting = await dueUnpublishedTargets(strapi, readiness.target, targets, now);
    for (const row of rows) {
      if (!isDocumentId(row.documentId)) continue;
      const target = linkedDocumentId(row, readiness.key);
      if (target !== null && waiting.has(target)) continue;
      actionable.push(row.documentId);
      if (actionable.length >= SCHEDULE_BATCH) break;
    }
    if (rows.length < PUBLISH_PAGE) break;
  }
  return actionable;
}

/**
 * The due unpublishes (rule 4): draft rows with unpublishAt passed whose
 * document is published, or that have no pending publish (the claim then
 * only clears the field). Passed over, and never filling the page: a draft
 * with a pending publish and no published row (the publish pass's: its
 * window ended), and a failed withdrawal whose backoff is not over (unless
 * the document changed since). Up to UNPUBLISH_MAX_PAGES pages are read
 * until SCHEDULE_BATCH actionable documents are found.
 */
async function dueUnpublishes(
  strapi: ScheduledPublishStrapi,
  uid: string,
  now: Date,
  attempts: TransientAttempts,
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
      if (!published.has(row.documentId) && pendingPublish) continue;
      if (attempts.withdrawalFailures(uid, row.documentId) > 0) {
        const revision = await readRevision(strapi, uid, row.documentId);
        if (!attempts.withdrawalReady(uid, row.documentId, now, revision)) continue;
      }
      actionable.push(row.documentId);
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

/**
 * Unpublish pass, one document (see the module comment). The time of the
 * due check is sampled after the lock and the draft read.
 */
async function unpublishOne(
  strapi: ScheduledPublishStrapi,
  uid: string,
  documentId: string,
  r: number,
  clock: ScheduleClock,
): Promise<keyof ScheduleRunResult> {
  return strapi.db.transaction(async () => {
    if ((await lockDocument(strapi, uid, documentId)) !== r) return "skipped";
    const draft = await draftOf(strapi, uid, documentId);
    const at = clock();
    if (!draft || !isDue(draft.unpublishAt, at)) return "skipped";
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
    if (draft.scheduleError !== null && draft.scheduleError !== undefined) {
      // A withdrawal that failed before and succeeds now: the marker goes.
      await strapi.db.query(uid).updateMany({
        where: { documentId, publishedAt: null },
        data: { scheduleError: null },
      });
    }
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

/**
 * Publish pass, one document (see the module comment). The time of the
 * expiry and withdrawal checks is sampled after the lock and the draft
 * read, immediately before the claim and the publish: a run that waited
 * for a lock, or worked through earlier documents, past a deadline does
 * not publish what that deadline ended.
 */
async function publishOne(
  strapi: ScheduledPublishStrapi,
  uid: string,
  documentId: string,
  r: number,
  clock: ScheduleClock,
): Promise<keyof ScheduleRunResult> {
  return strapi.db.transaction(async () => {
    if ((await lockDocument(strapi, uid, documentId)) !== r) return "skipped";
    const draft = await draftOf(strapi, uid, documentId);
    const at = clock();
    if (!draft || !isDue(draft.publishAt, at)) return "skipped";
    if (isUnpublishScheduledUid(uid) && isDue(draft.unpublishAt, at)) {
      const published = await publishedCount(strapi, uid, documentId);
      // A published document whose withdrawal is due: the unpublish pass
      // withdraws it (and that cancels this pending publish, rule 6); never
      // publish over it, never drop the withdrawal here.
      if (published > 0) return "skipped";
    }
    if (windowExpired(uid, draft, at)) {
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
 * `r`. Returns the revision it left the document at, or null when a newer
 * revision superseded the failure (nothing recorded).
 *   - publish: `scheduleError = <code>`, `publishAt` cleared;
 *   - unpublish: `scheduleError = <code>` only. The withdrawal stays pending
 *     (its `unpublishAt` and a pending publish are kept): it is retried with
 *     a bounded backoff until it succeeds, or an author changes or clears
 *     the deadline. A repeat of the same failure writes nothing (no new
 *     revision, no new audit row).
 */
export async function recordScheduleFailure(
  strapi: ScheduledPublishStrapi,
  uid: string,
  documentId: string,
  r: number,
  pass: Pass,
  code: ScheduleErrorCode,
  detail: string,
): Promise<number | null> {
  return strapi.db.transaction(async () => {
    if ((await lockDocument(strapi, uid, documentId)) !== r) return null;
    if (pass === "unpublish") {
      const draft = await draftOf(strapi, uid, documentId);
      if (draft?.scheduleError === code) return r;
    }
    await strapi.db.query(uid).updateMany({
      where: { documentId, publishedAt: null },
      data: pass === "publish" ? { scheduleError: code, publishAt: null } : { scheduleError: code },
    });
    const revision = await advanceRevision(strapi, uid, documentId);
    const prefix = pass === "unpublish" ? "unpublish " : "";
    await auditScheduleFailed(strapi, uid, documentId, revision, `${prefix}${code}: ${detail}`);
    return revision;
  });
}

/**
 * Whether a readiness refusal names a target that is itself unpublished and
 * due (it became due after the selection, or lies beyond the course's
 * batch): then the draft waits for it, without a counted attempt, instead
 * of dropping the schedule.
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
  const linked = draft ? linkedDocumentId(draft, readiness.key) : null;
  if (linked === null) return false;
  return (await dueUnpublishedTargets(strapi, readiness.target, [linked], now)).has(linked);
}

const clockOf = (time: Date | ScheduleClock): ScheduleClock =>
  typeof time === "function" ? time : () => time;

/**
 * One document of one pass: the transaction, and the failure handling.
 * `r` is the revision the selection read (exported for the tests, which
 * hand it a stale one); `time` is the run's clock (or a fixed instant).
 */
export async function runScheduledDocument(
  strapi: ScheduledPublishStrapi,
  uid: string,
  documentId: string,
  pass: Pass,
  time: Date | ScheduleClock,
  attempts: TransientAttempts,
  result: ScheduleRunResult,
  r: number,
): Promise<void> {
  const key = label(uid, documentId);
  const clock = clockOf(time);
  try {
    const outcome =
      pass === "publish"
        ? await publishOne(strapi, uid, documentId, r, clock)
        : await unpublishOne(strapi, uid, documentId, r, clock);
    result[outcome].push(key);
    if (outcome !== "skipped") {
      attempts.clear(uid, documentId, r, pass);
      if (pass === "unpublish") attempts.clearWithdrawal(uid, documentId);
    }
    return;
  } catch (error) {
    const failure = classifyScheduleFailure(error);
    // A withdrawal already deferred once goes straight back into its backoff.
    const deferred = pass === "unpublish" && attempts.withdrawalFailures(uid, documentId) > 0;
    // A course or parent that is due itself: wait for it, no attempt counted.
    if (
      pass === "publish" &&
      failure.kind === "permanent" &&
      (await blockedByDueTarget(strapi, uid, documentId, error, clock()))
    ) {
      strapi.log.warn(
        `${SCHEDULER_LOG} ${key} publish waits for its course or parent, which is due itself`,
      );
      result.retrying.push(key);
      return;
    }
    const retry = !deferred && failure.kind === "transient";
    let code: ScheduleErrorCode;
    if (retry) {
      if (!attempts.fail(uid, documentId, r, pass)) {
        // A known lock or connection code is routine; anything else is worth a look.
        const kind = isKnownTransient(error) ? "transient" : "unexpected";
        strapi.log.warn(
          `${SCHEDULER_LOG} ${key} ${pass} will be retried (${kind} failure: ${failure.detail})`,
        );
        result.retrying.push(key);
        return;
      }
      code = "retryExhausted";
    } else {
      code = failure.kind === "permanent" ? failure.code : "retryExhausted";
    }
    try {
      const revision = await recordScheduleFailure(
        strapi,
        uid,
        documentId,
        r,
        pass,
        code,
        failure.detail,
      );
      if (revision === null) {
        result.skipped.push(key);
        return;
      }
      attempts.clear(uid, documentId, r, pass);
      if (pass === "unpublish") {
        const next = attempts.deferWithdrawal(uid, documentId, clock(), revision);
        strapi.log.error(
          `${SCHEDULER_LOG} ${key} failed: ${code}; the withdrawal stays pending, next attempt ` +
            `after ${next.toISOString()}`,
        );
      } else {
        strapi.log.error(`${SCHEDULER_LOG} ${key} failed: ${code}`);
      }
      result.failed.push(key);
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
 * One run of the task (see the module comment). `now` (the selection time),
 * `attempts` and `clock` (sampled after each document's lock) are
 * injectable for the tests; a fixed `now` without a clock fixes both.
 */
export async function runScheduledPublishing(
  strapi: ScheduledPublishStrapi,
  now?: Date,
  attempts: TransientAttempts = processAttempts,
  clock?: ScheduleClock,
): Promise<ScheduleRunResult> {
  const start = now ?? new Date();
  const tick: ScheduleClock = clock ?? (now ? () => now : () => new Date());
  const result = emptyResult();
  const runPass = async (uid: string, pass: Pass, documentIds: string[]) => {
    for (const documentId of documentIds) {
      const r = await readRevision(strapi, uid, documentId);
      await runScheduledDocument(strapi, uid, documentId, pass, tick, attempts, result, r);
    }
  };
  await runInAuthoringScope({ source: "cron" }, async () => {
    for (const uid of SCHEDULED_UIDS) {
      if (isUnpublishScheduledUid(uid)) {
        await runPass(uid, "unpublish", await dueUnpublishes(strapi, uid, start, attempts));
      }
      await runPass(uid, "publish", await duePublishes(strapi, uid, start));
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
