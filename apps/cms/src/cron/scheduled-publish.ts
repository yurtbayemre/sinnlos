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
import {
  NotPublishableError,
  draftPublishBlockers,
  type PublishReadinessHost,
} from "../utils/publish-readiness";
import {
  SCHEDULE_BATCH,
  TransientAttempts,
  WITHDRAWAL_RETRY_QUOTA,
  WITHDRAWAL_RETRY_SCAN,
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
 * (publish readiness). A draft WAITS while its course or parent has no
 * published row and a due draft (publishAt passed), but only for
 * DEPENDENCY_WAIT_MINUTES after its own publishAt. The publish selection
 * excludes waiting drafts in the database query itself (NOT EXISTS over the
 * link table and the target's rows), so the batch holds only drafts that
 * can run, and a course or parent scheduled later than any number of its
 * waiting children is still selected. Courses are walked before lessons, so
 * a due course is published before the lesson pass selects; a waiting
 * child is published the minute after its course or parent. Once its wait
 * is over a draft is selected like any other: if readiness still refuses
 * it, it is recorded `notPublishable`. Parent chains that loop back (the
 * admin panel allows A under B and B under A) or that are too deep end this
 * way, without walking them.
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
 * Such waiting drafts are left out when the selection is read, so they
 * never fill the batch in front of due withdrawals. The selection has two
 * tiers (issue #73), so a failing withdrawal never hides a healthy one:
 *   1. the healthy ones: due, `scheduleError` NULL (never failed for good),
 *      in deadline order, the waiting drafts excluded in the query itself;
 *   2. the failing ones (`scheduleError` set), up to WITHDRAWAL_RETRY_QUOTA
 *      attempts per run whatever tier 1 holds: read through a per-process,
 *      per-type keyset cursor over the draft row ids (after the last row
 *      examined; at the end it wraps to the start), at most
 *      WITHDRAWAL_RETRY_SCAN rows examined per run, each filtered by its
 *      backoff. The cursor moves over every row it examined and stops at
 *      the last attempted one when the quota is full, so every ready
 *      failure is attempted within ⌈N / WITHDRAWAL_RETRY_QUOTA⌉ runs even
 *      while tier 1 stays full. A restart resets the cursor and the
 *      backoff (it only adds retries).
 * Tier 1 takes the rest of SCHEDULE_BATCH. An unpublish also
 * cancels a pending publish (schedule-clear). The publish pass never
 * publishes a published document whose withdrawal is due: that is the
 * unpublish pass's, also while it is being retried. Its selection leaves
 * such documents out in the query (they would fill its batch while their
 * withdrawals back off), and the publish re-checks it under the lock.
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
 *   - a readiness refusal (`notPublishable`) is judged again under the
 *     failure record's lock with a fresh clock: the stored draft's
 *     publish blockers are computed anew, and the refusal is recorded only
 *     when something still blocks AND the draft no longer waits
 *     (DEPENDENCIES). Otherwise nothing is written, no attempt is counted
 *     and the schedule stays (a course or parent published in between: the
 *     next minute publishes the draft; one that became due: it waits).
 *
 * TIME OF CHECK. Nothing read before a document's lock decides a write:
 * the selection (due, waiting, a withdrawal's backoff or precedence) only
 * picks candidates; under the lock the revision must be the selected one,
 * and due, expiry, the withdrawal precedence, a pending publish and the
 * readiness refusal are judged again on the locked rows with a clock
 * sampled after the lock. A save in between moves the revision (skipped)
 * or changes what the re-check sees.
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
    /** The Postgres schema of the connection (none on SQLite). */
    getSchemaName?(): string | null | undefined;
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
  /** The models' schemas (publish readiness reads the required attributes). */
  getModel: PublishReadinessHost["getModel"];
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

/** The readiness targets of a type (lesson → course, wiki page → parent page). */
const READINESS_TARGETS: Readonly<Record<string, { key: string; target: string }>> = {
  [LESSON_UID]: { key: "course", target: COURSE_UID },
  [WIKI_PAGE_UID]: { key: "parent", target: WIKI_PAGE_UID },
};

/**
 * Minutes a due draft waits for its course or parent (DEPENDENCIES in the
 * module comment), counted from its own publishAt. After that it is
 * selected like any other, and a refusal is recorded.
 */
export const DEPENDENCY_WAIT_MINUTES = 60;
const DEPENDENCY_WAIT_MS = DEPENDENCY_WAIT_MINUTES * 60_000;

const linkedDocumentId = (row: Record<string, unknown>, key: string): string | null => {
  const linked = row[key] as { documentId?: unknown } | null | undefined;
  return linked && isDocumentId(linked.documentId) ? linked.documentId : null;
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** A model's table (schema-qualified on Postgres) and a column lookup, from Strapi's metadata. */
function modelNames(strapi: ScheduledPublishStrapi, uid: string) {
  const meta = strapi.db.metadata.get(uid) as unknown;
  const tableName = field(meta, "tableName");
  if (!isName(tableName)) throw new Error(`${SCHEDULER_LOG} the model ${uid} is not loaded`);
  const schema = strapi.db.getSchemaName?.() || null;
  const attributes = field(meta, "attributes");
  return {
    attributes,
    table: schema ? `${schema}.${tableName}` : tableName,
    qualified: (name: string) => (schema ? `${schema}.${name}` : name),
    column: (attribute: string, fallback: string) => {
      const name = field(field(attributes, attribute), "columnName");
      return isName(name) ? name : fallback;
    },
  };
}

/** Whether `uid` has its readiness relation (a model without it waits for nothing). */
function hasReadinessRelation(strapi: ScheduledPublishStrapi, uid: string): boolean {
  const readiness = READINESS_TARGETS[uid];
  if (!readiness) return false;
  return (
    field(field(strapi.db.metadata.get(uid) as unknown, "attributes"), readiness.key) !== undefined
  );
}

const rawRows = (result: unknown): Record<string, unknown>[] => {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = field(result, "rows");
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
};

/**
 * The due publishes (rule 4): draft rows with publishAt passed, ordered by
 * the due time, then the row id, at most SCHEDULE_BATCH. One read query,
 * so the database pages over runnable drafts only. It leaves out:
 *   - documents and quick links that have a published row and a due
 *     withdrawal (the unpublish pass's; an unpublished draft with a passed
 *     unpublishAt stays, for the expired-window rule);
 *   - lessons and wiki pages that wait for their course or parent
 *     (DEPENDENCIES): its link holds a document with a due draft and no
 *     published row, and the draft's own publishAt is less than
 *     DEPENDENCY_WAIT_MINUTES ago.
 */
async function duePublishes(
  strapi: ScheduledPublishStrapi,
  uid: string,
  now: Date,
): Promise<string[]> {
  const own = modelNames(strapi, uid);
  const id = own.column("id", "id");
  const documentId = own.column("documentId", "document_id");
  const publishedAt = own.column("publishedAt", "published_at");
  const publishAt = own.column("publishAt", "publish_at");
  let sql = `SELECT d.?? AS document_id FROM ?? AS d
     WHERE d.?? IS NULL AND d.?? IS NOT NULL AND d.?? <= ?`;
  const bindings: unknown[] = [documentId, own.table, publishedAt, publishAt, publishAt, now];
  if (isUnpublishScheduledUid(uid)) {
    const unpublishAt = own.column("unpublishAt", "unpublish_at");
    sql += `
       AND NOT (d.?? IS NOT NULL AND d.?? <= ?
                AND EXISTS (SELECT 1 FROM ?? AS q WHERE q.?? = d.?? AND q.?? IS NOT NULL))`;
    bindings.push(unpublishAt, unpublishAt, now, own.table, documentId, documentId, publishedAt);
  }
  const readiness = READINESS_TARGETS[uid];
  if (readiness && hasReadinessRelation(strapi, uid)) {
    const target = modelNames(strapi, readiness.target);
    const joinTable = field(field(own.attributes, readiness.key), "joinTable");
    const link = field(joinTable, "name");
    const linkRow = field(field(joinTable, "joinColumn"), "name");
    const linkTarget = field(field(joinTable, "inverseJoinColumn"), "name");
    if (!isName(link) || !isName(linkRow) || !isName(linkTarget)) {
      throw new Error(`${SCHEDULER_LOG} the link table of ${uid}.${readiness.key} is unknown`);
    }
    const targetId = target.column("id", "id");
    const targetDocumentId = target.column("documentId", "document_id");
    const targetPublishedAt = target.column("publishedAt", "published_at");
    const targetPublishAt = target.column("publishAt", "publish_at");
    sql += `
       AND (d.?? <= ? OR NOT EXISTS (
             SELECT 1 FROM ?? AS l JOIN ?? AS p ON p.?? = l.??
              WHERE l.?? = d.??
                AND EXISTS (SELECT 1 FROM ?? AS w WHERE w.?? = p.?? AND w.?? IS NULL
                              AND w.?? IS NOT NULL AND w.?? <= ?)
                AND NOT EXISTS (SELECT 1 FROM ?? AS x WHERE x.?? = p.?? AND x.?? IS NOT NULL)))`;
    bindings.push(
      publishAt,
      new Date(now.getTime() - DEPENDENCY_WAIT_MS),
      own.qualified(link),
      target.table,
      targetId,
      linkTarget,
      linkRow,
      id,
      target.table,
      targetDocumentId,
      targetDocumentId,
      targetPublishedAt,
      targetPublishAt,
      targetPublishAt,
      now,
      target.table,
      targetDocumentId,
      targetDocumentId,
      targetPublishedAt,
    );
  }
  sql += `
     ORDER BY d.?? ASC, d.?? ASC
     LIMIT ?`;
  bindings.push(publishAt, id, SCHEDULE_BATCH);
  const rows = rawRows(await strapi.db.connection.raw(sql, bindings));
  return rows.map((row) => row.document_id).filter(isDocumentId);
}

/**
 * Whether a withdrawal may be attempted now: it never failed in this
 * process, or its backoff is over, or the document changed since.
 */
async function backoffOver(
  strapi: ScheduledPublishStrapi,
  uid: string,
  documentId: string,
  now: Date,
  attempts: TransientAttempts,
): Promise<boolean> {
  if (attempts.withdrawalFailures(uid, documentId) === 0) return true;
  const revision = await readRevision(strapi, uid, documentId);
  return attempts.withdrawalReady(uid, documentId, now, revision);
}

/**
 * Tier 1 of the due unpublishes (UNPUBLISHES in the module comment): draft
 * rows with unpublishAt passed and no `scheduleError`, in deadline order,
 * at most `limit`. One read query: a draft with a pending publish whose
 * document has no published row (the publish pass's: its window ended) is
 * left out in the query, so it never takes a slot. The backoff check stays
 * as a safeguard (a withdrawal backs off only after recording
 * `scheduleError`, so it holds here only for a row cleared without a save).
 */
async function healthyWithdrawals(
  strapi: ScheduledPublishStrapi,
  uid: string,
  now: Date,
  attempts: TransientAttempts,
  limit: number,
): Promise<string[]> {
  const own = modelNames(strapi, uid);
  const id = own.column("id", "id");
  const documentId = own.column("documentId", "document_id");
  const publishedAt = own.column("publishedAt", "published_at");
  const publishAt = own.column("publishAt", "publish_at");
  const unpublishAt = own.column("unpublishAt", "unpublish_at");
  const scheduleError = own.column("scheduleError", "schedule_error");
  const sql = `SELECT d.?? AS document_id FROM ?? AS d
     WHERE d.?? IS NULL AND d.?? IS NOT NULL AND d.?? <= ? AND d.?? IS NULL
       AND NOT (d.?? IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM ?? AS q WHERE q.?? = d.?? AND q.?? IS NOT NULL))
     ORDER BY d.?? ASC, d.?? ASC
     LIMIT ?`;
  const bindings = [
    documentId,
    own.table,
    publishedAt,
    unpublishAt,
    unpublishAt,
    now,
    scheduleError,
    publishAt,
    own.table,
    documentId,
    documentId,
    publishedAt,
    unpublishAt,
    id,
    limit,
  ];
  const rows = rawRows(await strapi.db.connection.raw(sql, bindings));
  const ready: string[] = [];
  for (const row of rows) {
    if (!isDocumentId(row.document_id)) continue;
    if (await backoffOver(strapi, uid, row.document_id, now, attempts)) ready.push(row.document_id);
  }
  return ready;
}

/**
 * Tier 2 of the due unpublishes (UNPUBLISHES in the module comment): up to
 * WITHDRAWAL_RETRY_QUOTA failed withdrawals whose backoff is over, read
 * from the type's keyset cursor (draft row ids after the last examined
 * one, wrapping once at the end, never past where the run started), at
 * most WITHDRAWAL_RETRY_SCAN rows examined. Stores the cursor for the next
 * run: the last attempted row when the quota is full, else the last
 * examined one, or the start after a full circle.
 */
async function retryWithdrawals(
  strapi: ScheduledPublishStrapi,
  uid: string,
  now: Date,
  attempts: TransientAttempts,
): Promise<string[]> {
  const query = strapi.db.query(uid);
  const start = attempts.withdrawalCursor(uid);
  const picked: string[] = [];
  let cursor = start;
  let examined = 0;
  let wrapped = false;
  while (examined < WITHDRAWAL_RETRY_SCAN && picked.length < WITHDRAWAL_RETRY_QUOTA) {
    const limit = WITHDRAWAL_RETRY_SCAN - examined;
    const rows = await query.findMany({
      where: {
        publishedAt: null,
        unpublishAt: { $notNull: true, $lte: now },
        scheduleError: { $notNull: true },
        id: wrapped ? { $gt: cursor, $lte: start } : { $gt: cursor },
      },
      select: ["id", "documentId", "publishAt"],
      orderBy: { id: "asc" },
      limit,
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
      examined += 1;
      cursor = Number(row.id);
      if (!isDocumentId(row.documentId)) continue;
      const pendingPublish = row.publishAt !== null && row.publishAt !== undefined;
      if (!published.has(row.documentId) && pendingPublish) continue;
      if (!(await backoffOver(strapi, uid, row.documentId, now, attempts))) continue;
      picked.push(row.documentId);
      if (picked.length >= WITHDRAWAL_RETRY_QUOTA) break;
    }
    if (picked.length >= WITHDRAWAL_RETRY_QUOTA || rows.length === limit) continue;
    // The end of the rows: wrap once to the start, or, after a full circle,
    // start the next run at the beginning.
    if (wrapped || start === 0) {
      cursor = 0;
      break;
    }
    wrapped = true;
    cursor = 0;
  }
  attempts.setWithdrawalCursor(uid, cursor);
  return picked;
}

/**
 * The due unpublishes (rule 4; issue #73): the failing withdrawals' reserved
 * quota first, then the healthy ones in the rest of SCHEDULE_BATCH.
 * Healthy ones run first.
 */
async function dueUnpublishes(
  strapi: ScheduledPublishStrapi,
  uid: string,
  now: Date,
  attempts: TransientAttempts,
): Promise<string[]> {
  const retries = await retryWithdrawals(strapi, uid, now, attempts);
  const healthy = await healthyWithdrawals(
    strapi,
    uid,
    now,
    attempts,
    SCHEDULE_BATCH - retries.length,
  );
  return [...healthy, ...retries];
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
 * `stillApplies`, when given, decides again under the lock (the locked
 * rows, a fresh clock) whether the failure holds; when it no longer does,
 * nothing is written and the answer is "stale". A decision that rests on
 * other documents (a course or parent) is never taken from what was read
 * before the lock.
 */
export async function recordScheduleFailure(
  strapi: ScheduledPublishStrapi,
  uid: string,
  documentId: string,
  r: number,
  pass: Pass,
  code: ScheduleErrorCode,
  detail: string,
  stillApplies?: () => Promise<boolean>,
): Promise<number | null | "stale"> {
  return strapi.db.transaction(async () => {
    if ((await lockDocument(strapi, uid, documentId)) !== r) return null;
    if (stillApplies && !(await stillApplies())) return "stale";
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
 * The state of the stored draft's course or parent at `now`, read once
 * (DEPENDENCIES):
 *   - `published`: the linked document has a published row (now);
 *   - `waiting`: it has none but a due draft, and the draft's own publishAt
 *     is less than DEPENDENCY_WAIT_MINUTES ago;
 *   - `none`: no link, the wait is over, or the linked document is neither
 *     published nor due.
 */
async function dependencyState(
  strapi: ScheduledPublishStrapi,
  uid: string,
  documentId: string,
  now: Date,
): Promise<"published" | "waiting" | "none"> {
  const readiness = READINESS_TARGETS[uid];
  if (!readiness || !hasReadinessRelation(strapi, uid)) return "none";
  const draft = await strapi.db.query(uid).findOne({
    where: { documentId, publishedAt: null },
    select: ["id", "publishAt"],
    populate: { [readiness.key]: { select: ["documentId"] } },
  });
  const target = draft ? linkedDocumentId(draft, readiness.key) : null;
  if (!draft || target === null) return "none";
  const query = strapi.db.query(readiness.target);
  const published = await query.count({
    where: { documentId: target, publishedAt: { $notNull: true } },
  });
  if (published > 0) return "published";
  const due = instantOf(draft.publishAt);
  if (due === null || now.getTime() >= due.getTime() + DEPENDENCY_WAIT_MS) return "none";
  const waiting = await query.count({
    where: { documentId: target, publishedAt: null, publishAt: { $notNull: true, $lte: now } },
  });
  return waiting > 0 ? "waiting" : "none";
}

/**
 * Whether a readiness refusal still holds under the lock (FAILURES): the
 * stored draft is still blocked, and, when the block is its course or
 * parent, the draft no longer waits for it. The course or parent is read
 * twice (by the blockers, then here) and is not under this document's
 * lock: when the second read finds it published, it was published in
 * between, so the refusal is stale and the next run publishes the draft
 * (Codex review of batch 15). Nothing is recorded on a contradiction.
 */
async function refusalStillHolds(
  strapi: ScheduledPublishStrapi,
  uid: string,
  documentId: string,
  now: Date,
): Promise<boolean> {
  const blockers = await draftPublishBlockers(strapi, uid, documentId);
  if (blockers === null || blockers.length === 0) return false;
  const readiness = READINESS_TARGETS[uid];
  if (!readiness || !blockers.includes(readiness.key)) return true;
  return (await dependencyState(strapi, uid, documentId, now)) === "none";
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
    const retry = !deferred && failure.kind === "transient";
    // A readiness refusal is judged again under the failure record's lock,
    // with a fresh clock (FAILURES): when nothing blocks any more, or the
    // draft waits for its course or parent, nothing is written and no
    // attempt is counted.
    const stillApplies =
      pass === "publish" && error instanceof NotPublishableError
        ? () => refusalStillHolds(strapi, uid, documentId, clock())
        : undefined;
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
        stillApplies,
      );
      if (revision === "stale") {
        strapi.log.warn(
          `${SCHEDULER_LOG} ${key} publish not recorded as failed: it waits for its course or ` +
            "parent, or nothing blocks it any more (the next run tries again)",
        );
        result.retrying.push(key);
        return;
      }
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
