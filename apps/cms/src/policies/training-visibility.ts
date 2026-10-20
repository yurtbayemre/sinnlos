import { isInScopedAudience } from "@sinnlos/domain";

import { MODERATORS } from "../bootstrap/roles";
import {
  callerDepartmentId,
  departmentScopedIds,
  rowIds,
  visibleIdsPolicy,
  type Policy,
  type VisibleIdsInput,
} from "../utils/policy-factories";

/**
 * Read guard for the training module (issue #29, admin-authoring
 * variant; course audience since v0.20). Every staff role holding the read
 * grant may see PUBLISHED content of the courses meant for it; drafts are
 * the authors' workbench.
 *
 * admin_role / editor bypass entirely (draft preview — same rationale as
 * the sibling visibility policies).
 *
 * Levels (config, same shape as wiki-visibility):
 *   - course: the document-visibility rule ("flag OR links",
 *     departmentScopedIds): a course without departments is for everyone,
 *     one with departments only for their members; `status=published` is
 *     pinned (§5.24 — the client-supplied `?status=draft` would otherwise
 *     hand unpublished courses to every role with `course.find`).
 *   - lesson: a lesson is visible only when its OWNING COURSE has a
 *     published row whose audience includes the caller (visibleIdsPolicy,
 *     utils/policy-factories.ts). Resolved server-side via `strapi.db.query`
 *     (no relation traversal in the REST filter → validates for every role,
 *     no validateQuery 400) and injected as a non-relational id clause.
 *     Lessons without a course fail closed. Empty list stays restrictive via
 *     `restrictiveIdFilter` (an empty `$in` would be stripped by
 *     sanitizeQuery — fail-open, §5.15).
 * The player, quiz check and completion endpoints apply the same audience
 * through utils/training-access.ts loadPublishedLesson.
 */

type TrainingLevel = "course" | "lesson";
type TrainingConfig = { level?: TrainingLevel } | undefined;

const LESSON_UID = "api::lesson.lesson";

async function lessonsOfPublishedCourses({
  strapi,
  user,
}: VisibleIdsInput<TrainingConfig>): Promise<number[]> {
  const departmentId = await callerDepartmentId(strapi, user);
  const lessons = await strapi.db.query(LESSON_UID).findMany({
    where: { course: { publishedAt: { $notNull: true } } },
    select: ["id"],
    populate: {
      course: { select: ["id", "audience"], populate: { departments: { select: ["id"] } } },
    },
  });
  return rowIds(
    (Array.isArray(lessons) ? lessons : []).filter(
      (lesson) => lesson?.course && isInScopedAudience(lesson.course, departmentId),
    ),
  );
}

const lessonVisibility = visibleIdsPolicy<TrainingConfig>({
  uid: LESSON_UID,
  bypass: MODERATORS,
  anonymous: "filter",
  pinPublished: true,
  loadVisibleIds: lessonsOfPublishedCourses,
});

const courseVisibility = visibleIdsPolicy<TrainingConfig>({
  uid: "api::course.course",
  bypass: MODERATORS,
  anonymous: "filter",
  pinPublished: true,
  loadVisibleIds: departmentScopedIds,
});

const trainingVisibility: Policy<TrainingConfig> = async (policyContext, config, deps) =>
  (config?.level ?? "course") === "lesson"
    ? lessonVisibility(policyContext, config, deps)
    : courseVisibility(policyContext, config, deps);

export default trainingVisibility;
