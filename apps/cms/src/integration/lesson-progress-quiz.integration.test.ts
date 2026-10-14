import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";

/**
 * POST /api/lesson-progresses over real HTTP (issue #70): a lesson with a
 * quiz completes only with every answer correct, whatever the course's
 * completionMode (the default "confirm" one included); a lesson without a
 * quiz still completes by click. The quiz is read from the published
 * lesson row as each engine stores the JSON column; a quiz that came back
 * as text would read as no quiz and pass, which the refusals below rule
 * out.
 */

interface ErrorBody {
  error?: { status?: number; message?: string };
}

interface ProgressRow {
  targetDocumentId: string;
}

/** Two questions; the second's correct answer is the first option. */
const QUIZ = [
  { question: "Which port does HTTPS use?", options: ["21", "80", "443"], correctIndex: 2 },
  { question: "Report a phishing mail?", options: ["Yes", "No"], correctIndex: 0 },
];

describe.each(testEngines())("lesson completion with a quiz on %s", (engine) => {
  let t: TestStrapi;
  const lessons = {} as Record<"confirmQuiz" | "confirmPlain" | "gateQuiz", Row>;

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    const docs = (uid: string) => t.strapi.documents(uid);
    // Publish readiness refuses a lesson in a draft-only course: courses first.
    const confirm = await docs("api::course.course").create({
      data: { title: "IT confirm course", slug: "it-confirm-course" },
      status: "published",
    });
    const gate = await docs("api::course.course").create({
      data: { title: "IT gate course", slug: "it-gate-course", completionMode: "quizGate" },
      status: "published",
    });
    const lesson = (title: string, course: Row, quiz: unknown) =>
      docs("api::lesson.lesson").create({
        data: { title, course: course.documentId, ...(quiz ? { quiz } : {}) },
        status: "published",
      });
    lessons.confirmQuiz = await lesson("IT confirm quiz", confirm, QUIZ);
    lessons.confirmPlain = await lesson("IT confirm plain", confirm, null);
    lessons.gateQuiz = await lesson("IT gate quiz", gate, QUIZ);
  });

  afterAll(async () => {
    await t?.stop();
  });

  const complete = (role: "member" | "team_lead", lesson: Row, answers?: unknown) =>
    t.api<ErrorBody & { data?: ProgressRow }>(role, "/api/lesson-progresses", {
      json: {
        data: {
          targetDocumentId: lesson.documentId,
          ...(answers === undefined ? {} : { answers }),
        },
      },
    });

  it("refuses a quiz lesson without answers or with a wrong one, and records nothing", async () => {
    for (const answers of [undefined, [], [1, 0], [2, 1], [2], ["2", "0"]]) {
      const res = await complete("member", lessons.confirmQuiz, answers);
      expect(res.status, JSON.stringify(answers)).toBe(400);
      expect(res.body.error?.message).toBe("Quiz not passed");
    }
    const mine = await t.api<{ data: ProgressRow[] }>("member", "/api/lesson-progresses");
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((row) => row.targetDocumentId)).not.toContain(
      lessons.confirmQuiz.documentId,
    );
  });

  it("records it with every answer correct, once", async () => {
    const res = await complete("member", lessons.confirmQuiz, [2, 0]);
    expect(res.status).toBe(200);
    expect(res.body.data?.targetDocumentId).toBe(lessons.confirmQuiz.documentId);

    const mine = await t.api<{ data: ProgressRow[] }>("member", "/api/lesson-progresses");
    expect(mine.body.data.map((row) => row.targetDocumentId)).toContain(
      lessons.confirmQuiz.documentId,
    );
    const again = await complete("member", lessons.confirmQuiz, [2, 0]);
    expect(again.status).toBe(400);
    expect(again.body.error?.message).toBe("Already completed");
  });

  it("holds on a quizGate course the same way", async () => {
    const wrong = await complete("team_lead", lessons.gateQuiz, [0, 0]);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error?.message).toBe("Quiz not passed");
    expect((await complete("team_lead", lessons.gateQuiz, [2, 0])).status).toBe(200);
  });

  it("completes a lesson without a quiz by click, as before", async () => {
    const res = await complete("member", lessons.confirmPlain);
    expect(res.status).toBe(200);
    expect(res.body.data?.targetDocumentId).toBe(lessons.confirmPlain.documentId);
  });
});
