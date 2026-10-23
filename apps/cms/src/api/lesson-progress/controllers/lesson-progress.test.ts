import { describe, expect, it, vi } from "vitest";

import lessonProgressController from "./lesson-progress";

/**
 * POST /api/lesson-progresses (S09, characterisation). Pinned here:
 *   1. the completing user is always the caller, never the payload;
 *   2. the lesson must be PUBLISHED and belong to a PUBLISHED course, looked
 *      up by documentId (stable across publishes);
 *   3. "no such lesson", "draft only", "no course" and "course unpublished"
 *      answer the byte-identical 400 (no existence oracle, §5.17);
 *   4. one receipt per user and lesson while it counts; a course with
 *      validityMonths takes a new one once the newest is due within 30 days
 *      (v0.20 renewal);
 *   5. a lesson with a quiz completes only with every answer correct
 *      (issue #70), checked after the lesson proved available;
 *   6. a course with departments is completable only by their members
 *      (v0.20 course audience), with the same 400 as an unknown lesson.
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
const USER_UID = "plugin::users-permissions.user";
const NOT_AVAILABLE = "Target not available for completion";

const PUBLISHED_LESSON = "k3v9q2m8x7c4b1n6p5z0r2t8";
const DRAFT_LESSON = "d0d1d2d3d4d5d6d7d8d9e0e1";
const DRAFT_COURSE_LESSON = "c0c1c2c3c4c5c6c7c8c9d0d1";
const ORPHAN_LESSON = "o0o1o2o3o4o5o6o7o8o9p0p1";
const QUIZ_LESSON = "q0q1q2q3q4q5q6q7q8q9r0r1";
const DRAFT_QUIZ_LESSON = "s0s1s2s3s4s5s6s7s8s9t0t1";
const BROKEN_QUIZ_LESSON = "u0u1u2u3u4u5u6u7u8u9v0v1";
const YEARLY_LESSON = "y0y1y2y3y4y5y6y7y8y9z0z1";
const WAREHOUSE_LESSON = "w0w1w2w3w4w5w6w7w8w9x0x1";
const QUIZ_NOT_PASSED = "Quiz not passed";
/** Two questions; the second's correct answer is the first option. */
const QUIZ = [
  { question: "Q1", options: ["a", "b", "c"], correctIndex: 2 },
  { question: "Q2", options: ["a", "b"], correctIndex: 0 },
];
const MEMBER = { id: 5, role: { type: "member" } };
const EDITOR = { id: 6, role: { type: "editor" } };
const OFFICE = 3;
const WAREHOUSE = 4;

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const PUBLISHED_COURSE = { id: 1, publishedAt: "2026-09-01T00:00:00.000Z" };
const DRAFT_COURSE = { id: 2, publishedAt: null };
const YEARLY_COURSE = { ...PUBLISHED_COURSE, id: 3, validityMonths: 12 };
const WAREHOUSE_COURSE = {
  ...PUBLISHED_COURSE,
  id: 4,
  audience: "departments",
  departments: [{ id: WAREHOUSE }],
};

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
    // The draft row's quiz differs: the published one is what counts.
    { id: 15, documentId: QUIZ_LESSON, publishedAt: null, quiz: [], course: PUBLISHED_COURSE },
    {
      id: 16,
      documentId: QUIZ_LESSON,
      publishedAt: "2026-09-01T00:00:00.000Z",
      quiz: QUIZ,
      course: PUBLISHED_COURSE,
    },
    {
      id: 17,
      documentId: DRAFT_QUIZ_LESSON,
      publishedAt: null,
      quiz: QUIZ,
      course: PUBLISHED_COURSE,
    },
    {
      id: 18,
      documentId: BROKEN_QUIZ_LESSON,
      publishedAt: "2026-09-01T00:00:00.000Z",
      // Corrupt stored content must never become a manual-completion lesson.
      quiz: [{ question: "Q", options: ["only one"], correctIndex: 0 }, "garbage"],
      course: PUBLISHED_COURSE,
    },
    {
      id: 19,
      documentId: YEARLY_LESSON,
      publishedAt: "2026-09-01T00:00:00.000Z",
      course: YEARLY_COURSE,
    },
    {
      id: 20,
      documentId: WAREHOUSE_LESSON,
      publishedAt: "2026-09-01T00:00:00.000Z",
      course: WAREHOUSE_COURSE,
    },
  ];
}

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (typeof cond === "object" && cond !== null && "$notNull" in cond) return row[key] != null;
    return row[key] === cond;
  });
}

