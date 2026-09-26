import { describe, expect, it } from "vitest";

import {
  checkGap,
  classifyCell,
  columnKind,
  naiveUtcOf,
  readLegacySettings,
  repairColumns,
  type CellInput,
  type LegacySettings,
} from "./datetime-legacy";

/**
 * The pure half of the one-time legacy repair: settings, the per-cell rule
 * table and the gap check. The SQL half runs against a real Postgres in
 * datetime-legacy.pg.test.ts.
 *
 * Owner scenario: the cms ran in UTC until the TZ switch on 2026-08-15 and in
 * Europe/Berlin after it; θ = 2026-08-15T21:46:42+02:00 = 19:46:42 UTC.
 */
const OWNER: LegacySettings = readLegacySettings({
  DATETIME_LEGACY_ZONE: "Europe/Berlin",
  DATETIME_LEGACY_UTC_UNTIL: "2026-08-15T21:46:42+02:00",
});
const WHOLE_DB_LEGACY: LegacySettings = readLegacySettings({ DATETIME_LEGACY_ZONE: "Europe/Berlin" });

const PRE = "2026-07-01T09:00:00.000000"; // UTC wall clock, before the switch
const POST = "2026-09-01T12:00:00.000000"; // Berlin wall clock, after it

const cell = (overrides: Partial<CellInput>): CellInput => ({
  kind: "write",
  naive: PRE,
  rowCreatedAt: PRE,
  rowUpdatedAt: PRE,
  documentCreatedAt: PRE,
  allDay: false,
  ...overrides,
});

describe("readLegacySettings", () => {
  it("parses θ as a naive UTC wall clock", () => {
    expect(OWNER.zone).toBe("Europe/Berlin");
    expect(OWNER.theta).toEqual({ iso: "2026-08-15T19:46:42.000Z", naive: "2026-08-15T19:46:42.000000" });
    expect(naiveUtcOf("2026-08-15T21:46:42+02:00")).toBe("2026-08-15T19:46:42.000000");
  });

  it("treats both unset as a fresh install and UTC_UNTIL unset as a fully legacy database", () => {
    expect(readLegacySettings({})).toEqual({ zone: null, theta: null });
    expect(WHOLE_DB_LEGACY).toEqual({ zone: "Europe/Berlin", theta: null });
  });

  it("refuses unknown zones, offset-less θ and θ without a zone", () => {
    expect(() => readLegacySettings({ DATETIME_LEGACY_ZONE: "Berlin" })).toThrow(/DATETIME_LEGACY_ZONE/);
    // Intl reads '+02:00' as UTC+2, Postgres' AT TIME ZONE as UTC-2: refused.
    expect(() => readLegacySettings({ DATETIME_LEGACY_ZONE: "+02:00" })).toThrow(/DATETIME_LEGACY_ZONE.*UTC offset/);
    // A wrong-case name is passed on in its canonical spelling.
    expect(readLegacySettings({ DATETIME_LEGACY_ZONE: "europe/berlin" }).zone).toBe("Europe/Berlin");
    expect(() =>
      readLegacySettings({ DATETIME_LEGACY_ZONE: "Europe/Berlin", DATETIME_LEGACY_UTC_UNTIL: "2026-08-15T21:46:42" }),
    ).toThrow(/DATETIME_LEGACY_UTC_UNTIL/);
    expect(() => readLegacySettings({ DATETIME_LEGACY_UTC_UNTIL: "2026-08-15T19:46:42Z" })).toThrow(
      /needs DATETIME_LEGACY_ZONE/,
    );
  });
});

describe("columnKind", () => {
  const withCreatedAt = new Set(["id", "created_at", "expires_at"]);
  it("knows the user-entered instants", () => {
    expect(columnKind("events", "start", withCreatedAt)).toBe("user");
    expect(columnKind("events", "end", withCreatedAt)).toBe("user");
    expect(columnKind("polls", "closes_at", withCreatedAt)).toBe("user");
    expect(columnKind("announcements", "expires_at", withCreatedAt)).toBe("user");
    expect(columnKind("strapi_releases", "scheduled_at", withCreatedAt)).toBe("user");
  });

  it("classifies session and token expiries by created_at", () => {
    expect(columnKind("strapi_sessions", "expires_at", withCreatedAt)).toBe("expiry");
    expect(columnKind("strapi_sessions", "absolute_expires_at", withCreatedAt)).toBe("expiry");
    expect(columnKind("strapi_api_tokens", "expires_at", withCreatedAt)).toBe("expiry");
    // Without a created_at there is nothing better than the value itself.
    expect(columnKind("strapi_api_tokens", "expires_at", new Set(["id"]))).toBe("write");
  });

  it("treats everything else as a write-time stamp", () => {
    for (const [table, column] of [
      ["events", "created_at"],
      ["up_users", "last_digest_at"],
      ["notifications", "read_at"],
      ["search_logs", "created_at"],
      ["strapi_api_tokens", "last_used_at"],
    ]) {
      expect(columnKind(table, column, withCreatedAt), `${table}.${column}`).toBe("write");
    }
  });
});

