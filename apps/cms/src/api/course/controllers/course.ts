import { factories } from "@strapi/strapi";
import {
  isDocumentId,
  isInScopedAudience,
  type TrainingReportCourseResponse,
  type TrainingReportLeaver,
  type TrainingReportScope,
  type TrainingReportSummaryResponse,
} from "@sinnlos/domain";

import { ADMIN, TRAINING_REPORT_ROLES, hasRole } from "../../../bootstrap/roles";
import { authoringActions } from "../../../utils/authoring-controller";
import { appTimeZone, todayIn } from "../../../utils/time";
import { loadLeavers } from "../../../utils/training-evidence";
import { buildCourseReport } from "../../../utils/training-report";
import {
  courseAudience,
  loadLearners,
  loadReceipts,
  loadRosterCourses,
  type RosterCourse,
  type RosterUser,
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

  /** One course's report; `learners` is the scope's list when the caller already read it (#179). */
  async function report(scope: Scope, course: RosterCourse, learners?: RosterUser[]) {
    const people = courseAudience(
      course,
      learners ?? (await loadLearners(strapi, scope.departmentId)),
    );
    const receipts = await loadReceipts(
      strapi,
      people.map((person) => person.id),
      course.lessons.map((lesson) => lesson.documentId),
    );
    const zone = appTimeZone();
    return buildCourseReport(course, people, receipts, todayIn(zone).toString(), zone);
  }

  async function leaversOf(course: RosterCourse): Promise<TrainingReportLeaver[]> {
    const { people, receipts } = await loadLeavers(
      strapi,
      course.lessons.map((lesson) => lesson.documentId),
    );
    const zone = appTimeZone();
    const built = buildCourseReport(course, people, receipts, todayIn(zone).toString(), zone);
    const left = new Map(people.map((person) => [person.id, person.left]));
    return built.people.map((person) => ({ ...person, left: left.get(person.userId)! }));
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
      // One read of the scope's learners for every course of the page (v0.32, #179).
      const learners = courses.length ? await loadLearners(strapi, scope.departmentId) : [];
      const summaries = [];
      for (const course of courses) summaries.push((await report(scope, course, learners)).course);
      const body: TrainingReportSummaryResponse = {
        data: { ...publicScope(scope), courses: summaries },
      };
      return ctx.send(body);
    },

    /**
     * `?leavers=1` (v0.28, owner decision 2026-10-23): admin_role only, the
     * blocked and anonymised people with receipts for this course, named
     * from their receipts' snapshot (utils/training-evidence.ts). Heads and
     * leads keep their current scope (403 with the parameter).
     */
    async reportCourse(ctx) {
      if (!ctx.state.user) return ctx.unauthorized();
      const query = ctx.query ?? {};
      const withLeavers = query.leavers === "1";
      if (
        Object.keys(query).some((key) => key !== "leavers") ||
        ("leavers" in query && !withLeavers)
      )
        return ctx.badRequest("Query parameters not allowed");
      const scope = await scopeOf(ctx.state.user);
      if (!scope) return ctx.forbidden();
      if (withLeavers && !hasRole(ctx.state.user, [ADMIN])) return ctx.forbidden();
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
      if (withLeavers) body.data.leavers = await leaversOf(course);
      return ctx.send(body);
    },
  };
});
