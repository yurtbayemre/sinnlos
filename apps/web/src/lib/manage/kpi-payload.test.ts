import { describe, expect, it } from "vitest";
import { kpiPeriodLabel } from "@/lib/kpi-format";
import { buildKpiPayload, kpiNumbers, parseKpiNumber, type PayloadContext } from "./payload";
import { coerceKpiValues, emptyKpiValues, type KpiValues } from "./values";

/**
 * The KPI payload (v0.19): values are typed as text and travel as numbers
 * by period start; "5" and "5,0" are no change; a blank entry is no value;
 * an unreadable one or a key off the rhythm is refused on `values`.
 */
const ENG = "deptengineering000000000";

const ctx = (overrides: Partial<PayloadContext> = {}): PayloadContext => ({
  mode: "update",
  roleClass: "departmentAuthor",
  timeZone: "Europe/Berlin",
  now: Date.parse("2026-10-20T10:00:00.000Z"),
  ownDepartment: ENG,
  ...overrides,
});

const kpi = (patch: Partial<KpiValues> = {}): KpiValues => ({
  ...emptyKpiValues(ENG),
  name: "Verladene Kubikmeter",
  unit: "m³",
  values: { "2026-08-01": "1250,5", "2026-09-01": "1300" },
  ...patch,
});

describe("parseKpiNumber", () => {
  it("reads a decimal comma or point, a sign, and blank as no value", () => {
    expect(parseKpiNumber("1250,5")).toBe(1250.5);
    expect(parseKpiNumber(" 1250.5 ")).toBe(1250.5);
    expect(parseKpiNumber("-3")).toBe(-3);
    expect(parseKpiNumber("  ")).toBeUndefined();
    for (const bad of ["1.250,5", "1 250", "12a", "1e5", ",5", "5,"]) {
      expect(parseKpiNumber(bad), bad).toBeNull();
    }
  });

  it("drops blank entries and refuses the whole set on one unreadable entry", () => {
    expect(kpiNumbers({ "2026-02-01": "2", "2026-01-01": "1", "2026-03-01": "" })).toEqual({
      "2026-01-01": 1,
      "2026-02-01": 2,
    });
    expect(kpiNumbers({ "2026-01-01": "x" })).toBeNull();
  });
});

describe("buildKpiPayload", () => {
  it("sends every field on create with the values as numbers", () => {
    expect(buildKpiPayload(kpi(), null, ctx({ mode: "create" }))).toEqual({
      ok: true,
      data: {
        name: "Verladene Kubikmeter",
        unit: "m³",
        description: null,
        department: ENG,
        period: "month",
        aggregation: "sum",
        values: { "2026-08-01": 1250.5, "2026-09-01": 1300 },
      },
    });
  });

  it("sees no change in a differently written same number, and sends a changed one", () => {
    const initial = kpi();
    const same = kpi({ values: { "2026-08-01": "1250.50", "2026-09-01": "1300,0" } });
    expect(buildKpiPayload(same, initial, ctx())).toEqual({ ok: true, data: {} });
    const typed = kpi({ values: { ...initial.values, "2026-10-01": "7" } });
    expect(buildKpiPayload(typed, initial, ctx())).toEqual({
      ok: true,
      data: { values: { "2026-08-01": 1250.5, "2026-09-01": 1300, "2026-10-01": 7 } },
    });
  });

  it("refuses an unreadable value and a key off the rhythm on `values`", () => {
    const initial = kpi();
    expect(buildKpiPayload(kpi({ values: { "2026-08-01": "1.250,5" } }), initial, ctx())).toEqual({
      ok: false,
      fields: { values: "invalid" },
    });
    const quarterly = kpi({ period: "quarter", values: { "2026-08-01": "5" } });
    expect(buildKpiPayload(quarterly, null, ctx({ mode: "create" }))).toEqual({
      ok: false,
      fields: { values: "invalid" },
    });
  });

  it("coerces only string entries from the client", () => {
    const coerced = coerceKpiValues({
      name: "x",
      period: "week",
      values: { "2026-01-01": "1", "2026-02-01": 2 },
    });
    expect(coerced.period).toBe("month");
    expect(coerced.values).toEqual({ "2026-01-01": "1" });
  });
});

describe("kpiPeriodLabel", () => {
  it("names months, quarters and years", () => {
    expect(kpiPeriodLabel("2026-10-01", "month", "de")).toBe("Oktober 2026");
    expect(kpiPeriodLabel("2026-10-01", "quarter", "de")).toBe("Q4 2026");
    expect(kpiPeriodLabel("2026-10-01", "quarter", "de", true)).toBe("Q4 26");
    expect(kpiPeriodLabel("2026-01-01", "year", "en")).toBe("2026");
  });
});
