import { describe, expect, it, vi } from "vitest";

import lessonProgressController from "./lesson-progress";

/**
 * POST /api/lesson-progresses (S09, characterisation). Pinned here:
 *   1. the completing user is always the caller, never the payload;
 *   2. the lesson must be PUBLISHED and belong to a PUBLISHED course, looked
 *      up by documentId (stable across publishes);
 *   3. "no such lesson", "draft only", "no course" and "course unpublished"
 *      answer the byte-identical 400 (no existence oracle, §5.17);
 *   4. one receipt per user and lesson.
 *
 * The db stub evaluates the `where` it receives and resolves the course
 * populate like db.query does.
 */

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        cfg({ strapi }),
  },
}));

const LESSON_UID = "api::lesson.lesson";
const PROGRESS_UID = "api::lesson-progress.lesson-progress";
const NOT_AVAILABLE = "Target not available for completion";

const PUBLISHED_LESSON = "k3v9q2m8x7c4b1n6p5z0r2t8";
const DRAFT_LESSON = "d0d1d2d3d4d5d6d7d8d9e0e1";
const DRAFT_COURSE_LESSON = "c0c1c2c3c4c5c6c7c8c9d0d1";
const ORPHAN_LESSON = "o0o1o2o3o4o5o6o7o8o9p0p1";
const MEMBER = { id: 5, role: { type: "member" } };

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const PUBLISHED_COURSE = { id: 1, publishedAt: "2026-09-01T00:00:00.000Z" };
const DRAFT_COURSE = { id: 2, publishedAt: null };

function lessons(): Row[] {
  return [
    { id: 10, documentId: PUBLISHED_LESSON, publishedAt: null, course: PUBLISHED_COURSE },
    {
      id: 11,
      documentId: PUBLISHED_LESSON,
      publishedAt: "2026-09-01T00:00:00.000Z",
      course: PUBLISHED_COURSE,
    },
    { id: 12, documentId: DRAFT_LESSON, publishedAt: null, course: PUBLISHED_COURSE },
    {
      id: 13,
      documentId: DRAFT_COURSE_LESSON,
      publishedAt: "2026-09-01T00:00:00.000Z",
      course: DRAFT_COURSE,
    },
    { id: 14, documentId: ORPHAN_LESSON, publishedAt: "2026-09-01T00:00:00.000Z", course: null },
  ];
}

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (typeof cond === "object" && cond !== null && "$notNull" in cond) return row[key] != null;
    return row[key] === cond;
  });
}

function setup(body: unknown, progress: Row[] = []) {
  const tables: Record<string, Row[]> = { [LESSON_UID]: lessons(), [PROGRESS_UID]: progress };
  const calls: { uid: string; op: string; params: Row }[] = [];
  const query = (uid: string) => ({
    findOne: vi.fn(async (params: { where: Where }) => {
      calls.push({ uid, op: "findOne", params });
      return tables[uid].find((row) => matches(row, params.where)) ?? null;
    }),
    create: vi.fn(async (params: { data: Row }) => {
      calls.push({ uid, op: "create", params });
      const row = { id: 99, ...params.data };
      tables[uid].push(row);
      return row;
    }),
  });
  const strapi = { db: { query: vi.fn(query) } };
  const controller = (
    lessonProgressController as unknown as (deps: { strapi: unknown }) => {
      create(ctx: unknown): Promise<unknown>;
    }
  )({ strapi });
  const ctx = {
    state: { user: MEMBER as typeof MEMBER | undefined },
    request: { body },
    badRequest: vi.fn((message: string) => ({ status: 400, message })),
    unauthorized: vi.fn(() => ({ status: 401 })),
    send: vi.fn((payload: unknown) => payload),
  };
  return { controller, ctx, calls, tables };
}

async function complete(body: unknown, progress?: Row[]) {
  const s = setup(body, progress);
  await s.controller.create(s.ctx);
  return s;
}

const created = (calls: { op: string }[]) => calls.filter((c) => c.op === "create");

describe("lesson-progress create: target rules (S09)", () => {
  it("records a published lesson of a published course, for the caller", async () => {
    const { ctx, calls } = await complete({
      data: { targetDocumentId: PUBLISHED_LESSON, user: 99, completedAt: "2000-01-01" },
    });
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(created(calls)).toEqual([
      {
        uid: PROGRESS_UID,
        op: "create",
        params: {
          data: {
            user: MEMBER.id,
            targetDocumentId: PUBLISHED_LESSON,
            completedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
          },
        },
      },
    ]);
    expect(ctx.send).toHaveBeenCalledWith({ data: expect.objectContaining({ user: MEMBER.id }) });
  });

  it("looks the lesson up by documentId, published rows only, with its course", async () => {
    const { calls } = await complete({ targetDocumentId: PUBLISHED_LESSON });
    expect(calls[0]).toEqual({
      uid: LESSON_UID,
      op: "findOne",
      params: {
        where: { documentId: PUBLISHED_LESSON, publishedAt: { $notNull: true } },
        populate: { course: { select: ["id", "publishedAt"] } },
      },
    });
  });

  it("answers missing, draft-only, course-less and unpublished-course lessons with the SAME 400", async () => {
    for (const targetDocumentId of [
      "zzzzzzzzzzzzzzzzzzzzzzzz",
      DRAFT_LESSON,
      ORPHAN_LESSON,
      DRAFT_COURSE_LESSON,
    ]) {
      const { ctx, calls } = await complete({ data: { targetDocumentId } });
      expect(ctx.badRequest.mock.calls, targetDocumentId).toEqual([[NOT_AVAILABLE]]);
      expect(created(calls)).toEqual([]);
      // No duplicate lookup either: nothing hints that a receipt exists.
      expect(calls.filter((c) => c.uid === PROGRESS_UID)).toEqual([]);
    }
  });

  it("answers a missing or non-string documentId before any query", async () => {
    for (const targetDocumentId of [undefined, null, "", 7, {}, ["x"]]) {
      const { ctx, calls } = await complete({ data: { targetDocumentId } });
      expect(ctx.badRequest).toHaveBeenCalledWith("targetDocumentId required");
      expect(calls).toEqual([]);
    }
  });

  it("answers 'Already completed' for a second receipt of the same lesson", async () => {
    const { ctx, calls } = await complete({ data: { targetDocumentId: PUBLISHED_LESSON } }, [
      { id: 1, user: MEMBER.id, targetDocumentId: PUBLISHED_LESSON },
    ]);
    expect(ctx.badRequest).toHaveBeenCalledWith("Already completed");
    expect(created(calls)).toEqual([]);
  });

  it("does not count another user's receipt as the caller's", async () => {
    const { ctx, calls } = await complete({ data: { targetDocumentId: PUBLISHED_LESSON } }, [
      { id: 1, user: 77, targetDocumentId: PUBLISHED_LESSON },
    ]);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(created(calls)).toHaveLength(1);
  });

  it("answers 401 without a user", async () => {
    const s = setup({ data: { targetDocumentId: PUBLISHED_LESSON } });
    s.ctx.state.user = undefined;
    await s.controller.create(s.ctx);
    expect(s.ctx.unauthorized).toHaveBeenCalled();
    expect(s.calls).toEqual([]);
  });
});
