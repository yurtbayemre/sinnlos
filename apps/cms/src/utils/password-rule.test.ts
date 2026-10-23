import { describe, expect, it } from "vitest";

import { passwordProblem } from "./password-rule";

describe("passwordProblem", () => {
  it("refuses short, long and common passwords", () => {
    expect(passwordProblem("short")).toBe("tooShort");
    expect(passwordProblem("x".repeat(73))).toBe("tooLong");
    expect(passwordProblem("password1234")).toBe("common");
    expect(passwordProblem("PassWord1234")).toBe("common");
    expect(passwordProblem("123456789012")).toBe("common");
    expect(passwordProblem("zzzzzzzzzzzzzz")).toBe("common");
  });

  it("accepts a long uncommon password", () => {
    expect(passwordProblem("Demo-Passwort-2026!")).toBeNull();
    expect(passwordProblem("correct horse battery")).toBeNull();
  });
});
