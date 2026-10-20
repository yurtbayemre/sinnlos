import { describe, expect, it } from "vitest";

import {
  QUIZ_MAX_QUESTIONS,
  RENEWAL_WINDOW_DAYS,
  courseValidity,
  lessonReceiptState,
  newestReceipts,
  receiptDueKey,
  isQuizSelectionList,
  parseQuiz,
  quizAnswersPass,
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

describe("quizAnswersPass (the completion gate, issue #70)", () => {
  const quiz = parseQuiz([
    { question: "Q1", options: ["a", "b", "c"], correctIndex: 2 },
    { question: "Q2", options: ["a", "b"], correctIndex: 0 },
  ]);

  it("passes exactly one correct answer per question", () => {
    expect(quizAnswersPass(quiz, [2, 0])).toBe(true);
  });

  it("refuses a wrong, missing, extra or mistyped answer", () => {
    for (const answers of [
      [1, 0],
      [2, 1],
      [2],
      [2, 0, 1],
      [],
      ["2", "0"],
      [2.0000001, 0],
      [2, null],
      { 0: 2, 1: 0, length: 2 },
      "2,0",
      null,
      undefined,
    ]) {
      expect(quizAnswersPass(quiz, answers), JSON.stringify(answers)).toBe(false);
    }
  });

  it("passes a lesson without questions with any answers (it completes by click)", () => {
    expect(quizAnswersPass([], undefined)).toBe(true);
    expect(quizAnswersPass([], [0])).toBe(true);
    // A malformed quiz parseQuiz drops entirely is no quiz: no dead lock.
    expect(quizAnswersPass(parseQuiz([{ question: "Q", options: ["only"] }]), undefined)).toBe(
      true,
    );
  });

  it("indexes the questions parseQuiz keeps, as the player shows them", () => {
    const withMalformed = parseQuiz([
      { question: "Q1", options: ["a", "b"], correctIndex: 1 },
      { question: "", options: ["a", "b"], correctIndex: 0 },
      { question: "Q3", options: ["a", "b"], correctIndex: 0 },
    ]);
    expect(quizAnswersPass(withMalformed, [1, 0])).toBe(true);
    expect(quizAnswersPass(withMalformed, [1, 0, 0])).toBe(false);
  });
});

describe("isQuizSelectionList", () => {
  it("accepts empty, partial, unordered and maximum-size bounded selections", () => {
    expect(isQuizSelectionList([])).toBe(true);
    expect(isQuizSelectionList([{ questionIndex: 19, optionIndex: 7 }])).toBe(true);
    expect(
      isQuizSelectionList([
        { questionIndex: 1, optionIndex: 1 },
        { questionIndex: 0, optionIndex: 0 },
      ]),
    ).toBe(true);
    expect(
      isQuizSelectionList(
        Array.from({ length: 20 }, (_, questionIndex) => ({ questionIndex, optionIndex: 0 })),
      ),
    ).toBe(true);
  });

  it("rejects wrong shapes, unknown keys, duplicates and values outside integer bounds", () => {
    const first = { questionIndex: 0, optionIndex: 0 };
    for (const value of [
      undefined,
      null,
      "0,1",
      {},
      [null],
      [[0, 0]],
      [{ questionIndex: 0 }],
      [{ ...first, correct: true }],
      [{ questionIndex: 0, answer: 0 }],
      [{ questionIndex: -1, optionIndex: 0 }],
      [{ questionIndex: 20, optionIndex: 0 }],
      [{ questionIndex: 0.1, optionIndex: 0 }],
      [{ questionIndex: "0", optionIndex: 0 }],
      [{ questionIndex: 0, optionIndex: -1 }],
      [{ questionIndex: 0, optionIndex: 8 }],
      [{ questionIndex: 0, optionIndex: 0.1 }],
      [{ questionIndex: 0, optionIndex: "0" }],
      [first, first],
      Array(21).fill(first),
    ]) {
      expect(isQuizSelectionList(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("recurring training validity", () => {
  const TZ = "Europe/Berlin";

  it("dates a receipt by its completion day in the app zone plus calendar months", () => {
    // 23:30 UTC on 31 Jan is already 1 Feb in Berlin.
    expect(receiptDueKey("2026-01-31T23:30:00Z", 12, TZ)).toBe("2027-02-01");
    expect(receiptDueKey("2026-01-31T10:00:00Z", 1, TZ)).toBe("2026-02-28");
    expect(receiptDueKey("2026-01-31T10:00:00Z", null, TZ)).toBeNull();
  });

  it("counts a lesson until its due day and opens renewal 30 days before", () => {
    const done = "2026-03-15T08:00:00+01:00";
    expect(lessonReceiptState(done, true, 12, "2027-02-12", TZ)).toEqual({
      counts: true,
      mayComplete: false,
      dueKey: "2027-03-15",
    });
    expect(lessonReceiptState(done, true, 12, "2027-02-13", TZ).mayComplete).toBe(true);
    expect(RENEWAL_WINDOW_DAYS).toBe(30);
    expect(lessonReceiptState(done, true, 12, "2027-03-14", TZ).counts).toBe(true);
    expect(lessonReceiptState(done, true, 12, "2027-03-15", TZ)).toEqual({
      counts: false,
      mayComplete: true,
      dueKey: "2027-03-15",
    });
  });

  it("keeps one-off courses valid forever and never renewable", () => {
    expect(lessonReceiptState("2020-01-01T00:00:00Z", true, null, "2030-01-01", TZ)).toEqual({
      counts: true,
      mayComplete: false,
      dueKey: null,
    });
    expect(lessonReceiptState(null, false, 12, "2030-01-01", TZ)).toEqual({
      counts: false,
      mayComplete: true,
      dueKey: null,
    });
  });

  it("fails closed on a receipt without a readable instant when the course expires", () => {
    expect(lessonReceiptState(null, true, 12, "2026-10-20", TZ).counts).toBe(false);
    expect(lessonReceiptState("garbage", true, 12, "2026-10-20", TZ).counts).toBe(false);
    expect(lessonReceiptState(null, true, null, "2026-10-20", TZ).counts).toBe(true);
  });

  describe("courseValidity", () => {
    const ids = ["a", "b"];
    const receipts = new Map([
      ["a", "2026-01-10T09:00:00Z"],
      ["b", "2026-03-01T09:00:00Z"],
    ]);

    it("is done until the earliest due day comes within 30 days", () => {
      expect(courseValidity(ids, receipts, 12, "2026-06-01", TZ)).toEqual({
        total: 2,
        completed: 2,
        status: "done",
        dueKey: "2027-01-10",
        completedAt: "2026-03-01T09:00:00Z",
      });
      expect(courseValidity(ids, receipts, 12, "2026-12-11", TZ).status).toBe("dueSoon");
    });

    it("expires on the earliest due day and stays expired while a lesson is overdue", () => {
      const expired = courseValidity(ids, receipts, 12, "2027-01-10", TZ);
      expect(expired).toMatchObject({ completed: 1, status: "expired", dueKey: "2027-01-10" });
      expect(expired.completedAt).toBeNull();
      const renewedA = new Map(receipts).set("a", "2027-01-11T09:00:00Z");
      expect(courseValidity(ids, renewedA, 12, "2027-03-02", TZ)).toMatchObject({
        completed: 1,
        status: "expired",
        dueKey: "2027-03-01",
      });
    });

    it("is open while a lesson was never done, even when others expired", () => {
      expect(courseValidity(["a", "b", "c"], receipts, 12, "2027-06-01", TZ)).toMatchObject({
        status: "open",
        dueKey: null,
      });
      expect(courseValidity([], receipts, 12, "2026-06-01", TZ).status).toBe("open");
    });

    it("never expires without validity", () => {
      expect(courseValidity(ids, receipts, null, "2040-01-01", TZ)).toMatchObject({
        status: "done",
        dueKey: null,
      });
    });
  });

  it("keeps the newest receipt per lesson whatever the row order", () => {
    const newest = newestReceipts([
      { targetDocumentId: "a", completedAt: "2027-01-11T09:00:00Z" },
      { targetDocumentId: "a", completedAt: "2026-01-10T09:00:00Z" },
      { targetDocumentId: "b", completedAt: null },
      { targetDocumentId: "b", completedAt: "2026-03-01T09:00:00Z" },
      { targetDocumentId: "c", completedAt: null },
      { targetDocumentId: "", completedAt: "2026-03-01T09:00:00Z" },
    ]);
    expect([...newest]).toEqual([
      ["a", "2027-01-11T09:00:00Z"],
      ["b", "2026-03-01T09:00:00Z"],
      ["c", null],
    ]);
  });
});
