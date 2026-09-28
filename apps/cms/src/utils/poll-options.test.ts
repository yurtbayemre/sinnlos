import { describe, expect, it } from "vitest";

import { MAX_POLL_OPTIONS, MIN_POLL_OPTIONS, validatePollOptions } from "./poll-options";

const ten = Array.from({ length: 10 }, (_, i) => `Answer ${i + 1}`);

describe("validatePollOptions (FX20)", () => {
  it("uses the web form's bounds", () => {
    expect(MIN_POLL_OPTIONS).toBe(2);
    expect(MAX_POLL_OPTIONS).toBe(10);
  });

  it.each<[string, unknown, string[]]>([
    ["two answers", ["Yes", "No"], ["Yes", "No"]],
    ["ten answers", ten, ten],
    ["trimmed answers", ["  Yes ", "\tNo\n"], ["Yes", "No"]],
    ["case-different answers", ["yes", "Yes"], ["yes", "Yes"]],
    ["non-ASCII answers", ["Ja – gern", "Nein 🙅"], ["Ja – gern", "Nein 🙅"]],
  ])("accepts %s", (_label, raw, expected) => {
    expect(validatePollOptions(raw)).toEqual({ options: expected });
  });

  it.each<[string, unknown, string]>([
    ["undefined", undefined, "2 to 10"],
    ["null", null, "2 to 10"],
    ["a string", "Yes,No", "2 to 10"],
    ["an object", { 0: "Yes", 1: "No" }, "2 to 10"],
    ["no answers", [], "2 to 10"],
    ["one answer", ["Only"], "2 to 10"],
    ["eleven answers", [...ten, "Answer 11"], "2 to 10"],
    ["an empty answer", ["Yes", ""], "options[1]: a non-empty text"],
    ["a whitespace answer", [" ", "No"], "options[0]: a non-empty text"],
    ["a number", ["Yes", 2], "options[1]: a non-empty text"],
    ["null inside", ["Yes", null], "options[1]: a non-empty text"],
    ["a nested array", [["Yes"], "No"], "options[0]: a non-empty text"],
    ["an object inside", [{ label: "Yes" }, "No"], "options[0]: a non-empty text"],
    ["a duplicate", ["Yes", "No", "Yes"], 'options[2]: "Yes" is already answer 1'],
    ["a duplicate after trimming", ["Yes", " Yes "], 'options[1]: "Yes" is already answer 1'],
  ])("refuses %s", (_label, raw, fragment) => {
    const result = validatePollOptions(raw);
    expect("error" in result && result.error).toContain(fragment);
  });

  it("is idempotent: normalised options validate to themselves", () => {
    const first = validatePollOptions([" A ", "B "]);
    if ("error" in first) throw new Error(first.error);
    expect(validatePollOptions(first.options)).toEqual(first);
  });
});
