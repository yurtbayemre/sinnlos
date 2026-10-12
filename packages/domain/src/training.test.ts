import { describe, expect, it } from "vitest";

import {
  QUIZ_MAX_QUESTIONS,
  parseQuiz,
  validateQuiz,
  youtubeEmbedUrl,
  youtubeVideoId,
} from "./training.js";

/**
 * The YouTube parser (the web player's authoritative render gate and the cms
 * lesson lifecycle's author feedback) and the quiz schema (strict on write,
 * lenient on read). The cms keeps validateLessonData's own suite
 * (apps/cms/src/utils/training-validation.test.ts), the web the course and
 * quiz-gate helpers (apps/web/src/lib/training-shared.test.ts).
 */

describe("youtubeVideoId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=42", "dQw4w9WgXcQ"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
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
    ["https://vimeo.com/12345678"], // owner decision: YouTube only
    [""],
    [null],
    [42],
  ])("rejects %s", (url) => {
    expect(youtubeVideoId(url)).toBeNull();
  });

  it("rebuilds the embed URL from the id alone", () => {
    expect(youtubeEmbedUrl("dQw4w9WgXcQ")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    );
  });
});

describe("validateQuiz (write side, strict)", () => {
  const q = { question: "2+2?", options: ["3", "4"], correctIndex: 1 };

  it("accepts a valid quiz and normalizes whitespace", () => {
    const res = validateQuiz([{ ...q, question: "  2+2?  " }]);
    expect(res).toEqual({ quiz: [{ question: "2+2?", options: ["3", "4"], correctIndex: 1 }] });
  });

  it("treats null/undefined as empty quiz", () => {
    expect(validateQuiz(null)).toEqual({ quiz: [] });
    expect(validateQuiz(undefined)).toEqual({ quiz: [] });
  });

  it.each<[unknown, string]>([
    ["not-an-array", "JSON-Array"],
    [[{ ...q, options: ["only-one"] }], "options"],
    [[{ ...q, correctIndex: 2 }], "correctIndex"],
    [[{ ...q, correctIndex: 0.5 }], "correctIndex"],
    [[{ ...q, question: "" }], "question"],
    [[["nested-array"]], "Objekt"],
    [Array.from({ length: QUIZ_MAX_QUESTIONS + 1 }, () => q), "maximal"],
  ])("rejects invalid quiz %#", (raw, fragment) => {
    const res = validateQuiz(raw);
    expect("error" in res && res.error).toContain(fragment);
  });
});

describe("parseQuiz (read side, lenient)", () => {
  it("drops malformed entries instead of crashing the player", () => {
    const quiz = parseQuiz([
      { question: "ok?", options: ["a", "b"], correctIndex: 1 },
      { question: "", options: ["a", "b"], correctIndex: 0 },
      { question: "bad idx", options: ["a", "b"], correctIndex: 5 },
      "garbage",
    ]);
    expect(quiz).toEqual([{ question: "ok?", options: ["a", "b"], correctIndex: 1 }]);
    expect(parseQuiz({ not: "an array" })).toEqual([]);
  });

  it("keeps what the strict validator accepts", () => {
    const valid = [{ question: "2+2?", options: ["3", "4"], correctIndex: 1 }];
    const checked = validateQuiz(valid);
    expect("quiz" in checked && parseQuiz(checked.quiz)).toEqual(valid);
  });
});
