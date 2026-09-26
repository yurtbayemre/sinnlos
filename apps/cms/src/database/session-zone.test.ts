import { describe, expect, it } from "vitest";

import { assertDatabaseUrlKeepsUtcSession, databaseUrlOptions, timeZoneFromPgOptions } from "./session-zone";

describe("session-zone", () => {
  it("reads the options query parameter the way pg-connection-string does", () => {
    expect(databaseUrlOptions("postgres://u:p@db:5432/x")).toBeNull();
    expect(databaseUrlOptions("postgres://u:p@db/x?sslmode=require")).toBeNull();
    expect(databaseUrlOptions("postgres://u:p@db/x?options=-c%20TimeZone%3DUTC")).toBe("-c TimeZone=UTC");
    expect(databaseUrlOptions("postgres://u:p@db/x?options=-c+TimeZone%3DUTC")).toBe("-c TimeZone=UTC");
  });

  it("finds the last TimeZone setting in -c and -- forms", () => {
    expect(timeZoneFromPgOptions("-c TimeZone=UTC")).toBe("UTC");
    expect(timeZoneFromPgOptions("--timezone=Etc/UTC")).toBe("Etc/UTC");
    expect(timeZoneFromPgOptions("-c TimeZone=UTC -c timezone=Europe/Berlin")).toBe("Europe/Berlin");
    expect(timeZoneFromPgOptions("-cTimeZone=UTC")).toBe("UTC");
    expect(timeZoneFromPgOptions("-c search_path=app")).toBeNull();
  });

  it("refuses only URLs whose options drop the UTC pin", () => {
    expect(() => assertDatabaseUrlKeepsUtcSession(undefined)).not.toThrow();
    expect(() => assertDatabaseUrlKeepsUtcSession("")).not.toThrow();
    expect(() => assertDatabaseUrlKeepsUtcSession("postgres://u:p@db/x")).not.toThrow();
    expect(() => assertDatabaseUrlKeepsUtcSession("postgres://u:p@db/x?options=")).toThrow(/options/);
    expect(() =>
      assertDatabaseUrlKeepsUtcSession("postgres://u:p@db/x?options=-c%20TimeZone%3DUTC%20-c%20TimeZone%3DCET"),
    ).toThrow();
    expect(() => assertDatabaseUrlKeepsUtcSession("postgres://u:p@db/x?options=--TimeZone%3Dutc")).not.toThrow();
  });
});
