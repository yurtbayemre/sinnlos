import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TrainingReportCourseResponse, TrainingReportSummaryResponse } from "@sinnlos/domain";

import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";

/**
 * v0.20 on the real HTTP boundary of both engines: course audience on every
 * read and write path a learner has (course list, lesson list with its
 * course populated, player, completion), renewal of a due lesson, and the
 * named report's scopes (admin_role everyone, a department head only their
 * department and the courses meant for it, everyone else 403).
 */

const COURSE = "api::course.course";
const LESSON = "api::lesson.lesson";
const PROGRESS = "api::lesson-progress.lesson-progress";

interface ErrorBody {
  error?: { status?: number; message?: string };
}
interface ListBody {
  data: { documentId: string; course?: { documentId: string } | null }[];
}

describe.each(testEngines())("course audience and the named report on %s", (engine) => {
  let t: TestStrapi;
  const courses = {} as Record<"all" | "engineering" | "sales", Row>;
  const lessons = {} as Record<"all" | "engineering" | "sales", Row>;

  // v0.28: the completion sends back the player's version (absent where the player refuses).
  const complete = async (caller: Parameters<TestStrapi["api"]>[0], lesson: Row) => {
    const player = await t.api<{ data?: { version?: unknown } }>(
      caller,
      `/api/lessons/${lesson.documentId}/player`,
    );
    return t.api<ErrorBody>(caller, "/api/lesson-progresses", {
      json: { data: { targetDocumentId: lesson.documentId, version: player.body?.data?.version } },
    });
  };

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    const { engineering, sales } = t.fixtures.departments;
    for (const [key, departments] of [
      ["all", []],
      ["engineering", [engineering.documentId]],
      ["sales", [sales.documentId]],
    ] as const) {
      courses[key] = await t.strapi.documents(COURSE).create({
        data: {
          title: `IT ${key} training`,
          slug: `it-${key}-training`,
          mandatory: true,
          validityMonths: 12,
          departments: [...departments],
        },
        status: "published",
      });
      lessons[key] = await t.strapi.documents(LESSON).create({
        data: { title: `IT ${key} lesson`, course: courses[key].documentId },
        status: "published",
      });
    }
  });

  afterAll(async () => {
    await t?.stop();
  });

  it("raises the audience flag of a course that links a department", async () => {
    const rows = await t.strapi.db.query(COURSE).findMany({
      where: { documentId: courses.sales.documentId },
      select: ["audience"],
    });
    expect(rows.map((row) => row.audience)).toEqual(["departments", "departments"]);
  });

  it("lists only the courses and lessons meant for the member's department", async () => {
    const list = await t.api<ListBody>("member", "/api/courses?pagination[pageSize]=100");
    expect(list.status, list.text).toBe(200);
    const ids = list.body.data.map((course) => course.documentId);
    expect(ids).toEqual(
      expect.arrayContaining([courses.all.documentId, courses.engineering.documentId]),
    );
    expect(ids).not.toContain(courses.sales.documentId);

    const one = await t.api<ListBody>(
      "member",
      `/api/courses?filters[slug][$eq]=${courses.sales.slug}`,
    );
    expect(one.body.data).toEqual([]);

    const lessonList = await t.api<ListBody>(
      "member",
      "/api/lessons?populate[course][fields][0]=title&pagination[pageSize]=100",
    );
    expect(lessonList.status, lessonList.text).toBe(200);
    const lessonIds = lessonList.body.data.map((lesson) => lesson.documentId);
    expect(lessonIds).toContain(lessons.engineering.documentId);
    expect(lessonIds).not.toContain(lessons.sales.documentId);
  });

  it("answers player and completion of another department's course like an unknown lesson", async () => {
    const player = await t.api<ErrorBody>(
      "member",
      `/api/lessons/${lessons.sales.documentId}/player`,
    );
    expect(player.status, player.text).toBe(404);
    const refused = await complete("member", lessons.sales);
    expect(refused.status, refused.text).toBe(400);
    expect(refused.body.error?.message).toBe("Target not available for completion");
    expect(
      await t.strapi.db
        .query(PROGRESS)
        .count({ where: { targetDocumentId: lessons.sales.documentId } }),
    ).toBe(0);

    expect(
      (await t.api("member", `/api/lessons/${lessons.engineering.documentId}/player`)).status,
    ).toBe(200);
    expect((await complete("member", lessons.engineering)).status).toBe(200);
  });

  it("lets moderators read every course", async () => {
    for (const role of ["admin_role", "editor"] as const) {
      const list = await t.api<ListBody>(role, "/api/courses?pagination[pageSize]=100");
      expect(
        list.body.data.map((course) => course.documentId),
        role,
      ).toEqual(expect.arrayContaining(Object.values(courses).map((course) => course.documentId)));
      expect((await t.api(role, `/api/lessons/${lessons.sales.documentId}/player`)).status).toBe(
        200,
      );
    }
  });

  it("takes a new receipt for a due lesson and keeps the old one as proof", async () => {
    const member = t.fixtures.users.member;
    await t.strapi.db.query(PROGRESS).create({
      data: {
        user: member.id,
        targetDocumentId: lessons.all.documentId,
        completedAt: new Date(Date.now() - 400 * 86400000).toISOString(),
      },
    });
    const renewed = await complete("member", lessons.all);
    expect(renewed.status, renewed.text).toBe(200);
    const again = await complete("member", lessons.all);
    expect(again.status, again.text).toBe(400);
    expect(again.body.error?.message).toBe("Already completed");
    expect(
      await t.strapi.db.query(PROGRESS).count({
        where: { targetDocumentId: lessons.all.documentId, user: member.id },
      }),
    ).toBe(2);
  });

  it("gives admin_role every course with every learner it is for", async () => {
    const res = await t.api<TrainingReportSummaryResponse>("admin_role", "/api/courses/report");
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.body.data.scope).toBe("all");
    const titles = res.body.data.courses.map((course) => course.title);
    expect(titles).toEqual(expect.arrayContaining(Object.values(courses).map((c) => c.title)));

    const detail = await t.api<TrainingReportCourseResponse>(
      "admin_role",
      `/api/courses/${courses.all.documentId}/report`,
    );
    expect(detail.status, detail.text).toBe(200);
    const people = detail.body.data.people;
    const member = people.find((person) => person.userId === t.fixtures.users.member.id);
    expect(member).toMatchObject({ status: "done", completed: 1, total: 1 });
    expect(member?.receipts).toHaveLength(2);
    // Guests are no learners; the users-permissions fallback role is.
    expect(people.map((person) => person.userId)).not.toContain(t.fixtures.users.guest.id);
    expect(people.map((person) => person.userId)).toContain(t.fixtures.users.authenticated.id);
  });

  it("gives a department head their department's learners and courses only", async () => {
    const res = await t.api<TrainingReportSummaryResponse>(
      "department_head",
      "/api/courses/report",
    );
    expect(res.status, res.text).toBe(200);
    expect(res.body.data).toMatchObject({ scope: "department", department: "IT Engineering" });
    expect(res.body.data.courses.map((course) => course.title).sort()).toEqual(
      [courses.all.title, courses.engineering.title].sort(),
    );

    const detail = await t.api<TrainingReportCourseResponse>(
      "team_lead",
      `/api/courses/${courses.all.documentId}/report`,
    );
    expect(detail.status, detail.text).toBe(200);
    expect(detail.body.data.people.map((person) => person.userId)).not.toContain(
      t.fixtures.users.authenticated.id,
    );

    const foreign = await t.api(
      "department_head",
      `/api/courses/${courses.sales.documentId}/report`,
    );
    expect(foreign.status, foreign.text).toBe(404);
  });

  it("refuses the report to every other role and to the public", async () => {
    for (const caller of ["editor", "member", "guest", "authenticated", null] as const) {
      const res = await t.api(caller, "/api/courses/report");
      expect(res.status, `${caller} ${res.text}`).toBeGreaterThanOrEqual(401);
      expect(res.status, `${caller} ${res.text}`).toBeLessThanOrEqual(403);
    }
  });
});
