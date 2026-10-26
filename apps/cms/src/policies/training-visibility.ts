import { isInScopedAudience } from "@sinnlos/domain";

import { MODERATORS } from "../bootstrap/roles";
import { findAllPaged } from "../utils/paged-read";
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
 *     no validateQuery 400); the Document Service ANDs the ids as a
 *     non-relational clause, the list bound as one parameter (#175).
 *     Lessons without a course fail closed; an empty list matches nothing.
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
  // Paged (utils/paged-read.ts, #175): the course populate binds one page
  // of lesson ids, its departments populate one page of course ids.
  const lessons = await findAllPaged<{
    id: number;
    course?: Parameters<typeof isInScopedAudience>[0] | null;
  }>(strapi.db.query(LESSON_UID), {
    where: { course: { publishedAt: { $notNull: true } } },
    select: ["id"],
    populate: {
      course: { select: ["id", "audience"], populate: { departments: { select: ["id"] } } },
    },
  });
  return rowIds(
    lessons.filter((lesson) => lesson?.course && isInScopedAudience(lesson.course, departmentId)),
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
