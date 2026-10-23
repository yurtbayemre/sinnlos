import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LessonPlayerResponse, QuizCheckResponse, QuizSelection } from "@sinnlos/domain";

import { ADMIN_ENV, contentManager, type ContentManager } from "./admin-api.test.helper";
import {
  createTestStrapi,
  TEST_ROLES,
  testEngines,
  type Caller,
  type Row,
  type TestStrapi,
} from "./harness.test.helper";

const LESSON = "api::lesson.lesson";
const COURSE = "api::course.course";
const PROGRESS = "api::lesson-progress.lesson-progress";
const QUIZ_ONLY_MARKER = "ZZQUIZPRIVATEPORT";
const QUIZ = [
  { question: `${QUIZ_ONLY_MARKER}: HTTPS port?`, options: ["21", "80", "443"], correctIndex: 2 },
  { question: "Report a phishing mail?", options: ["Yes", "No"], correctIndex: 0 },
];
const CORRECT: QuizSelection[] = [
  { questionIndex: 0, optionIndex: 2 },
  { questionIndex: 1, optionIndex: 0 },
];
const WRONG: QuizSelection[] = [
  { questionIndex: 0, optionIndex: 1 },
  { questionIndex: 1, optionIndex: 0 },
];

interface ErrorBody {
  error?: { status?: number; message?: string; details?: { code?: string } };
}

interface ProgressRow {
  targetDocumentId: string;
}