function setup(body: unknown, progress: Row[] = []) {
  const tables: Record<string, Row[]> = {
    [LESSON_UID]: lessons().map((row) => ({ quiz: null, ...row })),
    [PROGRESS_UID]: progress,
    [USER_UID]: [
      { id: MEMBER.id, department: { id: OFFICE } },
      { id: EDITOR.id, department: null },
    ],
  };
  const calls: { uid: string; op: string; params: Row }[] = [];
  const query = (uid: string) => ({
    findOne: vi.fn(async (params: { where: Where }) => {
      calls.push({ uid, op: "findOne", params });
      return tables[uid].find((row) => matches(row, params.where)) ?? null;
    }),
    findMany: vi.fn(async (params: { where: Where }) => {
      calls.push({ uid, op: "findMany", params });
      return tables[uid].filter((row) => matches(row, params.where));
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
    state: { user: MEMBER as { id: number; role: { type: string } } | undefined },
    request: { body },
    badRequest: vi.fn((message: string, details?: unknown) => ({ status: 400, message, details })),
    status: 200,
    body: undefined as unknown,
    unauthorized: vi.fn(() => ({ status: 401 })),
    send: vi.fn((payload: unknown) => payload),
  };
  return { controller, ctx, calls, tables };
}

/** The player's `version` of every published lesson and course of this stub (v0.28). */
const VERSION = { course: "2026-09-01T00:00:00.000Z", lesson: "2026-09-01T00:00:00.000Z" };

/** The body with the player's version added where the caller sent none (v0.28). */
function withVersion(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const outer = body as Row;
  if (typeof outer.data === "object" && outer.data !== null && !Array.isArray(outer.data)) {
    const data = outer.data as Row;
    return "version" in data ? body : { ...outer, data: { ...data, version: VERSION } };
  }
  return "version" in outer ? body : { ...outer, version: VERSION };
}

async function complete(body: unknown, progress?: Row[]) {
  const s = setup(withVersion(body), progress);
  await s.controller.create(s.ctx);
  return s;
}

const created = <C extends { op: string }>(calls: C[]) => calls.filter((c) => c.op === "create");

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
            snapshot: expect.objectContaining({ v: 1 }),
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
        select: ["documentId", "title", "body", "order", "videoUrl", "quiz", "publishedAt"],
        populate: {
          course: {
            select: [
              "documentId",
              "title",
              "slug",
              "completionMode",
              "validityMonths",
              "publishedAt",
              "audience",
            ],
            populate: { departments: { select: ["id"] } },
          },
        },
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

describe("lesson-progress create: a quiz lesson needs the correct answers (#70)", () => {
  it("records a quiz lesson with every answer correct", async () => {
    const { ctx, calls } = await complete({
      data: { targetDocumentId: QUIZ_LESSON, answers: [2, 0] },
    });
    expect(ctx.badRequest).not.toHaveBeenCalled();
    // The answers are checked, never stored.
    expect(created(calls).map((c) => c.params)).toEqual([
      {
        data: {
          user: MEMBER.id,
          targetDocumentId: QUIZ_LESSON,
          completedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
          snapshot: expect.objectContaining({ quizPassed: true }),
        },
      },
    ]);
  });

  it("refuses no, wrong, partial or mistyped answers, before the receipt lookup", async () => {
    for (const answers of [undefined, [], [2], [0, 0], [2, 1], [2, 0, 1], ["2", "0"], "2,0"]) {
      const { ctx, calls } = await complete({ data: { targetDocumentId: QUIZ_LESSON, answers } });
      expect(ctx.badRequest.mock.calls, JSON.stringify(answers)).toEqual([[QUIZ_NOT_PASSED]]);
      expect(created(calls)).toEqual([]);
      expect(calls.filter((c) => c.uid === PROGRESS_UID)).toEqual([]);
    }
  });

  it("takes the answers from a bare body as well as from `data`", async () => {
    const { ctx, calls } = await complete({ targetDocumentId: QUIZ_LESSON, answers: [2, 0] });
    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(created(calls)).toHaveLength(1);
  });

  it("answers an unavailable quiz lesson like any other, whatever the answers", async () => {
    const { ctx } = await complete({ data: { targetDocumentId: DRAFT_QUIZ_LESSON } });
    expect(ctx.badRequest.mock.calls).toEqual([[NOT_AVAILABLE]]);
  });

  it("refuses corrupt stored quiz content before any receipt lookup", async () => {
    const { ctx, calls } = await complete({ data: { targetDocumentId: BROKEN_QUIZ_LESSON } });
    expect(ctx.badRequest).toHaveBeenCalledWith("Invalid quiz content", {
      code: "quizContentInvalid",
    });
    expect(calls.filter((c) => c.uid === PROGRESS_UID)).toEqual([]);
  });

  it("bounds submitted answers even for a manual-completion lesson", async () => {
    for (const answers of [null, "0", [-1], [1.5], [8], Array(21).fill(0)]) {
      const { ctx, calls } = await complete({
        data: { targetDocumentId: PUBLISHED_LESSON, answers },
      });
      expect(ctx.badRequest).toHaveBeenCalledWith(QUIZ_NOT_PASSED);
      expect(created(calls)).toEqual([]);
    }
  });

  it("still answers 'Already completed' for a second, correct completion", async () => {
    const { ctx, calls } = await complete(
      { data: { targetDocumentId: QUIZ_LESSON, answers: [2, 0] } },
      [{ id: 1, user: MEMBER.id, targetDocumentId: QUIZ_LESSON }],
    );
    expect(ctx.badRequest).toHaveBeenCalledWith("Already completed");
    expect(created(calls)).toEqual([]);
  });
});

describe("lesson-progress create: renewal of a course with validityMonths (v0.20)", () => {
  const receipt = (completedAt: string) => ({
    id: 1,
    user: MEMBER.id,
    targetDocumentId: YEARLY_LESSON,
    completedAt,
  });
  const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

  it("refuses a second receipt while the newest is valid for more than 30 days", async () => {
    const { ctx, calls } = await complete({ data: { targetDocumentId: YEARLY_LESSON } }, [
      receipt(daysAgo(30)),
    ]);
    expect(ctx.badRequest).toHaveBeenCalledWith("Already completed");
    expect(created(calls)).toEqual([]);
  });

  it("takes a new receipt once the newest is due within 30 days or overdue", async () => {
    for (const age of [345, 400]) {
      const { ctx, calls, tables } = await complete({ data: { targetDocumentId: YEARLY_LESSON } }, [
        receipt(daysAgo(age)),
      ]);
      expect(ctx.badRequest, String(age)).not.toHaveBeenCalled();
      expect(created(calls)).toHaveLength(1);
      // The old receipt stays: it is the proof history.
      expect(tables[PROGRESS_UID]).toHaveLength(2);
    }
  });

  it("judges by the NEWEST receipt", async () => {
    const { ctx } = await complete({ data: { targetDocumentId: YEARLY_LESSON } }, [
      receipt(daysAgo(400)),
      { ...receipt(daysAgo(10)), id: 2 },
    ]);
    expect(ctx.badRequest).toHaveBeenCalledWith("Already completed");
  });
});

describe("lesson-progress create: course audience (v0.20)", () => {
  it("answers a course for another department like an unknown lesson", async () => {
    const { ctx, calls } = await complete({ data: { targetDocumentId: WAREHOUSE_LESSON } });
    expect(ctx.badRequest.mock.calls).toEqual([[NOT_AVAILABLE]]);
    expect(created(calls)).toEqual([]);
  });

  it("lets a member of a linked department and a moderator complete it", async () => {
    const member = setup(withVersion({ data: { targetDocumentId: WAREHOUSE_LESSON } }));
    member.tables[USER_UID][0].department = { id: WAREHOUSE };
    await member.controller.create(member.ctx);
    expect(member.ctx.badRequest).not.toHaveBeenCalled();

    const editor = setup(withVersion({ data: { targetDocumentId: WAREHOUSE_LESSON } }));
    editor.ctx.state.user = EDITOR;
    await editor.controller.create(editor.ctx);
    expect(editor.ctx.badRequest).not.toHaveBeenCalled();
    expect(created(editor.calls)).toHaveLength(1);
  });
});

describe("lesson-progress create: the published version and the evidence snapshot (v0.28)", () => {
  it("answers 409 changed without the player's version, or with another one, and writes nothing", async () => {
    for (const version of [
      undefined,
      null,
      {},
      { ...VERSION, lesson: "2026-09-02T00:00:00.000Z" },
      { ...VERSION, course: "x" },
    ]) {
      const s = setup({ data: { targetDocumentId: PUBLISHED_LESSON, version } });
      await s.controller.create(s.ctx);
      expect(s.ctx.status, JSON.stringify(version)).toBe(409);
      expect((s.ctx.body as { error: { details: { code: string } } }).error.details.code).toBe(
        "changed",
      );
      expect(created(s.calls)).toEqual([]);
    }
  });

  it("compares instants, not spellings", async () => {
    const { ctx, calls } = await complete({
      data: {
        targetDocumentId: PUBLISHED_LESSON,
        version: { course: "2026-09-01T02:00:00+02:00", lesson: "2026-09-01T00:00:00Z" },
      },
    });
    expect(ctx.status).toBe(200);
    expect(created(calls)).toHaveLength(1);
  });

  it("stores what was checked: course, lesson, versions, mode, quiz outcome, validity and learner", async () => {
    const quiz = await complete({ data: { targetDocumentId: QUIZ_LESSON, answers: [2, 0] } });
    expect(created(quiz.calls)[0].params.data).toMatchObject({
      snapshot: {
        v: 1,
        course: { publishedAt: VERSION.course },
        lesson: { documentId: QUIZ_LESSON, publishedAt: VERSION.lesson },
        completionMode: "confirm",
        quizPassed: true,
        validUntil: null,
        learner: { displayName: "#5", email: null },
      },
    });
    const yearly = await complete({ data: { targetDocumentId: YEARLY_LESSON } });
    const snapshot = (created(yearly.calls)[0].params.data as { snapshot: Row }).snapshot;
    expect(snapshot.quizPassed).toBeNull();
    expect(snapshot.validUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Never echoed to the learner.
    expect(yearly.ctx.send).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ snapshot: expect.anything() }),
    });
  });
});
