import { describe, expect, it } from "vitest";

import * as domain from "@sinnlos/domain";

import {
  MAX_POLL_OPTIONS,
  MAX_POLL_OPTION_LENGTH,
  MIN_POLL_OPTIONS,
  validatePollOptions,
} from "./poll-options";

const ten = Array.from({ length: 10 }, (_, i) => `Answer ${i + 1}`);
const twenty = Array.from({ length: 20 }, (_, i) => `Answer ${i + 1}`);

describe("validatePollOptions (FX20)", () => {
  it("uses the shared bounds of @sinnlos/domain (2 to 20; batch 15 plan item 2b)", () => {
    expect(MIN_POLL_OPTIONS).toBe(2);
    expect(MAX_POLL_OPTIONS).toBe(20);
    expect(MAX_POLL_OPTION_LENGTH).toBe(200);
    expect(validatePollOptions).toBe(domain.validatePollOptions);
  });

  it.each<[string, unknown, string[]]>([
    ["two answers", ["Yes", "No"], ["Yes", "No"]],
    ["ten answers", ten, ten],
    ["eleven answers", [...ten, "Answer 11"], [...ten, "Answer 11"]],
    ["twenty answers", twenty, twenty],
    [
      "an answer of 201 characters (the lifecycle has no length limit)",
      ["x".repeat(201), "No"],
      ["x".repeat(201), "No"],
    ],
    ["trimmed answers", ["  Yes ", "\tNo\n"], ["Yes", "No"]],
    ["case-different answers", ["yes", "Yes"], ["yes", "Yes"]],
    ["non-ASCII answers", ["Ja – gern", "Nein 🙅"], ["Ja – gern", "Nein 🙅"]],
  ])("accepts %s", (_label, raw, expected) => {
    expect(validatePollOptions(raw)).toEqual({ options: expected });
  });

  it.each<[string, unknown, string]>([
    ["undefined", undefined, "2 to 20"],
    ["null", null, "2 to 20"],
    ["a string", "Yes,No", "2 to 20"],
    ["an object", { 0: "Yes", 1: "No" }, "2 to 20"],
    ["no answers", [], "2 to 20"],
    ["one answer", ["Only"], "2 to 20"],
    ["twenty-one answers", [...twenty, "Answer 21"], "2 to 20"],
    ["an empty answer", ["Yes", ""], "options[1]: a non-empty text"],
    ["a whitespace answer", [" ", "No"], "options[0]: a non-empty text"],
    ["a number", ["Yes", 2], "options[1]: a non-empty text"],
    ["null inside", ["Yes", null], "options[1]: a non-empty text"],
    ["a nested array", [["Yes"], "No"], "options[0]: a non-empty text"],
    ["an object inside", [{ label: "Yes" }, "No"], "options[0]: a non-empty text"],
    ["a duplicate", ["Yes", "No", "Yes"], 'options[2]: "Yes" repeats options[0]'],
    ["a later duplicate", ["No", "Yes", "Yes"], 'options[2]: "Yes" repeats options[1]'],
    ["a duplicate after trimming", ["Yes", " Yes "], 'options[1]: "Yes" repeats options[0]'],
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
