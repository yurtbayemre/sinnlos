import {
  forcePublishedStatus,
  getMutableQuery,
  restrictiveIdFilter,
} from "../utils/policy-query";

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
 *     published row. Resolved server-side via `strapi.db.query` (no
 *     relation traversal in the REST filter → validates for every role,
 *     no validateQuery 400) and injected as a non-relational id clause.
 *     Lessons without a course fail closed. Empty list stays restrictive
 *     via `restrictiveIdFilter` (an empty `$in` would be stripped by
 *     sanitizeQuery — fail-open, §5.15).
 */

type TrainingLevel = "course" | "lesson";

export default async (
  policyContext: any,
  config: { level?: TrainingLevel } | undefined,
  { strapi }: any,
) => {
  const user = policyContext.state?.user;

  if (user && ["admin_role", "editor"].includes(user.role?.type)) return true;

  const query = getMutableQuery(policyContext);
  const level: TrainingLevel = config?.level ?? "course";

  if (level === "lesson") {
    const rows: { id: number }[] = await strapi.db.query("api::lesson.lesson").findMany({
      where: { course: { publishedAt: { $notNull: true } } },
      select: ["id"],
    });
    const idFilter = restrictiveIdFilter(rows.map((r) => r.id));
    query.filters = query.filters ? { $and: [query.filters, idFilter] } : idFilter;
  }

  forcePublishedStatus(query);
  return true;
};
