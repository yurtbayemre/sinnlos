import { describe, expect, it } from "vitest";

import trainingVisibility from "./training-visibility";
import { narrowedFilters, storedUid, withNarrowing } from "../test/narrowing.test.helper";

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
            // Read in id pages (#175): the loader's where and the cursor.
            expect(where).toEqual({
              $and: [{ course: { publishedAt: { $notNull: true } } }, { id: { $gt: 0 } }],
            });
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

/** The filters a read gets once the Document Service applied what the policy stored (#175). */
const filtersOf = (ctx: { state?: object; request: { query: Record<string, unknown> } }) =>
  narrowedFilters(ctx, storedUid(ctx) ?? "none", ctx.request.query.filters);

describe("training-visibility", () => {
  it("bypasses admin_role/editor without touching the query", async () => {
    for (const type of ["admin_role", "editor"]) {
      for (const level of ["course", "lesson"] as const) {
        const ctx = context({ id: 1, role: { type } }, { status: "draft" });
        await expect(
          trainingVisibility(ctx, { level }, { strapi: withNarrowing(stubStrapi(), ctx) }),
        ).resolves.toBe(true);
        expect(ctx.request.query.status).toBe("draft");
        expect(await filtersOf(ctx)).toBeUndefined();
      }
    }
  });

  it("course level: company-wide courses and the caller's department, status pinned", async () => {
    const ctx = context(member, { status: "draft" });
    await trainingVisibility(
      ctx,
      { level: "course" },
      { strapi: withNarrowing(stubStrapi(), ctx) },
    );
    expect(ctx.request.query.status).toBe("published");
    expect(await filtersOf(ctx)).toEqual({ id: { $in: [1] } });

    const warehouse = context(member);
    await trainingVisibility(warehouse, undefined, {
      strapi: withNarrowing(stubStrapi(LESSONS, WAREHOUSE), warehouse),
    });
    expect(await filtersOf(warehouse)).toEqual({ id: { $in: [1, 2] } });
  });

  it("lesson level: lessons of the courses meant for the caller, narrowing client filters", async () => {
    const clientFilter = { title: { $containsi: "x" } };
    const ctx = context(member, { filters: clientFilter });
    await trainingVisibility(
      ctx,
      { level: "lesson" },
      { strapi: withNarrowing(stubStrapi(), ctx) },
    );
    expect(await filtersOf(ctx)).toEqual({ $and: [clientFilter, { id: { $in: [11] } }] });
    expect(ctx.request.query.status).toBe("published");

    const warehouse = context(member);
    await trainingVisibility(
      warehouse,
      { level: "lesson" },
      {
        strapi: withNarrowing(stubStrapi(LESSONS, WAREHOUSE), warehouse),
      },
    );
    expect(await filtersOf(warehouse)).toEqual({ id: { $in: [11, 12] } });
  });

  it("lesson level: stays restrictive when no course is published (never empty $in)", async () => {
    const ctx = context(member);
    await trainingVisibility(
      ctx,
      { level: "lesson" },
      { strapi: withNarrowing(stubStrapi([]), ctx) },
    );
    expect(await filtersOf(ctx)).toEqual({ id: { $in: [] } });
  });
});
