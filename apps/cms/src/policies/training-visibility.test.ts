import { describe, expect, it } from "vitest";

import trainingVisibility from "./training-visibility";

/**
 * Wiring test for the training read policy (issue #29; course audience
 * since v0.20). Pinned traps (same set as the sibling visibility policy
 * tests):
 *  1. filters land on `policyContext.request.query` (Koa getter trap),
 *  2. `?status=draft` is overridden server-side (forcePublishedStatus),
 *  3. an empty visible set stays restrictive (`$eq: -1`),
 *  4. client filters are narrowed via $and, never replaced,
 *  5. admin/editor bypass without touching the query,
 *  6. a course with departments (and its lessons) reaches only their
 *     members; flagged without departments, nobody.
 */

const OFFICE = 3;
const WAREHOUSE = 4;

const COURSES = [
  { id: 1, audience: "all", departments: [] },
  { id: 2, audience: "departments", departments: [{ id: WAREHOUSE }] },
  { id: 3, audience: "departments", departments: [] },
];

const LESSONS = [
  { id: 11, course: COURSES[0] },
  { id: 12, course: COURSES[1] },
  { id: 13, course: COURSES[2] },
];

function stubStrapi(lessonRows: unknown[] = LESSONS, departmentId: number | null = OFFICE) {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async () => ({ id: 10, department: departmentId ? { id: departmentId } : null }),
        findMany: async ({ where }: any) => {
          if (uid === "api::lesson.lesson") {
            expect(where).toEqual({ course: { publishedAt: { $notNull: true } } });
            return lessonRows;
          }
          if (uid === "api::course.course") return COURSES;
          return [];
        },
      }),
    },
  } as any;
}

function context(user: any, query: Record<string, unknown> = {}) {
  return { state: user ? { user } : {}, request: { query: { ...query } } } as any;
}

const member = { id: 10, role: { type: "member" } };

describe("training-visibility", () => {
  it("bypasses admin_role/editor without touching the query", async () => {
    for (const type of ["admin_role", "editor"]) {
      for (const level of ["course", "lesson"] as const) {
        const ctx = context({ id: 1, role: { type } }, { status: "draft" });
        await expect(trainingVisibility(ctx, { level }, { strapi: stubStrapi() })).resolves.toBe(
          true,
        );
        expect(ctx.request.query.status).toBe("draft");
        expect(ctx.request.query.filters).toBeUndefined();
      }
    }
  });

  it("course level: company-wide courses and the caller's department, status pinned", async () => {
    const ctx = context(member, { status: "draft" });
    await trainingVisibility(ctx, { level: "course" }, { strapi: stubStrapi() });
    expect(ctx.request.query.status).toBe("published");
    expect(ctx.request.query.filters).toEqual({ id: { $in: [1] } });

    const warehouse = context(member);
    await trainingVisibility(warehouse, undefined, { strapi: stubStrapi(LESSONS, WAREHOUSE) });
    expect(warehouse.request.query.filters).toEqual({ id: { $in: [1, 2] } });
  });

  it("lesson level: lessons of the courses meant for the caller, narrowing client filters", async () => {
    const clientFilter = { title: { $containsi: "x" } };
    const ctx = context(member, { filters: clientFilter });
    await trainingVisibility(ctx, { level: "lesson" }, { strapi: stubStrapi() });
    expect(ctx.request.query.filters).toEqual({ $and: [clientFilter, { id: { $in: [11] } }] });
    expect(ctx.request.query.status).toBe("published");

    const warehouse = context(member);
    await trainingVisibility(
      warehouse,
      { level: "lesson" },
      {
        strapi: stubStrapi(LESSONS, WAREHOUSE),
      },
    );
    expect(warehouse.request.query.filters).toEqual({ id: { $in: [11, 12] } });
  });

  it("lesson level: stays restrictive when no course is published (never empty $in)", async () => {
    const ctx = context(member);
    await trainingVisibility(ctx, { level: "lesson" }, { strapi: stubStrapi([]) });
    expect(ctx.request.query.filters).toEqual({ id: { $eq: -1 } });
  });
});
