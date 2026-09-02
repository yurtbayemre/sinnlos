import { describe, expect, it } from "vitest";

import { validateLessonData, validateQuiz, youtubeVideoId } from "./training-validation";

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

describe("validateLessonData (partial-update rule)", () => {
  it("ignores absent fields — admin saves send partial payloads", () => {
    expect(validateLessonData({ title: "nur Titel" })).toBeNull();
  });

  it("accepts empty/null videoUrl (clearing the field)", () => {
    expect(validateLessonData({ videoUrl: "" })).toBeNull();
    expect(validateLessonData({ videoUrl: null })).toBeNull();
  });

  it("rejects a non-YouTube videoUrl with a German admin message", () => {
    expect(validateLessonData({ videoUrl: "https://vimeo.com/1" })).toContain("YouTube");
  });

  it("validates quiz and order only when present", () => {
    expect(validateLessonData({ quiz: "kaputt" })).toContain("JSON-Array");
    expect(validateLessonData({ order: -1 })).toContain("order");
    expect(validateLessonData({ order: 3 })).toBeNull();
  });
});
