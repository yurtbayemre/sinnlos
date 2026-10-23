import type { Core } from "@strapi/strapi";
import {
  MAX_VALIDITY_MONTHS,
  addMonthsToKey,
  instantEpochMs,
  receiptDueKey,
  zonedDateKey,
  type TrainingCompletionMode,
  type TrainingEvidenceRow,
  type TrainingSnapshot,
  type TrainingSnapshotRef,
  type TrainingVersion,
} from "@sinnlos/domain";

import { chunks } from "./authoring-controller";
import { lockUserRow, type MfaHost } from "./mfa-core";
import { appTimeZone, todayIn } from "./time";

/**
 * Training evidence (v0.28, deep-dive plan-v028-rev2.md §2, rev3 R2 and
 * rev3.1): what a receipt proves after its course, lesson or learner
 * changed or left, and how long it is kept.
 *
 * THE SNAPSHOT (`lesson-progress.snapshot`, schema-private): the completion
 * writes it from the very rows it checked (snapshotAtCompletion), including
 * the published versions the player showed (TrainingVersion: the course's
 * and the lesson's `publishedAt`, which Strapi sets anew on every publish).
 * It is not an archive of the material, only which published state it was.
 * Receipts from before v0.28 get one later (fillMissingSnapshots) from the
 * rows as they are then, marked `backfilled`: versions, quiz outcome and
 * validity are unknown, never guessed.
 *
 * RETENTION (receiptExpired, a pure rule over the stored rows; no stored
 * deadline), TRAINING_EVIDENCE_RETENTION_YEARS (N, default 3):
 *
 *   | receipt                         | superseded, person active | person anonymised                           |
 *   |---------------------------------|---------------------------|---------------------------------------------|
 *   | known `validUntil`              | validUntil + N            | max(validUntil, anonymisedAt) + N           |
 *   | known no expiry                 | never                     | anonymisedAt + N                            |
 *   | unknown (backfilled, no snapshot) | never                   | max(completedAt + 120 months, anonymisedAt) + N |
 *
 * The newest receipt per (user, lesson) of a person who is not anonymised
 * is never deleted; "newest" is decided over all of that person's rows
 * (completedAt, then id). A deadline is a calendar day in APP_TIME_ZONE;
 * a receipt goes once its deadline lies before today. Blocked alone is not
 * leaving (an unblock is possible): nothing changes. A receipt whose user
 * link is gone (the account was deleted in the panel) has no departure
 * date and stays. Anything unparseable stays: deletion is the irreversible
 * arm.
 */

export const PROGRESS_UID = "api::lesson-progress.lesson-progress";
const LESSON_UID = "api::lesson.lesson";
const USER_UID = "plugin::users-permissions.user";

/** Years a receipt is kept after its deadline (`TRAINING_EVIDENCE_RETENTION_YEARS`, default). */
export const DEFAULT_TRAINING_EVIDENCE_RETENTION_YEARS = 3;
const MIN_RETENTION_YEARS = 1;
const MAX_RETENTION_YEARS = 30;

/** Rows per page of the nightly fill and the retention walk. */
export const TRAINING_EVIDENCE_PAGE = 200;
/** Pages of the nightly fill per run (the rest follows the next night). */
export const SNAPSHOT_FILL_MAX_PAGES = 50;

type DbStrapi = Pick<Core.Strapi, "db">;
type Row = Record<string, unknown>;

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/**
 * TRAINING_EVIDENCE_RETENTION_YEARS: unset or blank = the default; anything
 * but a whole number from 1 to 30 throws (the boot check, utils/env-guard.ts).
 */
export function trainingEvidenceRetentionYears(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.TRAINING_EVIDENCE_RETENTION_YEARS?.trim();
  if (!raw) return DEFAULT_TRAINING_EVIDENCE_RETENTION_YEARS;
  const years = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(years) || years < MIN_RETENTION_YEARS || years > MAX_RETENTION_YEARS) {
    throw new Error(
      `TRAINING_EVIDENCE_RETENTION_YEARS="${raw}" must be a whole number of years from ` +
        `${MIN_RETENTION_YEARS} to ${MAX_RETENTION_YEARS} (unset = ${DEFAULT_TRAINING_EVIDENCE_RETENTION_YEARS}).`,
    );
  }
  return years;
}

// ---------------------------------------------------------------------------
// Versions and the snapshot at completion.

/** A stored instant as ISO 8601 (Date, ISO string or epoch ms, by engine), or null. */
export function publicationStamp(value: unknown): string | null {
  let ms: number | null = null;
  if (value instanceof Date || typeof value === "string") ms = instantEpochMs(value);
  else if (typeof value === "number" && Number.isFinite(value)) ms = value;
  return ms === null ? null : new Date(ms).toISOString();
}

