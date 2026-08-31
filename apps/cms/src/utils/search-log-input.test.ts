import { describe, expect, it } from "vitest";

import { sanitizeSearchLogInput } from "./search-log-input";

describe("sanitizeSearchLogInput", () => {
  it("normalizes term (trim, whitespace collapse, lowercase, cap) and clamps count", () => {
    expect(sanitizeSearchLogInput({ term: "  Urlaubs   Antrag  ", resultCount: 3.7 })).toEqual({
      term: "urlaubs antrag",
      resultCount: 4,
    });
  });

  it("caps the term at 120 chars and the count at bounds", () => {
    const long = "x".repeat(500);
    const res = sanitizeSearchLogInput({ term: long, resultCount: 10 ** 9 });
    expect(res?.term).toHaveLength(120);
    expect(res?.resultCount).toBe(100000);
    expect(sanitizeSearchLogInput({ term: "abc", resultCount: -5 })?.resultCount).toBe(0);
  });

  it("drops everything but term/resultCount (no user smuggling)", () => {
    const res = sanitizeSearchLogInput({
      term: "abc",
      resultCount: 1,
      user: 7,
      author: { id: 1 },
    } as any);
    expect(res).toEqual({ term: "abc", resultCount: 1 });
    expect(Object.keys(res!)).toEqual(["term", "resultCount"]);
  });

  it.each([
    [null],
    ["string"],
    [{ term: 42, resultCount: 1 }],
    [{ term: "a", resultCount: 1 }], // < 2 chars after trim
    [{ term: "  ", resultCount: 1 }],
    [{ term: "abc", resultCount: "NaNish" }],
    [{ term: "abc" }],
  ])("rejects invalid input %#", (body) => {
    expect(sanitizeSearchLogInput(body as any)).toBeNull();
  });
});