/** The same real HTTP boundary, against the JSON storage of both supported engines. */
describe.each(testEngines())("answerless lesson player and grading on %s", (engine) => {
  let t: TestStrapi;
  let panel: ContentManager;
  const courses = {} as Record<"confirm" | "gate" | "exam", Row>;
  const lessons = {} as Record<"confirm" | "gate" | "exam" | "plain" | "empty", Row>;
  let suffix = 0;

  const lesson = (course: Row, quiz: unknown = QUIZ, status: "draft" | "published" = "published") =>
    t.strapi.documents(LESSON).create({
      data: { title: `IT lesson ${++suffix}`, course: course.documentId, quiz },
      status,
    });
  const player = (caller: Caller, target: Row | string, query = "") =>
    t.api<LessonPlayerResponse & ErrorBody>(
      caller,
      `/api/lessons/${typeof target === "string" ? target : target.documentId}/player${query}`,
    );
  const check = (caller: Caller, target: Row | string, answers: unknown = CORRECT, query = "") =>
    t.api<QuizCheckResponse & ErrorBody>(
      caller,
      `/api/lessons/${typeof target === "string" ? target : target.documentId}/check${query}`,
      { json: { data: { answers } } },
    );
  // v0.28: the completion sends back the player's version (absent where the player refuses).
  const complete = async (caller: Caller, target: Row | string, answers?: unknown) => {
    const targetDocumentId = typeof target === "string" ? target : target.documentId;
    const shown = await player(caller, target);
    return t.api<ErrorBody & { data?: ProgressRow }>(caller, "/api/lesson-progresses", {
      json: {
        data: {
          targetDocumentId,
          ...(answers === undefined ? {} : { answers }),
          version: shown.body?.data?.version,
        },
      },
    });
  };
  const receipts = (target: Row) =>
    t.strapi.db.query(PROGRESS).findMany({ where: { targetDocumentId: target.documentId } });
  const rawQuiz = (target: Row, quiz: unknown) => {
    // Bypass lifecycle validation to model old/corrupt JSON rows, not an accepted author write.
    const connection = t.strapi.db.connection as unknown as {
      raw(sql: string, bindings: unknown[]): Promise<unknown>;
    };
    return connection.raw("UPDATE lessons SET quiz = ? WHERE id = ?", [
      JSON.stringify(quiz),
      target.id,
    ]);
  };

  beforeAll(async () => {
    t = await createTestStrapi({ engine, env: ADMIN_ENV });
    panel = await contentManager(t);
    for (const [key, completionMode] of [
      ["confirm", "confirm"],
      ["gate", "quizGate"],
      ["exam", "exam"],
    ] as const) {
      courses[key] = await t.strapi.documents(COURSE).create({
        data: { title: `IT ${key} course`, slug: `it-${key}-course`, completionMode },
        status: "published",
      });
      lessons[key] = await lesson(courses[key]);
    }
    lessons.plain = await lesson(courses.confirm, null);
    lessons.empty = await lesson(courses.confirm, []);
  });

  afterAll(async () => {
    await t?.stop();
  });

  it.each(TEST_ROLES.filter((role) => role !== "guest"))(
    "%s can read answerless questions and request feedback",
    async (role) => {
      for (const key of ["confirm", "gate", "exam"] as const) {
        const res = await player(role, lessons[key]);
        expect(res.status, res.text).toBe(200);
        expect(Object.keys(res.body.data).sort()).toEqual(
          ["documentId", "title", "body", "order", "videoUrl", "course", "quiz", "version"].sort(),
        );
        expect(res.body.data.quiz).toEqual(
          QUIZ.map(({ question, options }) => ({ question, options })),
        );
        expect(res.text).not.toContain("correctIndex");
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        expect(res.body.data.course).toEqual({
          documentId: courses[key].documentId,
          title: courses[key].title,
          slug: courses[key].slug,
          completionMode: key === "gate" ? "quizGate" : key,
        });
        const feedback = await check(role, lessons[key]);
        expect(feedback.status, feedback.text).toBe(200);
        expect(feedback.body.data.passed).toBe(true);
        expect(feedback.headers.get("cache-control")).toBe("private, no-store");
      }
    },
  );

  it("requires a canonical documentId instead of a numeric row id", async () => {
    const res = await player("member", String(lessons.confirm.id));
    expect(res.status, res.text).toBe(404);
  });

  it.each(["guest", null] as const)("refuses player and feedback for %s", async (caller) => {
    for (const res of [
      await player(caller, lessons.confirm),
      await check(caller, lessons.confirm),
    ]) {
      expect([401, 403]).toContain(res.status);
      expect(res.text).not.toContain(QUIZ_ONLY_MARKER);
    }
  });

  it("hides missing, draft-only, orphaned and unpublished-parent targets alike", async () => {
    const draft = await lesson(courses.confirm, QUIZ, "draft");
    const orphan = await lesson(courses.confirm);
    await t.strapi.db.query(LESSON).update({ where: { id: orphan.id }, data: { course: null } });
    const hiddenCourse = await t.strapi.documents(COURSE).create({
      data: { title: "IT hidden parent", slug: "it-hidden-parent" },
      status: "published",
    });
    const hidden = await lesson(hiddenCourse);
    await t.strapi.documents(COURSE).unpublish({ documentId: hiddenCourse.documentId });
    for (const caller of ["member", "editor", "admin_role"] as const) {
      const baseline = {
        player: await player(caller, "zzmissinglesson0000000000"),
        check: await check(caller, "zzmissinglesson0000000000"),
        complete: await complete(caller, "zzmissinglesson0000000000", [2, 0]),
      };
      expect(baseline.player.status).toBe(404);
      expect(baseline.check.status).toBe(404);
      expect(baseline.complete.status).toBe(400);
      for (const target of [draft, orphan, hidden]) {
        for (const [kind, res] of [
          ["player", await player(caller, target)],
          ["check", await check(caller, target)],
          ["complete", await complete(caller, target, [2, 0])],
        ] as const) {
          expect({ status: res.status, body: res.body }).toEqual({
            status: baseline[kind].status,
            body: baseline[kind].body,
          });
        }
        expect(await receipts(target)).toEqual([]);
      }
    }
  });

  it("rejects generic queries and client-selected modes on both custom actions", async () => {
    for (const query of [
      "?status=draft",
      "?fields[0]=quiz",
      "?filters[quiz][$notNull]=true",
      "?sort=quiz",
      "?populate=*",
      "?completionMode=confirm",
      "?mode=confirm",
      "?page=1",
      "?_q=correctIndex",
    ]) {
      for (const res of [
        await player("member", lessons.exam, query),
        await check("member", lessons.exam, CORRECT, query),
      ]) {
        expect(res.status, `${query}: ${res.text}`).toBe(400);
        expect(res.body).not.toHaveProperty("data.verdicts");
      }
    }
  });

  it("confirm gives only selected verdicts; quizGate checks the whole selection", async () => {
    const partial = await check("member", lessons.confirm, [CORRECT[1]]);
    expect(partial.status, partial.text).toBe(200);
    expect(partial.body.data).toEqual({
      completionMode: "confirm",
      passed: false,
      verdicts: [{ questionIndex: 1, correct: true }],
    });
    const wrong = await check("member", lessons.gate, WRONG);
    expect(wrong.status, wrong.text).toBe(200);
    expect(wrong.body.data).toEqual({
      completionMode: "quizGate",
      passed: false,
      verdicts: [
        { questionIndex: 0, correct: false },
        { questionIndex: 1, correct: true },
      ],
    });
    for (const target of [lessons.gate, lessons.exam]) {
      expect((await check("member", target, [CORRECT[0]])).status).toBe(400);
    }
    expect(await receipts(lessons.confirm)).toEqual([]);
    expect(await receipts(lessons.gate)).toEqual([]);
    expect(await receipts(lessons.exam)).toEqual([]);
  });

  it("exam exposes only the overall result, including review after completion", async () => {
    for (const [answers, passed] of [
      [WRONG, false],
      [CORRECT, true],
    ] as const) {
      const res = await check("member", lessons.exam, answers);
      expect(res.status, res.text).toBe(200);
      expect(res.body).toEqual({ data: { completionMode: "exam", passed } });
    }
    expect(await receipts(lessons.exam)).toEqual([]);
    expect((await complete("member", lessons.exam, [2, 0])).status).toBe(200);
    const review = await check("member", lessons.exam, WRONG);
    expect(review.status, review.text).toBe(200);
    expect(review.body).toEqual({ data: { completionMode: "exam", passed: false } });
    expect(await receipts(lessons.exam)).toHaveLength(1);
    expect((await player("member", lessons.exam)).text).not.toContain("correctIndex");
  });

  it("rejects malformed, duplicate, unknown and out-of-bounds selections", async () => {
    const invalid = [
      null,
      {},
      "[]",
      [0, 1],
      [null],
      [{ questionIndex: 0, optionIndex: "2" }],
      [{ questionIndex: -1, optionIndex: 0 }],
      [{ questionIndex: 0.5, optionIndex: 0 }],
      [{ questionIndex: 2, optionIndex: 0 }],
      [{ questionIndex: 0, optionIndex: -1 }],
      [{ questionIndex: 0, optionIndex: 3 }],
      [{ questionIndex: 1, optionIndex: 2 }],
      [CORRECT[0], CORRECT[0]],
      [{ ...CORRECT[0], correct: true }],
      Array.from({ length: 21 }, () => CORRECT[0]),
    ];
    for (const answers of invalid) {
      const res = await check("member", lessons.confirm, answers);
      expect(res.status, `${JSON.stringify(answers)}: ${res.text}`).toBe(400);
      expect(res.body).not.toHaveProperty("data.verdicts");
    }
    for (const json of [
      {},
      { answers: CORRECT },
      { data: {} },
      { data: { answers: CORRECT, completionMode: "confirm" } },
      { data: { answers: CORRECT, user: t.fixtures.users.admin_role.id } },
      { data: { answers: CORRECT, passed: true } },
      { data: { answers: CORRECT }, mode: "confirm" },
    ]) {
      const res = await t.api("member", `/api/lessons/${lessons.exam.documentId}/check`, { json });
      expect(res.status, JSON.stringify(json)).toBe(400);
    }
  });

  it("regrades completion independently and stores only the authenticated user's receipt", async () => {
    expect((await check("member", lessons.confirm)).body.data.passed).toBe(true);
    for (const answers of [undefined, [], [1, 0], [2, 1], [2], ["2", "0"], [2, 0, 0]]) {
      const res = await complete("member", lessons.confirm, answers);
      expect(res.status, JSON.stringify(answers)).toBe(400);
      expect(res.body.error?.message).toBe("Quiz not passed");
    }
    const forged = await t.api("member", "/api/lesson-progresses", {
      json: {
        data: {
          targetDocumentId: lessons.confirm.documentId,
          answers: [1, 0],
          passed: true,
          user: t.fixtures.users.admin_role.id,
          version: (await player("member", lessons.confirm)).body.data.version,
        },
      },
    });
    expect(forged.status).toBe(400);
    expect(await receipts(lessons.confirm)).toEqual([]);
    const res = await complete("member", lessons.confirm, [2, 0]);
    expect(res.status, res.text).toBe(200);
    expect(res.body.data?.targetDocumentId).toBe(lessons.confirm.documentId);
    const stored = await t.strapi.db.query(PROGRESS).findMany({
      where: { targetDocumentId: lessons.confirm.documentId },
      populate: { user: { select: ["id"] } },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].user).toMatchObject({ id: t.fixtures.users.member.id });
    const again = await complete("member", lessons.confirm, [2, 0]);
    expect(again.status).toBe(400);
    expect(again.body.error?.message).toBe("Already completed");
    expect((await complete("team_lead", lessons.gate, [2, 0])).status).toBe(200);
  });

  it("null and empty quizzes still complete manually", async () => {
    for (const target of [lessons.plain, lessons.empty]) {
      expect((await player("member", target)).body.data.quiz).toEqual([]);
      expect((await check("member", target, [])).body.data.passed).toBe(true);
      const res = await complete("member", target);
      expect(res.status, res.text).toBe(200);
      expect(res.body.data?.targetDocumentId).toBe(target.documentId);
    }
  });

  it("rejects malformed stored quizzes in both feedback and completion for every mode", async () => {
    for (const course of Object.values(courses)) {
      const target = await lesson(course);
      for (const corrupt of [
        {},
        "not an array",
        [null],
        [QUIZ[0], { question: "broken", options: ["one", "two"] }],
        [{ ...QUIZ[0], correctIndex: 99 }],
      ]) {
        await rawQuiz(target, corrupt);
        for (const res of [
          await check("member", target),
          await complete("member", target, [2, 0]),
        ]) {
          expect(res.status, `${JSON.stringify(corrupt)}: ${res.text}`).toBe(400);
          expect(res.body.error?.details?.code).toBe("quizContentInvalid");
          expect(res.text).not.toContain("correctIndex");
        }
        expect(await receipts(target)).toEqual([]);
      }
    }
  });

  it("reads the current published mode and quiz, preserving existing receipts", async () => {
    const course = await t.strapi.documents(COURSE).create({
      data: { title: "IT changing course", slug: "it-changing-course" },
      status: "published",
    });
    const target = await lesson(course);
    expect((await complete("member", target, [2, 0])).status).toBe(200);
    expect((await player("team_lead", target)).body.data.quiz[0].question).toBe(QUIZ[0].question);
    const changed = QUIZ.map((q) => ({ ...q, question: `Changed ${q.question}` }));
    await t.strapi
      .documents(LESSON)
      .update({ documentId: target.documentId, data: { quiz: changed } });
    await t.strapi.documents(LESSON).publish({ documentId: target.documentId });
    // Accepted alpha limit: old selections can pass new text with the same indices.
    expect((await complete("team_lead", target, [2, 0])).status).toBe(200);
    await t.strapi
      .documents(COURSE)
      .update({ documentId: course.documentId, data: { completionMode: "exam" } });
    await t.strapi.documents(COURSE).publish({ documentId: course.documentId });
    const feedback = await check("member", target);
    expect(feedback.status, feedback.text).toBe(200);
    expect(feedback.body).toEqual({ data: { completionMode: "exam", passed: true } });
    await t.strapi
      .documents(LESSON)
      .update({ documentId: target.documentId, data: { quiz: [QUIZ[0]] } });
    await t.strapi.documents(LESSON).publish({ documentId: target.documentId });
    const stale = await complete("editor", target, [2, 0]);
    expect(stale.status).toBe(400);
    expect(stale.body.error?.message).toBe("Quiz not passed");
    expect(await receipts(target)).toHaveLength(2);
    const mine = await t.api<{ data: ProgressRow[] }>("member", "/api/lesson-progresses");
    expect(mine.body.data.map((row) => row.targetDocumentId)).toContain(target.documentId);
  });

  it("a failed receipt insert is a server error and cannot report completion", async () => {
    const target = await lesson(courses.confirm);
    const repository = t.strapi.db.query(PROGRESS);
    expect(t.strapi.db.query(PROGRESS)).toBe(repository);
    const failing = vi
      .spyOn(repository, "create")
      .mockRejectedValueOnce(new Error("IT receipt insert failed"));
    try {
      const res = await complete("member", target, [2, 0]);
      expect(res.status).toBe(500);
      expect(res.body.data).toBeNull();
      expect(await receipts(target)).toEqual([]);
    } finally {
      failing.mockRestore();
    }
    expect((await complete("member", target, [2, 0])).status).toBe(200);
  });

  it("generic direct and nested reads never expose the raw quiz, even to content authors", async () => {
    for (const role of ["member", "authenticated", "editor", "admin_role"] as const) {
      for (const path of [
        `/api/lessons/${lessons.confirm.documentId}`,
        "/api/lessons?populate=*",
        `/api/courses/${courses.confirm.documentId}?populate[lessons]=true`,
        `/api/courses/${courses.confirm.documentId}?populate[lessons][populate][course]=true`,
        "/api/lessons?fields[0]=title&fields[1]=quiz",
        "/api/lessons?fields=quiz",
        `/api/courses/${courses.confirm.documentId}?populate[lessons][fields][0]=quiz`,
        "/api/courses?populate[0]=lessons&populate[1]=lessons.quiz",
        `/api/courses?populate=${encodeURIComponent(JSON.stringify({ lessons: { fields: ["quiz"] } }))}`,
      ]) {
        const res = await t.api(role, path);
        expect([200, 400], `${role} ${path}: ${res.text}`).toContain(res.status);
        expect(res.text, `${role} ${path}`).not.toContain("correctIndex");
        expect(res.text, `${role} ${path}`).not.toContain(QUIZ_ONLY_MARKER);
      }
    }
  });

  it("generic filters and sorts cannot turn the private quiz into an inference oracle", async () => {
    for (const path of [
      "/api/lessons?filters[quiz][$notNull]=true",
      "/api/lessons?filters[quiz][$contains]=correctIndex",
      "/api/lessons?filters[quiz][0][correctIndex][$eq]=2",
      "/api/lessons?filters[$and][0][quiz][$contains]=correctIndex",
      "/api/lessons?sort=quiz:asc",
      "/api/lessons?sort[0]=quiz:desc",
      "/api/lessons?sort[quiz]=asc",
      "/api/courses?filters[lessons][quiz][$notNull]=true",
      "/api/courses?sort=lessons.quiz:asc",
      "/api/courses?populate[lessons][filters][quiz][$contains]=correctIndex",
      "/api/courses?populate[lessons][sort][0]=quiz:asc",
      "/api/lessons?populate[course][populate][lessons][filters][quiz][$notNull]=true",
      `/api/lessons?filters=${encodeURIComponent(JSON.stringify({ quiz: { $notNull: true } }))}`,
      `/api/lessons?sort=${encodeURIComponent(JSON.stringify({ quiz: "asc" }))}`,
      `/api/courses?populate=${encodeURIComponent(JSON.stringify({ lessons: { filters: { quiz: { $notNull: true } } } }))}`,
    ]) {
      for (const role of ["member", "editor"] as const) {
        const res = await t.api(role, path);
        expect(res.status, `${role} ${path}: ${res.text}`).toBe(400);
        expect(res.text).not.toContain(QUIZ_ONLY_MARKER);
      }
    }
    for (const root of ["lessons", "courses"] as const) {
      const query = root === "courses" ? "populate[lessons][_q]" : "_q";
      const secret = await t.api("member", `/api/${root}?${query}=${QUIZ_ONLY_MARKER}`);
      const absent = await t.api("member", `/api/${root}?${query}=ZZNOSUCHPRIVATEVALUE`);
      expect([200, 400]).toContain(secret.status);
      expect(secret.status).toBe(absent.status);
      expect(secret.body).toEqual(absent.body);
      expect(secret.text).not.toContain(QUIZ_ONLY_MARKER);
    }
  });

  it("the panel retains the author key and a draft clear does not alter the published quiz", async () => {
    const target = await lesson(courses.confirm);
    const read = await panel.findOne(LESSON, target.documentId);
    expect(read.status, read.text).toBe(200);
    expect(read.body.data.quiz).toEqual(QUIZ);
    const clear = await panel.update(LESSON, target.documentId, { quiz: "" });
    expect(clear.status, clear.text).toBe(200);
    expect((await player("member", target)).body.data.quiz).toHaveLength(2);
    expect((await panel.findOne(LESSON, target.documentId)).body.data.quiz).toBeNull();
    const publish = await panel.publish(LESSON, target.documentId);
    expect(publish.status, publish.text).toBe(200);
    expect((await player("member", target)).body.data.quiz).toEqual([]);
    const restore = await panel.update(LESSON, target.documentId, { quiz: JSON.stringify(QUIZ) });
    expect(restore.status, restore.text).toBe(200);
    expect((await panel.findOne(LESSON, target.documentId)).body.data.quiz).toEqual(QUIZ);
    expect((await panel.publish(LESSON, target.documentId)).status).toBe(200);
    expect((await player("member", target)).body.data.quiz).toHaveLength(2);
    expect((await complete("member", target, [2, 0])).status).toBe(200);
  });
});
