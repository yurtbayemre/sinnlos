/**
 * Scheduled publishing (decision 06 §D; batch 15 plan item 5): the
 * vocabulary the scheduler, the authoring controller (15A) and /manage
 * (15C) share. The scheduler itself is cron/scheduled-publish.ts; the
 * schedule-clear middleware lives here.
 *
 * `scheduleError` (on the draft row of every scheduled type) holds one of
 * SCHEDULE_ERROR_CODES after a scheduled publish failed for good; the next
 * Document Service save of the draft clears it (§D rule 7):
 *   - notPublishable: the publish-readiness check refused the draft
 *     (a required field missing, a course or parent not published);
 *   - invalid: Strapi's published validation refused it (ValidationError);
 *   - rejected: a lifecycle refused it (ApplicationError);
 *   - windowExpired: its window had ended when the task reached it (the
 *     announcement's `expiresAt`, or `unpublishAt`); nothing was published
 *     and nobody was notified;
 *   - retryExhausted: SCHEDULE_TRANSIENT_ATTEMPTS transient failures in a
 *     row for the same revision.
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
