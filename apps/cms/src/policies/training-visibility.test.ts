import { describe, expect, it } from "vitest";

import trainingVisibility from "./training-visibility";

/**
 * Wiring test for the training read policy (issue #29). Pinned traps
 * (same set as the sibling visibility policy tests):
 *  1. filters land on `policyContext.request.query` (Koa getter trap),
 *  2. `?status=draft` is overridden server-side (forcePublishedStatus),
 *  3. lesson level: empty visible set stays restrictive (`$eq: -1`),
 *  4. client filters are narrowed via $and, never replaced,
 *  5. admin/editor bypass without touching the query.
 */

const LESSONS = [
  { id: 1 }, // lesson of a published course
  { id: 2 },
];

function stubStrapi(lessonRows: { id: number }[] = LESSONS) {
  return {
    db: {
      query: (uid: string) => ({
        findMany: async ({ where }: any) => {
          if (uid !== "api::lesson.lesson") return [];
          expect(where).toEqual({ course: { publishedAt: { $notNull: true } } });
          return lessonRows;
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
      const ctx = context({ id: 1, role: { type } }, { status: "draft" });
      await expect(
        trainingVisibility(ctx, { level: "lesson" }, { strapi: stubStrapi() }),
      ).resolves.toBe(true);
      expect(ctx.request.query.status).toBe("draft");
      expect(ctx.request.query.filters).toBeUndefined();
    }
  });

  it("course level: pins status=published on the REAL request query", async () => {
    const ctx = context(member, { status: "draft" });
    await trainingVisibility(ctx, { level: "course" }, { strapi: stubStrapi() });
    expect(ctx.request.query.status).toBe("published");
    expect(ctx.request.query.filters).toBeUndefined();
  });

  it("lesson level: injects the published-course id filter and narrows client filters", async () => {
    const clientFilter = { title: { $containsi: "x" } };
    const ctx = context(member, { filters: clientFilter });
    await trainingVisibility(ctx, { level: "lesson" }, { strapi: stubStrapi() });
    expect(ctx.request.query.filters).toEqual({
      $and: [clientFilter, { id: { $in: [1, 2] } }],
    });
    expect(ctx.request.query.status).toBe("published");
  });

  it("lesson level: stays restrictive when no course is published (never empty $in)", async () => {
    const ctx = context(member);
    await trainingVisibility(ctx, { level: "lesson" }, { strapi: stubStrapi([]) });
    expect(ctx.request.query.filters).toEqual({ id: { $eq: -1 } });
  });
});
