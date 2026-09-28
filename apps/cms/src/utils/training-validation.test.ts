import { describe, expect, it } from "vitest";

import {
  QUIZ_NOT_JSON_ERROR,
  validateLessonData,
  validateQuiz,
  youtubeVideoId,
} from "./training-validation";

describe("youtubeVideoId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=42", "dQw4w9WgXcQ"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ", "dQw4w9WgXcQ"],
  ])("accepts %s", (url, id) => {
    expect(youtubeVideoId(url)).toBe(id);
  });

  it.each([
    ["http://www.youtube.com/watch?v=dQw4w9WgXcQ"], // http, not https
    ["https://evil.example/watch?v=dQw4w9WgXcQ"],
    ["https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=<script>"],
    ["https://www.youtube.com/watch?v=short"],
    ["javascript:alert(1)"],
    ["https://vimeo.com/12345678"], // user decision: YouTube only
    [""],
    [null],
    [42],
  ])("rejects %s", (url) => {
    expect(youtubeVideoId(url as any)).toBeNull();
  });
});

describe("validateQuiz", () => {
  const q = { question: "2+2?", options: ["3", "4"], correctIndex: 1 };

  it("accepts a valid quiz and normalizes whitespace", () => {
    const res = validateQuiz([{ ...q, question: "  2+2?  " }]);
    expect(res).toEqual({ quiz: [{ question: "2+2?", options: ["3", "4"], correctIndex: 1 }] });
  });

  it("treats null/undefined as empty quiz", () => {
    expect(validateQuiz(null)).toEqual({ quiz: [] });
  });

  it.each([
    ["not-an-array", "JSON-Array"],
    [[{ ...q, options: ["only-one"] }], "options"],
    [[{ ...q, correctIndex: 2 }], "correctIndex"],
    [[{ ...q, correctIndex: 0.5 }], "correctIndex"],
    [[{ ...q, question: "" }], "question"],
    [[["nested-array"]], "Objekt"],
    [Array.from({ length: 21 }, () => q), "maximal"],
  ])("rejects invalid quiz %#", (raw, fragment) => {
    const res = validateQuiz(raw as any);
    expect("error" in res && res.error).toContain(fragment);
  });
});

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
