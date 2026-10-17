/**
 * The content types of v2 authoring, by role (decision 06; batch 15 plan,
 * contract K1). One list per question, so a middleware, a cron task or a
 * gate asks "is this uid one of mine" here instead of naming uids itself:
 *
 *   - AUTHORED_UIDS: written through the v2 authoring gate (§A, §B). Batch
 *     15 moved the five phase-1 types, batch 16 wiki-space and wiki-page;
 *     batch 17 adds course and lesson.
 *   - DEPARTMENT_AUTHORED_UIDS: the types a department author writes for
 *     their own department (amendment 1, §N2), with `ownerDepartment`.
 *   - SCHEDULED_UIDS: the types with `publishAt` and `scheduleError` (§D);
 *     the scheduler walks exactly these. No poll: polls publish at create
 *     and have no schedule, and cron/ modules never name the poll uid
 *     (poll-exposure.test.ts).
 *   - UNPUBLISH_SCHEDULED_UIDS: the scheduled types that also have
 *     `unpublishAt` (document and quick-link).
 *   - GUARDED_UIDS: every type whose Document Service mutations run under
 *     the document lock and advance the document revision (§G): the
 *     scheduled seven plus poll, wiki-space, department and team.
 *   - AUDITED_UIDS: the types the audit recorder writes a row for (§H); the
 *     same set as GUARDED_UIDS, so every revision a document reaches has its
 *     audit row.
 *
 * Changing a list changes who is locked, scheduled or audited: the pins in
 * authoring-uids.test.ts name every entry on purpose.
 */

export const ANNOUNCEMENT_UID = "api::announcement.announcement";
export const EVENT_UID = "api::event.event";
export const DOCUMENT_UID = "api::document.document";
export const QUICK_LINK_UID = "api::quick-link.quick-link";
export const WIKI_PAGE_UID = "api::wiki-page.wiki-page";
export const WIKI_SPACE_UID = "api::wiki-space.wiki-space";
export const COURSE_UID = "api::course.course";
export const LESSON_UID = "api::lesson.lesson";
export const DEPARTMENT_UID = "api::department.department";
export const TEAM_UID = "api::team.team";
const POLL = "api::poll.poll";

/**
 * Written through the v2 authoring gate: the phase-1 types (batch 15) and
 * the wiki (batch 16), courses and lessons (batch 17). Wiki spaces and
 * training go through global::can-author like the phase-1 types; wiki pages through global::can-edit-wiki, the row gate of
 * utils/wiki-gate.ts on the same loader, allowlist and controller.
 */
export const AUTHORED_UIDS: readonly string[] = [
  ANNOUNCEMENT_UID,
  EVENT_UID,
  QUICK_LINK_UID,
  DOCUMENT_UID,
  POLL,
  WIKI_SPACE_UID,
  WIKI_PAGE_UID,
  COURSE_UID,
  LESSON_UID,
];

/** Department authors write these for their own department (amendment 1). */
export const DEPARTMENT_AUTHORED_UIDS: readonly string[] = [
  ANNOUNCEMENT_UID,
  EVENT_UID,
  DOCUMENT_UID,
];

/** `publishAt` + `scheduleError`; the scheduler's types (no poll). */
export const SCHEDULED_UIDS: readonly string[] = [
  ANNOUNCEMENT_UID,
  EVENT_UID,
  DOCUMENT_UID,
  QUICK_LINK_UID,
  WIKI_PAGE_UID,
  COURSE_UID,
  LESSON_UID,
];

/** The scheduled types that also have `unpublishAt`. */
export const UNPUBLISH_SCHEDULED_UIDS: readonly string[] = [DOCUMENT_UID, QUICK_LINK_UID];

/** Locked and revisioned on every Document Service mutation (§G). */
export const GUARDED_UIDS: readonly string[] = [
  ...SCHEDULED_UIDS,
  POLL,
  WIKI_SPACE_UID,
  DEPARTMENT_UID,
  TEAM_UID,
];

/** One audit row per Document Service mutation (§H); the guarded set. */
export const AUDITED_UIDS: readonly string[] = GUARDED_UIDS;

const member =
  (list: readonly string[]) =>
  (uid: unknown): uid is string =>
    typeof uid === "string" && list.includes(uid);

export const isGuardedUid = member(GUARDED_UIDS);
export const isAuditedUid = member(AUDITED_UIDS);
export const isScheduledUid = member(SCHEDULED_UIDS);
export const isUnpublishScheduledUid = member(UNPUBLISH_SCHEDULED_UIDS);
