import { QUIZ_CONTENT_INVALID, type TrainingCompletionMode } from "@sinnlos/domain";
import { describe, expect, it } from "vitest";

import {
  QUIZ_NOT_JSON_ERROR,
  checkStoredQuiz,
  validateLessonData,
  validateStoredQuiz,
} from "./training-validation";

// The YouTube parser and validateQuiz are @sinnlos/domain's
// (packages/domain/src/training.test.ts); this suite covers the lifecycle
// payload rules built on them.

/** The error message of a failed check, or null when the data is valid. */
function errorOf(data: Record<string, unknown>): string | null {
  const result = validateLessonData(data);
  return "error" in result ? result.error : null;
}

describe("validateLessonData (keys-present rule)", () => {
  it("ignores absent fields — script and db.query writers send partial payloads", () => {
    expect(validateLessonData({ title: "nur Titel" })).toEqual({ normalized: {} });
  });

  it("accepts empty/null videoUrl (clearing the field)", () => {
    expect(errorOf({ videoUrl: "" })).toBeNull();
    expect(errorOf({ videoUrl: null })).toBeNull();
  });

  it("rejects a non-YouTube videoUrl with a German admin message", () => {
    expect(errorOf({ videoUrl: "https://vimeo.com/1" })).toContain("YouTube");
  });

  it("validates quiz and order only when present", () => {
    expect(errorOf({ quiz: "[1]" })).toContain("Objekt");
    expect(errorOf({ quiz: '{"question":"?"}' })).toContain("JSON-Array");
    expect(errorOf({ order: -1 })).toContain("order");
    expect(errorOf({ order: 3 })).toBeNull();
  });
});

describe("validateLessonData: quiz from the admin panel (FX08)", () => {
  const question = { question: "2+2?", options: ["3", "4"], correctIndex: 1 };

  it("parses the raw editor text of an edited quiz and returns the array", () => {
    const text = JSON.stringify([{ ...question, question: " 2+2? " }], null, 2);
    expect(validateLessonData({ quiz: text })).toEqual({ normalized: { quiz: [question] } });
  });

  it("rejects text that is not JSON with a German message", () => {
    for (const quiz of ["kaputt", "[{", "[{'question':'?'}]", "undefined"]) {
      expect(validateLessonData({ quiz })).toEqual({ error: QUIZ_NOT_JSON_ERROR });
    }
    expect(QUIZ_NOT_JSON_ERROR).toBe("quiz ist kein gültiges JSON");
  });

  it("validates parsed text like an array", () => {
    const text = JSON.stringify([{ ...question, correctIndex: 5 }]);
    expect(errorOf({ quiz: text })).toContain("correctIndex");
  });

  it("reads '' (a cleared field) and whitespace as null", () => {
    for (const quiz of ["", " ", "\n\t "]) {
      expect(validateLessonData({ quiz })).toEqual({ normalized: { quiz: null } });
    }
  });

  it("keeps a valid array as it is, and null as null", () => {
    expect(validateLessonData({ quiz: [question] })).toEqual({ normalized: { quiz: [question] } });
    expect(validateLessonData({ quiz: [] })).toEqual({ normalized: { quiz: [] } });
    expect(validateLessonData({ quiz: null })).toEqual({ normalized: { quiz: null } });
  });

  it("leaves a missing or undefined quiz alone", () => {
    expect(validateLessonData({ order: 1 })).toEqual({ normalized: {} });
    expect(validateLessonData({ quiz: undefined })).toEqual({ normalized: {} });
  });

  it("is idempotent: the normalised quiz validates to itself (beforeCreate on publish)", () => {
    const first = validateLessonData({ quiz: JSON.stringify([question]) });
    if ("error" in first) throw new Error(first.error);
    expect(validateLessonData({ quiz: first.normalized.quiz })).toEqual(first);
  });
});

const QUIZ = [
  { question: "First?", options: ["yes", "no"], correctIndex: 0 },
  { question: "Second?", options: ["no", "yes", "maybe"], correctIndex: 1 },
];
const MODES: TrainingCompletionMode[] = ["confirm", "quizGate", "exam"];
const CORRECT = [
  { questionIndex: 0, optionIndex: 0 },
  { questionIndex: 1, optionIndex: 1 },
];