describe("classifyCell", () => {
  it("write-time stamps go by their own value", () => {
    expect(classifyCell(cell({ naive: PRE }), OWNER)).toEqual({ cls: "write-utc", legacy: false });
    expect(classifyCell(cell({ naive: POST }), OWNER)).toEqual({ cls: "write-legacy", legacy: true });
    // θ itself is already the legacy side.
    expect(classifyCell(cell({ naive: "2026-08-15T19:46:42.000000" }), OWNER).legacy).toBe(true);
  });

  it("expiries go by the row's created_at, not by their own (future) value", () => {
    const longLived = "2026-09-14T09:00:00.000000";
    expect(classifyCell(cell({ kind: "expiry", naive: longLived, rowCreatedAt: PRE }), OWNER)).toEqual({
      cls: "expiry-utc",
      legacy: false,
    });
    expect(classifyCell(cell({ kind: "expiry", naive: longLived, rowCreatedAt: POST }), OWNER)).toEqual({
      cls: "expiry-legacy",
      legacy: true,
    });
  });

  it("class A: a document created after θ is in the legacy zone", () => {
    expect(
      classifyCell(
        cell({ kind: "user", naive: "2026-11-05T18:00:00.000000", rowCreatedAt: POST, documentCreatedAt: POST }),
        OWNER,
      ),
    ).toEqual({ cls: "A", legacy: true });
  });

  it("class A uses the document's first row: a re-published twin created after θ stays UTC", () => {
    // Publish re-creates the published row after θ, but the document (its
    // draft) dates from before θ and was not touched since.
    expect(
      classifyCell(
        cell({ kind: "user", rowCreatedAt: POST, documentCreatedAt: PRE, rowUpdatedAt: PRE }),
        OWNER,
      ).cls,
    ).toBe("B");
  });

  it("class B: a row last updated before θ is UTC", () => {
    expect(classifyCell(cell({ kind: "user", rowUpdatedAt: PRE }), OWNER)).toEqual({ cls: "B", legacy: false });
  });

  it("class C: created before, re-saved after θ defaults to UTC", () => {
    expect(classifyCell(cell({ kind: "user", naive: "2026-10-10T08:00:00.000000", rowUpdatedAt: POST }), OWNER)).toEqual({
      cls: "C",
      legacy: false,
    });
  });

  it("class C all-day: a local midnight in the legacy reading is the legacy zone", () => {
    const corrected = cell({ kind: "user", naive: "2026-10-01T00:00:00.000000", rowUpdatedAt: POST, allDay: true });
    expect(classifyCell(corrected, OWNER)).toEqual({ cls: "C-allday", legacy: true });
    // The uncorrected UTC value of a Berlin midnight (22:00) stays UTC.
    const kept = cell({ kind: "user", naive: "2026-09-30T22:00:00.000000", rowUpdatedAt: POST, allDay: true });
    expect(classifyCell(kept, OWNER)).toEqual({ cls: "C", legacy: false });
    // Timed events never take the all-day exception.
    expect(classifyCell({ ...corrected, allDay: false }, OWNER).cls).toBe("C");
  });

  it("without θ every value is in the legacy zone", () => {
    for (const kind of ["write", "expiry", "user"] as const) {
      expect(classifyCell(cell({ kind }), WHOLE_DB_LEGACY)).toEqual({ cls: "legacy-all", legacy: true });
    }
  });

  it("leaves values it cannot read alone", () => {
    expect(classifyCell(cell({ naive: "" }), OWNER)).toEqual({ cls: "unreadable", legacy: false });
  });
});

describe("checkGap", () => {
  const stamps = (values: string[]) => values.map((naive, index) => ({ naive, where: `t.c#${index}` }));

  it("accepts θ inside the empty stretch the switch left (>= 120 min in August)", () => {
    // Last UTC write 18:40, first Berlin write 20:50 (real 18:50 UTC).
    const gap = checkGap(
      stamps(["2026-08-15T10:00:00.000000", "2026-08-15T18:40:00.000000", "2026-08-15T20:50:00.000000"]),
      OWNER,
    );
    expect(gap).toMatchObject({ ok: true, requiredMinutes: 120, gapMinutes: 130 });
    expect(gap?.before?.naive).toBe("2026-08-15T18:40:00.000000");
    expect(gap?.after?.naive).toBe("2026-08-15T20:50:00.000000");
  });

  it("rejects θ in a stretch shorter than the zone offset (a wrong θ)", () => {
    const gap = checkGap(stamps(["2026-08-15T19:30:00.000000", "2026-08-15T20:00:00.000000"]), OWNER);
    expect(gap).toMatchObject({ ok: false, gapMinutes: 30 });
  });

  it("passes when all stamps lie on one side of θ, and is skipped without θ", () => {
    expect(checkGap(stamps(["2026-06-01T00:00:00.000000"]), OWNER)?.ok).toBe(true);
    expect(checkGap(stamps(["2026-06-01T00:00:00.000000"]), WHOLE_DB_LEGACY)).toBeNull();
  });
});

describe("repairColumns", () => {
  it("leaves Strapi's bookkeeping tables and the audit table to the guard", () => {
    const columns = repairColumns([
      { table: "events", column: "start" },
      { table: "strapi_migrations", column: "time" },
      { table: "strapi_migrations_internal", column: "time" },
      { table: "strapi_database_schema", column: "time" },
      { table: "datetime_migration_audit", column: "migrated_at" },
    ]);
    expect(columns).toEqual([{ table: "events", column: "start" }]);
  });
});
