import { describe, expect, it } from "vitest";

import { quizGatesCompletion, sortLessons } from "./training-shared";

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

describe("the quiz gate of a lesson's completion (issue #70)", () => {
  const quiz = [{ question: "q1", options: ["a", "b", "c"] }];

  it("gates every open lesson with questions, never one without or one completed", () => {
    expect(quizGatesCompletion(quiz, false)).toBe(true);
    expect(quizGatesCompletion(quiz, true)).toBe(false);
    expect(quizGatesCompletion([], false)).toBe(false);
  });
});
