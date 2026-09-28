import { MODERATORS, hasRole } from "../bootstrap/roles";
import {
  rowIds,
  visibleIdsPolicy,
  type Policy,
  type VisibleIdsInput,
} from "../utils/policy-factories";
import { forcePublishedStatus, getMutableQuery } from "../utils/policy-query";

/**
 * Read guard for the training module (issue #29, admin-authoring
 * variant). Courses/lessons carry no per-user targeting in v1 — every
 * staff role holding the read grant may see PUBLISHED content; drafts
 * are the authors' workbench in the Strapi admin.
 *
 * admin_role / editor bypass entirely (draft preview — same rationale as
 * the sibling visibility policies).
 *
 * Levels (config, same shape as wiki-visibility):
 *   - course: nothing to filter beyond pinning `status=published`
 *     (§5.24 — the client-supplied `?status=draft` would otherwise hand
 *     unpublished courses to every role with `course.find`).
 *   - lesson: a lesson is visible only when its OWNING COURSE has a
 *     published row (visibleIdsPolicy, utils/policy-factories.ts). Resolved
 *     server-side via `strapi.db.query` (no relation traversal in the REST
 *     filter → validates for every role, no validateQuery 400) and injected
 *     as a non-relational id clause. Lessons without a course fail closed.
 *     Empty list stays restrictive via `restrictiveIdFilter` (an empty `$in`
 *     would be stripped by sanitizeQuery — fail-open, §5.15).
 */

type TrainingLevel = "course" | "lesson";
type TrainingConfig = { level?: TrainingLevel } | undefined;

const LESSON_UID = "api::lesson.lesson";

async function lessonsOfPublishedCourses({
  strapi,
}: VisibleIdsInput<TrainingConfig>): Promise<number[]> {
  return rowIds(
    await strapi.db.query(LESSON_UID).findMany({
      where: { course: { publishedAt: { $notNull: true } } },
      select: ["id"],
    }),
  );
}

const lessonVisibility = visibleIdsPolicy<TrainingConfig>({
  uid: LESSON_UID,
  bypass: MODERATORS,
  anonymous: "filter",
  pinPublished: true,
  loadVisibleIds: lessonsOfPublishedCourses,
});

const trainingVisibility: Policy<TrainingConfig> = async (policyContext, config, deps) => {
  if ((config?.level ?? "course") === "lesson") {
    return lessonVisibility(policyContext, config, deps);
  }
  // Course level: the status pin after the bypass, no row filter.
  if (hasRole(policyContext.state?.user, MODERATORS)) return true;
  forcePublishedStatus(getMutableQuery(policyContext));
  return true;
};

export default trainingVisibility;
