import { describe, expect, it } from "vitest";

import { PASSWORD_MIN_LENGTH, passwordLengthProblem } from "./password.js";

describe("passwordLengthProblem", () => {
  it("needs 12 characters, counted as code points", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(passwordLengthProblem("a".repeat(11))).toBe("tooShort");
    expect(passwordLengthProblem("a".repeat(12))).toBeNull();
    // 11 emoji are 22 UTF-16 units but 11 characters.
    expect(passwordLengthProblem("😀".repeat(11))).toBe("tooShort");
  });

  it("refuses more than 72 bytes (bcrypt)", () => {
    expect(passwordLengthProblem("a".repeat(72))).toBeNull();
    expect(passwordLengthProblem("a".repeat(73))).toBe("tooLong");
    // 19 four-byte characters are 76 bytes.
    expect(passwordLengthProblem("😀".repeat(19))).toBe("tooLong");
  });
});
