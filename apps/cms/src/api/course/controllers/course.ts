import { factories } from "@strapi/strapi";
import {
  isDocumentId,
  isInScopedAudience,
  type TrainingReportCourseResponse,
  type TrainingReportScope,
  type TrainingReportSummaryResponse,
} from "@sinnlos/domain";

import { ADMIN, TRAINING_REPORT_ROLES, hasRole } from "../../../bootstrap/roles";
import { authoringActions } from "../../../utils/authoring-controller";
import { appTimeZone, todayIn } from "../../../utils/time";
import { buildCourseReport } from "../../../utils/training-report";
import {
  courseAudience,
  loadLearners,
  loadReceipts,
  loadRosterCourses,
  type RosterCourse,
} from "../../../utils/training-roster";

const USER_UID = "plugin::users-permissions.user";

type Scope = TrainingReportScope & { departmentId?: number };

/**
 * The named training report (v0.20, owner decision 2026-10-20). The role is
 * checked here again, whatever the grants say (audit-event pattern):
 * admin_role reads every learner; department heads and team leads only the
 * learners of their own department, and only the courses meant for it. A
 * head or lead without a department reads nothing (403). Mandatory,
 * published courses only.
 */
export default factories.createCoreController("api::course.course", ({ strapi }) => {
  async function scopeOf(user: { id: number; role?: { type?: unknown } | null }) {
    if (hasRole(user, [ADMIN])) return { scope: "all", department: null } as Scope;
    if (!hasRole(user, TRAINING_REPORT_ROLES)) return null;
    const me = await strapi.db.query(USER_UID).findOne({
      where: { id: user.id },
      select: ["id"],
      populate: { department: { select: ["id", "name"] } },
    });
    const department = me?.department;
    if (typeof department?.id !== "number") return null;
    return {
      scope: "department",
      department: department.name ?? null,
      departmentId: department.id,
    } as Scope;
  }

  async function report(scope: Scope, course: RosterCourse) {
    const learners = await loadLearners(strapi, scope.departmentId);
    const people = courseAudience(course, learners);
    const receipts = await loadReceipts(
      strapi,
      people.map((person) => person.id),
      course.lessons.map((lesson) => lesson.documentId),
    );
    const zone = appTimeZone();
    return buildCourseReport(course, people, receipts, todayIn(zone).toString(), zone);
  }

  const inScope = (scope: Scope, course: RosterCourse) =>
    scope.scope === "all" || isInScopedAudience(course, scope.departmentId);

  const publicScope = ({ scope, department }: Scope): TrainingReportScope => ({
    scope,
    department,
  });

  return {
    ...authoringActions(strapi, "api::course.course"),

    async report(ctx) {
      if (!ctx.state.user) return ctx.unauthorized();
      if (Object.keys(ctx.query ?? {}).length)
        return ctx.badRequest("Query parameters not allowed");
      const scope = await scopeOf(ctx.state.user);
      if (!scope) return ctx.forbidden();
      ctx.set("Cache-Control", "private, no-store");
      const courses = (await loadRosterCourses(strapi)).filter((course) => inScope(scope, course));
      const summaries = [];
      for (const course of courses) summaries.push((await report(scope, course)).course);
      const body: TrainingReportSummaryResponse = {
        data: { ...publicScope(scope), courses: summaries },
      };
      return ctx.send(body);
    },

    async reportCourse(ctx) {
      if (!ctx.state.user) return ctx.unauthorized();
      if (Object.keys(ctx.query ?? {}).length)
        return ctx.badRequest("Query parameters not allowed");
      const scope = await scopeOf(ctx.state.user);
      if (!scope) return ctx.forbidden();
      ctx.set("Cache-Control", "private, no-store");
      const documentId = ctx.params.id;
      const [course] = isDocumentId(documentId)
        ? await loadRosterCourses(strapi, { documentId })
        : [];
      if (!course || !inScope(scope, course)) return ctx.notFound("Course not available");
      const built = await report(scope, course);
      const body: TrainingReportCourseResponse = {
        data: { ...publicScope(scope), ...built, lessons: course.lessons },
      };
      return ctx.send(body);
    },
  };
});
