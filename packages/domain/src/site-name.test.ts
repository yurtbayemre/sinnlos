import { describe, expect, it } from "vitest";
import { SITE_NAME_MAX_LENGTH, parseSiteName } from "./site-name.js";

describe("parseSiteName", () => {
  it("is null without a value", () => {
    expect(parseSiteName(undefined)).toEqual({ name: null, invalid: false });
    expect(parseSiteName("   ")).toEqual({ name: null, invalid: false });
  });

  it("trims a valid name", () => {
    expect(parseSiteName("  Musterfirma Intranet ")).toEqual({
      name: "Musterfirma Intranet",
      invalid: false,
    });
  });

  it("allows exactly the maximum length, counted in characters", () => {
    expect(parseSiteName("ä".repeat(SITE_NAME_MAX_LENGTH)).name).toBe("ä".repeat(40));
    expect(parseSiteName("x".repeat(SITE_NAME_MAX_LENGTH + 1))).toEqual({
      name: null,
      invalid: true,
    });
  });

  const ctl = (code: number) => String.fromCharCode(code);

  it.each([0x0a, 0x0d, 0x07, 0x7f, 0x85, 0x2028, 0x2029].map((code) => `Acme${ctl(code)}x`))(
    "refuses control characters (%j)",
    (value) => {
      expect(parseSiteName(value)).toEqual({ name: null, invalid: true });
    },
  );
});