describe("strict stored quiz validation for all learner actions", () => {
  it("accepts null or an empty array as the deliberate no-quiz case", () => {
    expect(validateStoredQuiz(null)).toEqual({ quiz: [] });
    expect(validateStoredQuiz([])).toEqual({ quiz: [] });
    expect(validateStoredQuiz(QUIZ)).toEqual({ quiz: QUIZ });
  });

  it("refuses corrupt content instead of dropping invalid questions", () => {
    for (const raw of [
      undefined,
      false,
      0,
      "",
      "null",
      "[]",
      {},
      [null],
      [{ ...QUIZ[0], correctIndex: 2 }],
      [QUIZ[0], { question: "broken", options: ["only one"] }],
      Array(21).fill(QUIZ[0]),
    ]) {
      expect(validateStoredQuiz(raw)).toEqual({ error: QUIZ_CONTENT_INVALID });
      for (const mode of MODES) {
        expect(checkStoredQuiz(raw, mode, CORRECT)).toEqual({ error: QUIZ_CONTENT_INVALID });
      }
    }
  });
});

describe("checkStoredQuiz", () => {
  it("accepts partial confirm feedback by question index without passing the whole lesson", () => {
    expect(checkStoredQuiz(QUIZ, "confirm", [{ questionIndex: 1, optionIndex: 1 }])).toEqual({
      data: {
        completionMode: "confirm",
        passed: false,
        verdicts: [{ questionIndex: 1, correct: true }],
      },
    });
    expect(checkStoredQuiz(QUIZ, "confirm", [{ questionIndex: 0, optionIndex: 1 }])).toEqual({
      data: {
        completionMode: "confirm",
        passed: false,
        verdicts: [{ questionIndex: 0, correct: false }],
      },
    });
  });

  it("uses the same full-quiz grading in every mode regardless of selection order", () => {
    for (const mode of MODES) {
      const result = checkStoredQuiz(QUIZ, mode, [...CORRECT].reverse());
      expect(result).toMatchObject({ data: { completionMode: mode, passed: true } });
      expect(
        checkStoredQuiz(QUIZ, mode, [CORRECT[0], { questionIndex: 1, optionIndex: 0 }]),
      ).toMatchObject({ data: { completionMode: mode, passed: false } });
    }
  });

  it("returns only the overall result in exam, for both passed and failed attempts", () => {
    expect(checkStoredQuiz(QUIZ, "exam", CORRECT)).toEqual({
      data: { completionMode: "exam", passed: true },
    });
    expect(
      checkStoredQuiz(QUIZ, "exam", [CORRECT[0], { questionIndex: 1, optionIndex: 2 }]),
    ).toEqual({ data: { completionMode: "exam", passed: false } });
  });

  it("requires every question in quizGate and exam", () => {
    for (const mode of ["quizGate", "exam"] as const) {
      for (const selections of [[], [CORRECT[0]]]) {
        expect(checkStoredQuiz(QUIZ, mode, selections)).toEqual({ error: "Invalid quiz answers" });
      }
    }
  });

  it("applies shared input validation and the actual question/option bounds", () => {
    for (const selections of [
      [{ questionIndex: 2, optionIndex: 0 }],
      [{ questionIndex: 0, optionIndex: 2 }],
      [{ questionIndex: 0, optionIndex: 0, correct: true }],
      [CORRECT[0], CORRECT[0]],
    ]) {
      expect(checkStoredQuiz(QUIZ, "confirm", selections)).toEqual({
        error: "Invalid quiz answers",
      });
    }
  });
  it("keeps manual-completion lessons valid but accepts no invented selections", () => {
    for (const mode of MODES) {
      expect(checkStoredQuiz(null, mode, [])).toMatchObject({
        data: { completionMode: mode, passed: true },
      });
      expect(checkStoredQuiz([], mode, [CORRECT[0]])).toEqual({ error: "Invalid quiz answers" });
    }
  });
});
