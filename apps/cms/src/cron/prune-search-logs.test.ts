import { describe, expect, it } from "vitest";

import {
  DEFAULT_SEARCH_LOG_RETENTION_DAYS,
  MAX_SEARCH_LOG_RETENTION_DAYS,
  assertSearchLogRetention,
  searchLogRetentionDays,
} from "./prune-search-logs";

/**
 * SEARCH_LOG_RETENTION_DAYS (v0.28, M11): a whole number of days from 1 to
 * 3650, 90 when unset; anything else refuses the boot. The deletion itself
 * runs on a real SQLite in search-log-sqlite.test.ts.
 */

describe("searchLogRetentionDays", () => {
  it("defaults to 90 days when unset or blank", () => {
    expect(DEFAULT_SEARCH_LOG_RETENTION_DAYS).toBe(90);
    expect(searchLogRetentionDays(undefined)).toBe(90);
    expect(searchLogRetentionDays("")).toBe(90);
    expect(searchLogRetentionDays("  ")).toBe(90);
  });

  it("takes whole days from 1 to 3650, trimmed", () => {
    expect(MAX_SEARCH_LOG_RETENTION_DAYS).toBe(3650);
    expect(searchLogRetentionDays("1")).toBe(1);
    expect(searchLogRetentionDays(" 30 ")).toBe(30);
    expect(searchLogRetentionDays("3650")).toBe(3650);
  });

  it("refuses anything else", () => {
    for (const value of ["0", "3651", "-5", "1.5", "30d", "1e3", "ninety", "+30"]) {
      expect(searchLogRetentionDays(value), value).toBeNull();
    }
  });
});

describe("assertSearchLogRetention (boot)", () => {
  it("passes a valid or unset value", () => {
    expect(() => assertSearchLogRetention({})).not.toThrow();
    expect(() => assertSearchLogRetention({ SEARCH_LOG_RETENTION_DAYS: "180" })).not.toThrow();
  });

  it("refuses the boot on an invalid value, naming it", () => {
    expect(() => assertSearchLogRetention({ SEARCH_LOG_RETENTION_DAYS: "0" })).toThrow(
      '[search-log-janitor] SEARCH_LOG_RETENTION_DAYS="0" is not a whole number of days from 1 to 3650',
    );
  });
});
