import { describe, expect, it } from "vitest";
import { QUIZ_MAX_OPTIONS, QUIZ_MAX_QUESTIONS, QUIZ_MAX_TEXT } from "@sinnlos/domain";
import { buildCoursePayload, buildLessonPayload } from "./training-payload";
import { coerceLessonValues, emptyCourseValues, emptyLessonValues } from "./training-values";
import type { PayloadContext } from "./payload";

const ctx: PayloadContext = {
  mode: "create",
  roleClass: "moderator",
  timeZone: "Europe/Berlin",
  now: 0,
  ownDepartment: null,
};
const course = "c".repeat(24);
const question = { question: "Question?", options: ["A", "B"], correctIndex: 1 };
const lesson = { ...emptyLessonValues(course), title: "Lesson", quiz: [question] };

describe("training payloads", () => {
  it("creates the exact course fields and only changed fields on update", () => {
    const initial = { ...emptyCourseValues(), title: "Course" };
    expect(buildCoursePayload(initial, null, ctx)).toEqual({
      ok: true,
      data: {
        title: "Course",
        description: null,
        mandatory: false,
        completionMode: "confirm",
        coverImage: null,
      },
    });
    expect(
      buildCoursePayload({ ...initial, completionMode: "exam" }, initial, {
        ...ctx,
        mode: "update",
      }),
    ).toEqual({ ok: true, data: { completionMode: "exam" } });
  });
  it("omits retained image and raw legacy text, clears an image only on explicit change", () => {
    const coverImage = { id: 3, name: "x.png", mime: "image/png", size: 1, url: "/uploads/x.png" };
    const initial = {
      ...emptyCourseValues(),
      title: "Course",
      description: "  old <p>text</p>\n",
      coverImage,
    };
    expect(
      buildCoursePayload(
        { ...initial, mandatory: true, coverImage: { ...coverImage, name: "updated display" } },
        initial,
        { ...ctx, mode: "update" },
      ),
    ).toEqual({ ok: true, data: { mandatory: true } });
    expect(
      buildCoursePayload({ ...initial, coverImage: null }, initial, { ...ctx, mode: "update" }),
    ).toEqual({ ok: true, data: { coverImage: null } });
  });
  it("creates a lesson in its selected course, with no reparent payload on update", () => {
    expect(buildLessonPayload(lesson, null, ctx)).toMatchObject({
      ok: true,
      data: { course, order: 0, quiz: [question], videoUrl: null },
    });
    expect(
      buildLessonPayload({ ...lesson, course: "d".repeat(24), title: "Changed" }, lesson, {
        ...ctx,
        mode: "update",
      }),
    ).toEqual({ ok: true, data: { title: "Changed" } });
  });
  it.each([
    { ...question, correctIndex: 0 },
    { ...question, question: "Different?" },
    { ...question, options: ["B", "A"] },
  ])("sends a nested quiz edit", (changed) => {
    expect(
      buildLessonPayload({ ...lesson, quiz: [changed] }, lesson, { ...ctx, mode: "update" }),
    ).toEqual({ ok: true, data: { quiz: [changed] } });
  });
  it("preserves order changes and an explicit clear", () => {
    const second = { ...question, question: "Second?" };
    expect(
      buildLessonPayload(
        { ...lesson, quiz: [second, question] },
        { ...lesson, quiz: [question, second] },
        { ...ctx, mode: "update" },
      ),
    ).toMatchObject({ data: { quiz: [second, question] } });
    expect(buildLessonPayload({ ...lesson, quiz: [] }, lesson, { ...ctx, mode: "update" })).toEqual(
      { ok: true, data: { quiz: [] } },
    );
  });
  it.each([
    null,
    undefined,
    "[]",
    {},
    [null],
    [{ ...question, correctIndex: -1 }],
    [{ ...question, question: "x".repeat(QUIZ_MAX_TEXT + 1) }],
    [{ ...question, options: Array(QUIZ_MAX_OPTIONS + 1).fill("x") }],
    Array(QUIZ_MAX_QUESTIONS + 1).fill(question),
  ])("refuses malformed or oversized quiz instead of silently clearing it: %j", (quiz) => {
    const input = coerceLessonValues({ ...lesson, quiz });
    expect(buildLessonPayload(input, null, ctx)).toMatchObject({
      ok: false,
      fields: { quiz: "quizInvalid" },
    });
  });
  it("accepts exact quiz limits, refuses non-YouTube videos and order outside the domain bound", () => {
    const max = {
      question: "x".repeat(QUIZ_MAX_TEXT),
      options: Array(QUIZ_MAX_OPTIONS).fill("x"),
      correctIndex: QUIZ_MAX_OPTIONS - 1,
    };
    expect(
      buildLessonPayload({ ...lesson, quiz: Array(QUIZ_MAX_QUESTIONS).fill(max) }, null, ctx).ok,
    ).toBe(true);
    expect(
      buildLessonPayload(
        { ...lesson, videoUrl: "https://evil.example/watch?v=dQw4w9WgXcQ", order: "10001" },
        null,
        ctx,
      ),
    ).toMatchObject({ ok: false, fields: { videoUrl: "videoUrlNotYoutube", order: "invalid" } });
  });
});