/** The published lesson as utils/training-access.ts loads it (the fields used here). */
export interface VersionedLesson {
  documentId: string;
  title: string;
  publishedAt: unknown;
  course: {
    documentId: string;
    title: string;
    completionMode: TrainingCompletionMode | null;
    validityMonths: number | null;
    publishedAt: unknown;
  };
}

/** The versions the player shows; null when a stamp is unreadable (then nothing completes). */
export function trainingVersionOf(lesson: VersionedLesson): TrainingVersion | null {
  const course = publicationStamp(lesson.course.publishedAt);
  const own = publicationStamp(lesson.publishedAt);
  return course && own ? { course, lesson: own } : null;
}

/** The completion's `version` names exactly `current` (absent or malformed: no). */
export function isSameVersion(sent: unknown, current: TrainingVersion | null): boolean {
  if (!current || !isRecord(sent)) return false;
  return (
    publicationStamp(sent.course) === current.course &&
    publicationStamp(sent.lesson) === current.lesson
  );
}

/** The snapshot a completion stores: the rows it checked, as it checked them. */
export function snapshotAtCompletion(input: {
  lesson: VersionedLesson;
  version: TrainingVersion;
  quizPassed: boolean;
  learner: Row | null;
  completedAt: string;
  timeZone: string;
}): TrainingSnapshot {
  const { lesson, version } = input;
  const validityMonths =
    typeof lesson.course.validityMonths === "number" && lesson.course.validityMonths > 0
      ? lesson.course.validityMonths
      : null;
  return {
    v: 1,
    course: {
      documentId: lesson.course.documentId,
      title: lesson.course.title,
      publishedAt: version.course,
    },
    lesson: { documentId: lesson.documentId, title: lesson.title, publishedAt: version.lesson },
    completionMode: lesson.course.completionMode ?? "confirm",
    quizPassed: input.quizPassed ? true : null,
    validUntil: receiptDueKey(input.completedAt, validityMonths, input.timeZone),
    learner: learnerOf(input.learner),
  };
}

function learnerOf(user: Row | null): TrainingSnapshot["learner"] {
  if (!user || user.anonymisedAt != null) return null;
  return {
    displayName: text(user.displayName) || text(user.username) || `#${String(user.id)}`,
    email: text(user.email),
  };
}

const refOf = (value: unknown): TrainingSnapshotRef | null =>
  isRecord(value) && typeof value.documentId === "string"
    ? {
        documentId: value.documentId,
        title: text(value.title) ?? "",
        publishedAt: text(value.publishedAt),
      }
    : null;

