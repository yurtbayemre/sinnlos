/**
 * Training expiry reminders (v0.20, owner decision 2026-10-20), fired by the
 * `training-reminders` cron every morning before the digest. For every
 * published mandatory course with a validity: each learner in its audience
 * whose course is due within RENEWAL_WINDOW_DAYS ("dueSoon") gets one
 * `trainingDue` notification, each whose course expired gets one
 * `trainingExpired` notification, per due day.
 *
 * Selected by status, never by "due day == today + 30": a run missed for a
 * day or two (downtime) catches up on the next one. The dedup ledger is the
 * anchored notification itself (utils/notification-source.ts, never pruned):
 * the anchor `<course documentId>@<due day>:soon|expired` is one reminder
 * cycle, so reruns and restarts write nothing twice, and a renewed course
 * (a later due day) reminds again when its next cycle comes. Fail-open like
 * every fan-out: a failed ledger read notifies the group rather than nobody.
 *
 * One course failing (a read error) is logged and the next course still
 * runs; one row failing is logged by writeNotifications.
 */
import { courseValidity } from "@sinnlos/domain";

import { buildNotification, writeNotifications, type NotifyStrapi } from "../utils/notify";
import { resolveFanout } from "../utils/notification-source";
import { appTimeZone, todayIn } from "../utils/time";
import {
  courseAudience,
  loadLearners,
  loadReceipts,
  loadRosterCourses,
  newestByUser,
} from "../utils/training-roster";

export type TrainingReminderStrapi = NotifyStrapi & Parameters<typeof loadRosterCourses>[0];

type Kind = "soon" | "expired";

/** Writes the due reminders; returns how many notifications were written. */
export async function sendTrainingReminders(
  strapi: TrainingReminderStrapi,
  today: string = todayIn().toString(),
  timeZone: string = appTimeZone(),
): Promise<number> {
  const courses = (await loadRosterCourses(strapi)).filter(
    (course) => course.validityMonths !== null && course.lessons.length > 0,
  );
  if (courses.length === 0) {
    strapi.log.info("[training-reminders] no mandatory course with a validity");
    return 0;
  }
  const learners = await loadLearners(strapi);
  let written = 0;
  for (const course of courses) {
    try {
      const audience = courseAudience(course, learners);
      const lessonIds = course.lessons.map((lesson) => lesson.documentId);
      const newest = newestByUser(
        await loadReceipts(
          strapi,
          audience.map((user) => user.id),
          lessonIds,
        ),
      );
      // anchor → the users of one reminder cycle
      const groups = new Map<string, { kind: Kind; userIds: number[] }>();
      for (const user of audience) {
        const { status, dueKey } = courseValidity(
          lessonIds,
          newest.get(user.id) ?? new Map(),
          course.validityMonths,
          today,
          timeZone,
        );
        if ((status !== "dueSoon" && status !== "expired") || !dueKey) continue;
        const kind: Kind = status === "dueSoon" ? "soon" : "expired";
        const anchor = `${course.documentId}@${dueKey}:${kind}`;
        const group = groups.get(anchor) ?? { kind, userIds: [] };
        group.userIds.push(user.id);
        groups.set(anchor, group);
      }
      for (const [anchorId, { kind, userIds }] of groups) {
        const { recipients, anchor } = await resolveFanout(
          strapi,
          "course",
          { documentId: anchorId },
          userIds,
          (id) => id,
        );
        const rows = recipients.map((recipient) =>
          buildNotification({
            type: kind === "soon" ? "trainingDue" : "trainingExpired",
            titleParams: { subject: course.title },
            link: `/training/${course.slug}`,
            recipient,
            source: { sourceType: "course", sourceDocumentId: anchor?.sourceDocumentId ?? null },
          }),
        );
        if (rows.length > 0) {
          written += await writeNotifications(strapi, rows, `training reminder ${anchorId}`);
        }
      }
    } catch (err) {
      strapi.log.error(
        `[training-reminders] course ${course.documentId} failed: ${(err as Error).message}`,
      );
    }
  }
  strapi.log.info(
    `[training-reminders] ${written} reminder(s) for ${courses.length} course(s) on ${today}`,
  );
  return written;
}
