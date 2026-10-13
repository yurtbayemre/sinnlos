import { describe, expect, it } from "vitest";

import {
  MAX_MARKDOWN_LENGTH,
  MAX_ORDER,
  MAX_STRING_LENGTH,
  MIN_SCHEDULE_LEAD_MS,
  checkBoolean,
  checkEnum,
  checkIconKey,
  checkInstant,
  checkMarkdown,
  checkNullableInstant,
  checkNullableString,
  checkNullableWebUrl,
  checkOrder,
  checkPositiveIntOrNull,
  checkQuickLinkUrl,
  checkRequiredString,
  checkWebUrl,
  eventSpanCode,
  isInternalPath,
  isOffsetInstant,
  isWebUrl,
  offsetInstantMs,
  scheduleCodes,
} from "./validators.js";

/** The value checks of v2 authoring (decision 06 §B1.3), shared by the cms allowlist and the web. */

describe("strings and Markdown", () => {
  it("requiredString: non-blank, at most 255 characters", () => {
    expect(checkRequiredString("Hello")).toBeNull();
    expect(checkRequiredString("x".repeat(MAX_STRING_LENGTH))).toBeNull();
    expect(checkRequiredString("x".repeat(MAX_STRING_LENGTH + 1))).toBe("tooLong");
    expect(checkRequiredString("   ")).toBe("required");
    expect(checkRequiredString("")).toBe("required");
    expect(checkRequiredString(null)).toBe("required");
    expect(checkRequiredString(undefined)).toBe("required");
    expect(checkRequiredString(42)).toBe("invalid");
    expect(checkRequiredString(["a"])).toBe("invalid");
  });

  it("nullableString: null or at most 255 characters", () => {
    expect(checkNullableString(null)).toBeNull();
    expect(checkNullableString("")).toBeNull();
    expect(checkNullableString("x".repeat(256))).toBe("tooLong");
    expect(checkNullableString(1)).toBe("invalid");
    expect(checkNullableString(undefined)).toBe("invalid");
  });

  it("markdown: null or at most 200 000 characters", () => {
    expect(MAX_MARKDOWN_LENGTH).toBe(200_000);
    expect(checkMarkdown(null)).toBeNull();
    expect(checkMarkdown("# Title\n\n*x*")).toBeNull();
    expect(checkMarkdown("x".repeat(MAX_MARKDOWN_LENGTH))).toBeNull();
    expect(checkMarkdown("x".repeat(MAX_MARKDOWN_LENGTH + 1))).toBe("tooLong");
    expect(checkMarkdown({ type: "doc" })).toBe("invalid");
  });

  it("boolean: strict", () => {
    expect(checkBoolean(true)).toBeNull();
    expect(checkBoolean(false)).toBeNull();
    for (const value of ["true", 1, 0, null, undefined])
      expect(checkBoolean(value)).toBe("invalid");
  });
});

describe("instants (DT-OFFSETLESS)", () => {
  it("accepts Z and numeric offsets, with or without seconds and fractions", () => {
    for (const value of [
      "2026-10-01T07:00:00.000Z",
      "2026-10-01T07:00Z",
      "2026-10-01T09:00:00+02:00",
      "2026-10-01T09:00:00.123456-05:30",
    ]) {
      expect(isOffsetInstant(value), value).toBe(true);
      expect(checkInstant(value), value).toBeNull();
      expect(checkNullableInstant(value), value).toBeNull();
    }
    expect(offsetInstantMs("2026-10-01T09:00:00+02:00")).toBe(Date.parse("2026-10-01T07:00:00Z"));
  });

  it("refuses offset-less values, dates, garbage and impossible instants", () => {
    for (const value of [
      "2026-10-01T09:00:00",
      "2026-10-01",
      "2026-13-01T09:00:00Z",
      "yesterday",
      "",
      1_700_000_000_000,
      new Date("2026-10-01T07:00:00Z"),
    ]) {
      expect(isOffsetInstant(value), String(value)).toBe(false);
    }
    expect(checkInstant("2026-10-01T09:00:00")).toBe("invalidInstant");
    expect(checkInstant(null)).toBe("required");
    expect(checkInstant(undefined)).toBe("required");
    expect(checkNullableInstant(null)).toBeNull();
    expect(checkNullableInstant("2026-10-01")).toBe("invalidInstant");
    expect(offsetInstantMs("2026-10-01T09:00:00")).toBeNull();
  });
});

