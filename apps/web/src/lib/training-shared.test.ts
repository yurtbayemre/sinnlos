import { describe, expect, it } from "vitest";

import {
  courseCompletion,
  evaluateQuiz,
  parseQuiz,
  sortLessons,
  youtubeVideoId,
} from "./training-shared";

describe("youtubeVideoId (mirror of the CMS copy)", () => {
  it("accepts the canonical forms and rejects foreign hosts", () => {
    expect(youtubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://vimeo.com/123")).toBeNull();
    expect(youtubeVideoId("javascript:alert(1)")).toBeNull();
  });
});

describe("parseQuiz", () => {
  it("drops malformed entries instead of crashing the player", () => {
    const quiz = parseQuiz([
      { question: "ok?", options: ["a", "b"], correctIndex: 1 },
      { question: "", options: ["a", "b"], correctIndex: 0 },
      { question: "bad idx", options: ["a", "b"], correctIndex: 5 },
      "garbage",
    ]);
    expect(quiz).toHaveLength(1);
  });
});

describe("evaluateQuiz (quiz-gate batch check)", () => {
  const quiz = parseQuiz([
    { question: "q1", options: ["a", "b"], correctIndex: 0 },
    { question: "q2", options: ["a", "b"], correctIndex: 1 },
  ]);

  it("passes only when every question is answered correctly", () => {
    expect(evaluateQuiz(quiz, { 0: 0, 1: 1 })).toEqual({
      wrong: [],
      answeredAll: true,
      passed: true,
    });
  });

  it("reports wrong indexes without passing", () => {
    const res = evaluateQuiz(quiz, { 0: 1, 1: 1 });
    expect(res.passed).toBe(false);
    expect(res.wrong).toEqual([0]);
    expect(res.answeredAll).toBe(true);
  });

  it("does not pass on partial answers (and does not mark unanswered as wrong)", () => {
    const res = evaluateQuiz(quiz, { 0: 0 });
    expect(res).toEqual({ wrong: [], answeredAll: false, passed: false });
  });

  it("passes trivially on an empty quiz — a gate must never dead-lock a lesson", () => {
    expect(evaluateQuiz([], {}).passed).toBe(true);
  });
});

describe("courseCompletion", () => {
  it("fails closed on zero lessons and derives done from the current list", () => {
    expect(courseCompletion([], new Set(["x"])).done).toBe(false);
    expect(courseCompletion([{ documentId: "a" }], new Set(["a"])).done).toBe(true);
    expect(courseCompletion([{ documentId: "a" }, { documentId: "b" }], new Set(["a"])).done).toBe(
      false,
    );
  });
});

describe("sortLessons", () => {
  it("sorts by order then id", () => {
    const sorted = sortLessons([
      { id: 2, order: 1 },
      { id: 1, order: 1 },
      { id: 3, order: 0 },
    ]);
    expect(sorted.map((l) => l.id)).toEqual([3, 1, 2]);
  });
});
