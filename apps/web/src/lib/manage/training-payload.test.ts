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
        validityMonths: null,
        contact: null,
        departments: [],
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
  it("sends the course contact trimmed, an empty one as null, a long one refused (v0.28)", () => {
    const initial = { ...emptyCourseValues(), title: "Course" };
    const update = { ...ctx, mode: "update" as const };
    expect(
      buildCoursePayload({ ...initial, contact: " Max Muster, Tel. 123 " }, initial, update),
    ).toEqual({ ok: true, data: { contact: "Max Muster, Tel. 123" } });
    const named = { ...initial, contact: "Max" };
    expect(buildCoursePayload({ ...named, contact: "  " }, named, update)).toEqual({
      ok: true,
      data: { contact: null },
    });
    expect(
      buildCoursePayload({ ...initial, contact: "x".repeat(256) }, initial, update),
    ).toMatchObject({
      ok: false,
    });
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
  it("sends the validity in whole months 1–120, empty as once", () => {
    const initial = { ...emptyCourseValues(), title: "Course" };
    const update = { ...ctx, mode: "update" as const };
    expect(buildCoursePayload({ ...initial, validityMonths: " 12 " }, initial, update)).toEqual({
      ok: true,
      data: { validityMonths: 12 },
    });
    expect(
      buildCoursePayload(
        { ...initial, validityMonths: "" },
        { ...initial, validityMonths: "6" },
        update,
      ),
    ).toEqual({ ok: true, data: { validityMonths: null } });
    for (const typed of ["0", "121", "1.5", "-3", "zwölf"]) {
      expect(
        buildCoursePayload({ ...initial, validityMonths: typed }, initial, update),
        typed,
      ).toEqual({ ok: false, fields: { validityMonths: "invalid" } });
    }
  });
  it("sends departments only when changed, and never widens a course that needs re-targeting", () => {
    const office = "o".repeat(24);
    const initial = { ...emptyCourseValues(), title: "Course", departments: [office] };
    const update = { ...ctx, mode: "update" as const };
    expect(buildCoursePayload({ ...initial, title: "New" }, initial, update)).toEqual({
      ok: true,
      data: { title: "New" },
    });
    expect(buildCoursePayload({ ...initial, departments: [] }, initial, update)).toEqual({
      ok: true,
      data: { departments: [] },
    });
    expect(
      buildCoursePayload({ ...initial, departments: [] }, initial, {
        ...update,
        needsRetarget: true,
      }),
    ).toEqual({ ok: false, fields: { departments: "confirmAudience" } });
    expect(
      buildCoursePayload({ ...initial, departments: [] }, initial, {
        ...update,
        needsRetarget: true,
        retarget: true,
      }),
    ).toEqual({ ok: true, data: { departments: [] } });
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
