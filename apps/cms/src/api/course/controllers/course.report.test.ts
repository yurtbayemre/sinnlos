import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrainingReportCourseResponse, TrainingReportSummaryResponse } from "@sinnlos/domain";

import controller from "./course";
import * as roster from "../../../utils/training-roster";

/**
 * GET /api/courses/report and /api/courses/:id/report (v0.20). Pinned: who
 * reads what (admin_role everyone; department heads and team leads their own
 * department's learners and only the courses meant for it; nobody else, and
 * no head or lead without a department), the no-store header, no query
 * parameters, and 404 for a course outside the caller's scope. The roster
 * reads are stubbed; their queries run on the real engine in
 * cron/training-reminders.engine.test.ts.
 */

vi.mock("@strapi/strapi", () => ({
  factories: { createCoreController: (_uid: string, build: unknown) => build },
}));

vi.mock("../../../utils/authoring-controller", () => ({ authoringActions: () => ({}) }));

vi.mock("../../../utils/training-roster", async (importOriginal) => ({
  ...(await importOriginal<typeof roster>()),
  loadRosterCourses: vi.fn(),
  loadLearners: vi.fn(),
  loadReceipts: vi.fn(async () => []),
}));

const LAGER = 4;
const BUERO = 3;
const ALL_COURSE: roster.RosterCourse = {
  id: 1,
  documentId: "a".repeat(24),
  title: "Brandschutz",
  slug: "brandschutz",
  mandatory: true,
  validityMonths: 12,
  audience: "all",
  departments: [],
  lessons: [{ documentId: "l".repeat(24), title: "Lektion" }],
};
const LAGER_COURSE: roster.RosterCourse = {
  ...ALL_COURSE,
  id: 2,
  documentId: "b".repeat(24),
  title: "Stapler",
  slug: "stapler",
  audience: "departments",
  departments: [{ id: LAGER, name: "Lager" }],
};
const LEARNERS: roster.RosterUser[] = [
  { id: 10, name: "Ana", email: null, departmentId: LAGER, departmentName: "Lager" },
  { id: 11, name: "Ben", email: null, departmentId: BUERO, departmentName: "Büro" },
];

function setup(role: string | null, department: { id: number; name: string } | null = null) {
  const users = { findOne: vi.fn(async () => ({ id: 1, department })) };
  const strapi = { db: { query: vi.fn(() => users) } };
  const actions = (
    controller as unknown as (deps: { strapi: unknown }) => {
      report(ctx: unknown): Promise<unknown>;
      reportCourse(ctx: unknown): Promise<unknown>;
    }
  )({ strapi });
  const ctx = {
    state: { user: role === null ? undefined : { id: 1, role: { type: role } } },
    query: {} as Record<string, unknown>,
    params: {} as Record<string, unknown>,
    set: vi.fn(),
    send: vi.fn((body: unknown) => body),
    unauthorized: vi.fn(() => "401"),
    forbidden: vi.fn(() => "403"),
    notFound: vi.fn(() => "404"),
    badRequest: vi.fn(() => "400"),
  };
  return { actions, ctx };
}

beforeEach(() => {
  vi.mocked(roster.loadRosterCourses).mockImplementation(async (_strapi, options = {}) =>
    [ALL_COURSE, LAGER_COURSE].filter(
      (course) => !options.documentId || course.documentId === options.documentId,
    ),
  );
  vi.mocked(roster.loadLearners).mockImplementation(async (_strapi, departmentId) =>
    LEARNERS.filter((user) => departmentId == null || user.departmentId === departmentId),
  );
});

describe("course report: who reads what", () => {
  it("gives admin_role every course with every learner it is for", async () => {
    const { actions, ctx } = await setup("admin_role");
    const before = vi.mocked(roster.loadLearners).mock.calls.length;
    const body = (await actions.report(ctx)) as TrainingReportSummaryResponse;
    // One read of the learners for the whole page, not one per course (v0.32, #179).
    expect(vi.mocked(roster.loadLearners).mock.calls.length - before).toBe(1);
    expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(body.data.scope).toBe("all");
    expect(body.data.courses.map((c) => [c.title, c.counts.total])).toEqual([
      ["Brandschutz", 2],
      ["Stapler", 1],
    ]);
    expect(roster.loadLearners).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it("gives a head or lead their department's learners and the courses meant for it", async () => {
    for (const role of ["department_head", "team_lead"]) {
      const office = await setup(role, { id: BUERO, name: "Büro" });
      const before = vi.mocked(roster.loadLearners).mock.calls.length;
      const body = (await office.actions.report(office.ctx)) as TrainingReportSummaryResponse;
      expect(vi.mocked(roster.loadLearners).mock.calls.length - before).toBe(1);
      expect(body.data).toMatchObject({ scope: "department", department: "Büro" });
      expect(body.data.courses.map((c) => [c.title, c.counts.total])).toEqual([["Brandschutz", 1]]);
      expect(roster.loadLearners).toHaveBeenLastCalledWith(expect.anything(), BUERO);

      const warehouse = await setup(role, { id: LAGER, name: "Lager" });
      warehouse.ctx.params.id = LAGER_COURSE.documentId;
      const course = (await warehouse.actions.reportCourse(
        warehouse.ctx,
      )) as TrainingReportCourseResponse;
      expect(course.data.people.map((p) => p.name)).toEqual(["Ana"]);
      expect(course.data.lessons).toEqual(LAGER_COURSE.lessons);
    }
  });

  it("answers 404 for a course outside the caller's department, or unknown", async () => {
    const office = await setup("department_head", { id: BUERO, name: "Büro" });
    for (const id of [LAGER_COURSE.documentId, "z".repeat(24), "not-an-id"]) {
      office.ctx.params.id = id;
      expect(await office.actions.reportCourse(office.ctx), id).toBe("404");
    }
  });

  it("refuses other roles, a head without a department, and anonymous callers", async () => {
    for (const role of ["editor", "member", "guest", "authenticated"]) {
      const { actions, ctx } = await setup(role, { id: LAGER, name: "Lager" });
      expect(await actions.report(ctx), role).toBe("403");
      ctx.params.id = ALL_COURSE.documentId;
      expect(await actions.reportCourse(ctx), role).toBe("403");
    }
    const homeless = await setup("department_head", null);
    expect(await homeless.actions.report(homeless.ctx)).toBe("403");
    const anonymous = await setup(null);
    expect(await anonymous.actions.report(anonymous.ctx)).toBe("401");
  });

  it("takes no query parameters", async () => {
    const { actions, ctx } = await setup("admin_role");
    ctx.query = { populate: "*" };
    expect(await actions.report(ctx)).toBe("400");
    expect(roster.loadRosterCourses).not.toHaveBeenCalled();
  });
});