describe("URLs", () => {
  it("web URL: http(s), a host, no credentials, no control characters", () => {
    for (const value of ["https://example.com", "http://intranet.local/x?y=1#z"]) {
      expect(isWebUrl(value), value).toBe(true);
      expect(checkWebUrl(value), value).toBeNull();
    }
    for (const value of [
      "javascript:alert(1)",
      "ftp://example.com",
      "https://user:pass@example.com",
      "https://user@example.com",
      "//example.com",
      "/internal",
      "https://exa mple.com",
      "https://example.com/\tx",
      "https:\\\\example.com",
      `https://example.com/${"x".repeat(MAX_STRING_LENGTH)}`,
      "not a url",
    ]) {
      expect(isWebUrl(value), value).toBe(false);
      expect(checkWebUrl(value), value).toBe("invalidUrl");
    }
    expect(checkWebUrl("")).toBe("required");
    expect(checkNullableWebUrl(null)).toBeNull();
    expect(checkNullableWebUrl("mailto:x@example.com")).toBe("invalidUrl");
  });

  it("internal path: one leading slash, no protocol-relative or control characters (FX10)", () => {
    for (const value of ["/", "/wiki/hr", "/documents?category=policy", "/x#y"]) {
      expect(isInternalPath(value), value).toBe(true);
    }
    for (const value of ["//evil.example", "/\\evil.example", "/x\ty", "/x y", "wiki", "", 5]) {
      expect(isInternalPath(value), String(value)).toBe(false);
    }
  });

  it("quick-link url: a web URL or an internal path", () => {
    expect(checkQuickLinkUrl("https://payroll.example.com")).toBeNull();
    expect(checkQuickLinkUrl("/wiki/it")).toBeNull();
    expect(checkQuickLinkUrl("//evil.example")).toBe("invalidUrl");
    expect(checkQuickLinkUrl("javascript:alert(1)")).toBe("invalidUrl");
    expect(checkQuickLinkUrl(null)).toBe("required");
  });
});

describe("enums, icons and numbers", () => {
  it("enum: exactly one of the values", () => {
    const category = checkEnum(["hr", "it"]);
    expect(category("hr")).toBeNull();
    expect(category("HR")).toBe("invalid");
    expect(category(null)).toBe("invalid");
  });

  it("icon: an ICON_KEYS name or null", () => {
    expect(checkIconKey("Wallet")).toBeNull();
    expect(checkIconKey(null)).toBeNull();
    expect(checkIconKey("wallet")).toBe("invalid");
    expect(checkIconKey("constructor")).toBe("invalid");
  });

  it("order: an integer 0..10000", () => {
    expect(checkOrder(0)).toBeNull();
    expect(checkOrder(MAX_ORDER)).toBeNull();
    for (const value of [-1, MAX_ORDER + 1, 1.5, "3", null]) {
      expect(checkOrder(value), String(value)).toBe("invalid");
    }
  });

  it("positive integer or null (capacity)", () => {
    expect(checkPositiveIntOrNull(null)).toBeNull();
    expect(checkPositiveIntOrNull(1)).toBeNull();
    expect(checkPositiveIntOrNull(2_147_483_647)).toBeNull();
    for (const value of [0, -3, 2.5, 2_147_483_648, "5"]) {
      expect(checkPositiveIntOrNull(value), String(value)).toBe("invalid");
    }
  });
});

describe("cross-field checks", () => {
  const now = Date.parse("2026-10-13T10:00:00Z");
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();

  it("scheduleInPast: publishAt at least a minute ahead, when it changed", () => {
    expect(MIN_SCHEDULE_LEAD_MS).toBe(60_000);
    expect(scheduleCodes({ publishAt: at(1) }, now)).toEqual({});
    expect(scheduleCodes({ publishAt: at(0.5) }, now)).toEqual({ publishAt: "scheduleInPast" });
    expect(scheduleCodes({ publishAt: at(-60) }, now)).toEqual({ publishAt: "scheduleInPast" });
    expect(scheduleCodes({ publishAt: at(-60) }, now, { publishAtChanged: false })).toEqual({});
    expect(scheduleCodes({ publishAt: null }, now)).toEqual({});
  });

  it("unpublishAt and expiresAt after publishAt", () => {
    expect(scheduleCodes({ publishAt: at(10), unpublishAt: at(10) }, now)).toEqual({
      unpublishAt: "unpublishBeforePublish",
    });
    expect(scheduleCodes({ publishAt: at(10), unpublishAt: at(11) }, now)).toEqual({});
    expect(scheduleCodes({ publishAt: at(10), expiresAt: at(5) }, now)).toEqual({
      expiresAt: "expiresBeforePublish",
    });
    // No publishAt: nothing to compare (an unpublishAt alone is a plain withdrawal).
    expect(scheduleCodes({ unpublishAt: at(-5), expiresAt: at(-5) }, now)).toEqual({});
  });

  it("endBeforeStart", () => {
    expect(eventSpanCode(at(10), at(9))).toBe("endBeforeStart");
    expect(eventSpanCode(at(10), at(10))).toBeNull();
    expect(eventSpanCode(at(10), null)).toBeNull();
  });
});