/** A stored snapshot (object, or a string from an older driver), or null when there is none. */
export function parseSnapshot(value: unknown): TrainingSnapshot | null {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(raw) || raw.v !== 1) return null;
  const learner = isRecord(raw.learner)
    ? { displayName: text(raw.learner.displayName) ?? "", email: text(raw.learner.email) }
    : null;
  const mode = raw.completionMode;
  return {
    v: 1,
    course: refOf(raw.course),
    lesson: refOf(raw.lesson),
    completionMode:
      mode === "confirm" || mode === "quizGate" || mode === "exam"
        ? (mode as TrainingCompletionMode)
        : null,
    quizPassed: raw.quizPassed === true ? true : null,
    validUntil: text(raw.validUntil),
    learner,
    ...(raw.backfilled === true ? { backfilled: true as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// Snapshots for receipts that have none.

/**
 * Fills `snapshot IS NULL` receipts from the rows as they are now, marked
 * `backfilled` (versions, quiz outcome and validity unknown; a vanished
 * course or lesson null; no learner for an anonymised or missing user).
 * Each write re-checks `snapshot IS NULL`, so a filled snapshot is never
 * overwritten. `userId` limits it to one person (the anonymisation, inside
 * its transaction, until none is left); otherwise at most `maxPages` pages,
 * each in its own transaction (the nightly job; resumable by its where).
 * Returns the rows filled.
 */
export async function fillMissingSnapshots(
  strapi: DbStrapi,
  options: { userId?: number; maxPages?: number; ownTransactions?: boolean } = {},
): Promise<number> {
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  let filled = 0;
  let afterId = 0;
  for (let page = 0; page < maxPages; page++) {
    const where: Row = { snapshot: { $null: true }, id: { $gt: afterId } };
    if (options.userId !== undefined) where.user = { id: options.userId };
    const batch = rows(
      await strapi.db.query(PROGRESS_UID).findMany({
        where,
        select: ["id", "targetDocumentId", "completedAt"],
        populate: {
          user: { select: ["id", "username", "displayName", "email", "anonymisedAt"] },
        },
        orderBy: [{ id: "asc" }],
        limit: TRAINING_EVIDENCE_PAGE,
      }),
    );
    if (batch.length === 0) break;
    afterId = batch[batch.length - 1].id as number;
    const write = async () => {
      const lessons = await currentLessons(
        strapi,
        batch.map((row) => text(row.targetDocumentId)).filter((id): id is string => id !== null),
      );
      for (const row of batch) {
        const snapshot = backfilledSnapshot(
          lessons.get(text(row.targetDocumentId) ?? ""),
          isRecord(row.user) ? row.user : null,
        );
        const result = await strapi.db.query(PROGRESS_UID).updateMany({
          where: { id: row.id, snapshot: { $null: true } },
          data: { snapshot },
        });
        filled += (result as { count?: number })?.count ?? 0;
      }
    };
    if (options.ownTransactions) await strapi.db.transaction(write);
    else await write();
  }
  return filled;
}

/** documentId → the lesson (published row first) with its course (published row first). */
async function currentLessons(strapi: DbStrapi, documentIds: string[]): Promise<Map<string, Row>> {
  const found = new Map<string, Row>();
  for (const chunk of chunks([...new Set(documentIds)], TRAINING_EVIDENCE_PAGE)) {
    const lessons = rows(
      await strapi.db.query(LESSON_UID).findMany({
        where: { documentId: { $in: chunk } },
        select: ["id", "documentId", "title", "publishedAt"],
        populate: {
          course: { select: ["id", "documentId", "title", "completionMode", "publishedAt"] },
        },
        orderBy: [{ id: "asc" }],
      }),
    );
    for (const lesson of lessons) {
      const id = text(lesson.documentId);
      if (id === null) continue;
      const kept = found.get(id);
      if (!kept || (kept.publishedAt == null && lesson.publishedAt != null)) found.set(id, lesson);
    }
  }
  return found;
}

function backfilledSnapshot(lesson: Row | undefined, user: Row | null): TrainingSnapshot {
  const course = lesson && isRecord(lesson.course) ? lesson.course : null;
  const mode = course?.completionMode;
  return {
    v: 1,
    course:
      course && typeof course.documentId === "string"
        ? { documentId: course.documentId, title: text(course.title) ?? "", publishedAt: null }
        : null,
    lesson:
      lesson && typeof lesson.documentId === "string"
        ? { documentId: lesson.documentId, title: text(lesson.title) ?? "", publishedAt: null }
        : null,
    completionMode:
      mode === "confirm" || mode === "quizGate" || mode === "exam"
        ? (mode as TrainingCompletionMode)
        : null,
    quizPassed: null,
    validUntil: null,
    learner: learnerOf(user),
    backfilled: true,
  };
}

// ---------------------------------------------------------------------------
// Retention.

export type ReceiptValidity =
  { kind: "until"; key: string } | { kind: "noExpiry" } | { kind: "unknown" };

/** What the snapshot knows about the receipt's validity. */
export function validityOf(snapshot: TrainingSnapshot | null): ReceiptValidity {
  if (!snapshot || snapshot.backfilled) return { kind: "unknown" };
  return snapshot.validUntil ? { kind: "until", key: snapshot.validUntil } : { kind: "noExpiry" };
}

export interface RetentionReceipt {
  id: number;
  completedAt: string | null;
  snapshot: TrainingSnapshot | null;
}

const laterKey = (a: string, b: string): string => (a > b ? a : b);

/**
 * The rule of the module comment for one receipt. `current`: it is the
 * newest of its (user, lesson); `anonymisedAt`: the person's, or null.
 */
export function receiptExpired(
  receipt: RetentionReceipt,
  context: {
    current: boolean;
    anonymisedAt: string | null;
    todayKey: string;
    years: number;
    timeZone: string;
  },
): boolean {
  const validity = validityOf(receipt.snapshot);
  let base: string | null;
  if (context.anonymisedAt === null) {
    if (context.current || validity.kind !== "until") return false;
    base = validity.key;
  } else {
    const leftMs = instantEpochMs(context.anonymisedAt);
    if (leftMs === null) return false;
    const left = zonedDateKey(new Date(leftMs), context.timeZone);
    if (validity.kind === "until") base = laterKey(validity.key, left);
    else if (validity.kind === "noExpiry") base = left;
    else {
      const doneMs = receipt.completedAt === null ? null : instantEpochMs(receipt.completedAt);
      if (doneMs === null) return false;
      const bound = addMonthsToKey(
        zonedDateKey(new Date(doneMs), context.timeZone),
        MAX_VALIDITY_MONTHS,
      );
      base = laterKey(bound, left);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return false;
  return addMonthsToKey(base, context.years * 12) < context.todayKey;
}

interface GroupedReceipt extends RetentionReceipt {
  lesson: string;
}

/** The ids of the newest receipt per lesson (completedAt, then id; unreadable instants oldest). */
export function currentReceiptIds(receipts: readonly GroupedReceipt[]): Set<number> {
  const newest = new Map<string, GroupedReceipt>();
  const at = (receipt: GroupedReceipt) =>
    (receipt.completedAt === null ? null : instantEpochMs(receipt.completedAt)) ??
    Number.NEGATIVE_INFINITY;
  for (const receipt of receipts) {
    const kept = newest.get(receipt.lesson);
    if (!kept || at(receipt) > at(kept) || (at(receipt) === at(kept) && receipt.id > kept.id))
      newest.set(receipt.lesson, receipt);
  }
  return new Set([...newest.values()].map((receipt) => receipt.id));
}

/**
 * The nightly evidence job: fill missing snapshots first (bounded), then
 * delete the receipts the rule lets go, person by person (users in id
 * pages, each person's receipts read whole, so "newest" is global for
 * them). Each person is decided in one transaction holding their row lock,
 * the lock the anonymisation holds: `anonymisedAt` and the receipts are
 * re-read under it, so an anonymisation committing meanwhile is seen and
 * its later deadlines apply (Codex lane review). Unlinked receipts are
 * never read here: they stay.
 */
export async function pruneTrainingEvidence(
  strapi: DbStrapi & { log: { info(message: string): void } },
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): Promise<{ filled: number; deleted: number }> {
  const filled = await fillMissingSnapshots(strapi, {
    maxPages: SNAPSHOT_FILL_MAX_PAGES,
    ownTransactions: true,
  });
  const years = trainingEvidenceRetentionYears(env);
  const timeZone = appTimeZone(env);
  const todayKey = todayIn(timeZone, now).toString();
  let deleted = 0;
  let afterId = 0;
  for (;;) {
    const users = rows(
      await strapi.db.query(USER_UID).findMany({
        where: { id: { $gt: afterId } },
        select: ["id"],
        orderBy: [{ id: "asc" }],
        limit: TRAINING_EVIDENCE_PAGE,
      }),
    );
    if (users.length === 0) break;
    afterId = users[users.length - 1].id as number;
    for (const user of users) {
      const id = user.id as number;
      if ((await strapi.db.query(PROGRESS_UID).count({ where: { user: { id } } })) === 0) continue;
      deleted += await strapi.db.transaction(async ({ trx }) => {
        await lockUserRow(strapi as unknown as MfaHost, trx, id);
        const fresh = await strapi.db
          .query(USER_UID)
          .findOne({ where: { id }, select: ["id", "anonymisedAt"] });
        const receipts = await receiptsOf(strapi, id);
        const current = currentReceiptIds(receipts);
        const anonymisedAt = publicationStamp(isRecord(fresh) ? fresh.anonymisedAt : null);
        const expired = receipts
          .filter((receipt) =>
            receiptExpired(receipt, {
              current: current.has(receipt.id),
              anonymisedAt,
              todayKey,
              years,
              timeZone,
            }),
          )
          .map((receipt) => receipt.id);
        let removed = 0;
        for (const ids of chunks(expired, TRAINING_EVIDENCE_PAGE)) {
          const result = await strapi.db
            .query(PROGRESS_UID)
            .deleteMany({ where: { id: { $in: ids } } });
          removed += (result as { count?: number })?.count ?? 0;
        }
        return removed;
      });
    }
  }
  strapi.log.info(
    `[training-evidence] filled ${filled} snapshot(s), deleted ${deleted} receipt(s) past retention`,
  );
  return { filled, deleted };
}

async function receiptsOf(strapi: DbStrapi, userId: number): Promise<GroupedReceipt[]> {
  const found = rows(
    await strapi.db.query(PROGRESS_UID).findMany({
      where: { user: { id: userId } },
      select: ["id", "targetDocumentId", "completedAt", "snapshot"],
      orderBy: [{ id: "asc" }],
    }),
  );
  return found
    .filter((row) => typeof row.id === "number" && typeof row.targetDocumentId === "string")
    .map((row) => ({
      id: row.id as number,
      lesson: row.targetDocumentId as string,
      completedAt: publicationStamp(row.completedAt),
      snapshot: parseSnapshot(row.snapshot),
    }));
}

// ---------------------------------------------------------------------------
// The per-person evidence (admin): GET /api/user-management/:id/training-evidence.

/**
 * Every receipt of the person, newest first, from the snapshot where there
 * is one and from the current rows otherwise (a receipt without a snapshot
 * yet is shown like a backfilled one).
 */
export async function trainingEvidenceRows(
  strapi: DbStrapi,
  userId: number,
): Promise<TrainingEvidenceRow[]> {
  const receipts = await receiptsOf(strapi, userId);
  const current = currentReceiptIds(receipts);
  const missing = receipts.filter((receipt) => receipt.snapshot === null);
  const lessons = await currentLessons(
    strapi,
    missing.map((receipt) => receipt.lesson),
  );
  const out = receipts.map((receipt): TrainingEvidenceRow => {
    const snapshot = receipt.snapshot ?? backfilledSnapshot(lessons.get(receipt.lesson), null);
    const validity = validityOf(snapshot);
    return {
      id: receipt.id,
      completedAt: receipt.completedAt,
      course: {
        documentId: snapshot.course?.documentId ?? null,
        title: snapshot.course?.title ?? "",
      },
      version: snapshot.course?.publishedAt ?? null,
      lesson: { documentId: receipt.lesson, title: snapshot.lesson?.title ?? "" },
      completionMode: snapshot.completionMode,
      quiz: snapshot.backfilled ? "unknown" : snapshot.quizPassed ? "passed" : "none",
      validUntil: validity.kind === "until" ? validity.key : null,
      validity: validity.kind,
      backfilled: snapshot.backfilled === true,
      current: current.has(receipt.id),
    };
  });
  return out.sort(
    (a, b) =>
      (instantEpochMs(b.completedAt ?? "") ?? 0) - (instantEpochMs(a.completedAt ?? "") ?? 0) ||
      b.id - a.id,
  );
}

// ---------------------------------------------------------------------------
// People who left, for the course report (admin_role, `?leavers=1`).

export interface ReportLeaver {
  id: number;
  name: string;
  email: string | null;
  departmentId: number | null;
  departmentName: string | null;
  left: "blocked" | "anonymised";
}

/**
 * Blocked and anonymised people with receipts for `lessonIds`, named from
 * their newest snapshot that names them (the current row otherwise, which
 * for an anonymised person is the neutral name), with those receipts.
 */
export async function loadLeavers(
  strapi: DbStrapi,
  lessonIds: string[],
): Promise<{
  people: ReportLeaver[];
  receipts: { userId: number; targetDocumentId: string; completedAt: string | null }[];
}> {
  const people = new Map<number, ReportLeaver & { namedBy: number }>();
  const receipts: { userId: number; targetDocumentId: string; completedAt: string | null }[] = [];
  for (const chunk of chunks(lessonIds, TRAINING_EVIDENCE_PAGE)) {
    const found = rows(
      await strapi.db.query(PROGRESS_UID).findMany({
        where: { targetDocumentId: { $in: chunk }, user: { blocked: true } },
        select: ["id", "targetDocumentId", "completedAt", "snapshot"],
        populate: {
          user: {
            select: ["id", "username", "displayName", "email", "blocked", "anonymisedAt"],
            populate: { department: { select: ["id", "name"] } },
          },
        },
        orderBy: [{ id: "asc" }],
      }),
    );
    for (const row of found) {
      const user = isRecord(row.user) ? row.user : null;
      if (!user || typeof user.id !== "number" || typeof row.targetDocumentId !== "string")
        continue;
      receipts.push({
        userId: user.id,
        targetDocumentId: row.targetDocumentId,
        completedAt: publicationStamp(row.completedAt),
      });
      const learner = parseSnapshot(row.snapshot)?.learner ?? null;
      const known = people.get(user.id);
      if (known && (!learner || known.namedBy > (row.id as number))) continue;
      const department = isRecord(user.department) ? user.department : null;
      people.set(user.id, {
        id: user.id,
        name:
          learner?.displayName ||
          text(user.displayName) ||
          text(user.username) ||
          `#${String(user.id)}`,
        email: learner ? learner.email : user.anonymisedAt != null ? null : text(user.email),
        departmentId: typeof department?.id === "number" ? department.id : null,
        departmentName: text(department?.name),
        left: user.anonymisedAt != null ? "anonymised" : "blocked",
        namedBy: learner ? (row.id as number) : -1,
      });
    }
  }
  return {
    people: [...people.values()].map(({ namedBy: _namedBy, ...person }) => person),
    receipts,
  };
}
