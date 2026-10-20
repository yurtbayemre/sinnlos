import { describe, expect, it } from "vitest";
import {
  MAX_KPI_VALUES,
  addKpiPeriods,
  kpiPeriodStart,
  kpiSummary,
  kpiValuesCode,
  recentKpiPeriods,
  validateKpiValues,
} from "./kpi.js";

describe("KPI periods", () => {
  it("finds the first day of a month, quarter and year", () => {
    expect(kpiPeriodStart("2026-10-20", "month")).toBe("2026-10-01");
    expect(kpiPeriodStart("2026-10-20", "quarter")).toBe("2026-10-01");
    expect(kpiPeriodStart("2026-08-31", "quarter")).toBe("2026-07-01");
    expect(kpiPeriodStart("2026-02-28", "year")).toBe("2026-01-01");
  });

  it("steps whole periods across year ends", () => {
    expect(addKpiPeriods("2026-01-01", "month", -1)).toBe("2025-12-01");
    expect(addKpiPeriods("2026-10-01", "quarter", 1)).toBe("2027-01-01");
    expect(addKpiPeriods("2026-01-01", "year", -3)).toBe("2023-01-01");
    expect(recentKpiPeriods("2026-02-15", "month", 3)).toEqual([
      "2026-02-01",
      "2026-01-01",
      "2025-12-01",
    ]);
  });
});

describe("validateKpiValues", () => {
  it("accepts none, sorts the keys and checks the alignment with the period", () => {
    expect(validateKpiValues(null)).toEqual({ values: {} });
    expect(validateKpiValues({ "2026-10-01": 5, "2026-09-01": 4.5 }, "month")).toEqual({
      values: { "2026-09-01": 4.5, "2026-10-01": 5 },
    });
    expect(kpiValuesCode({ "2026-08-01": 1 }, "quarter")).toBe("invalid");
    expect(kpiValuesCode({ "2026-07-01": 1 }, "quarter")).toBeNull();
  });

  it("refuses a non-date key, a non-number, an infinite or a huge value and too many periods", () => {
    for (const raw of [
      { "2026-13-01": 1 },
      { "2026-10-01": "5" },
      { "2026-10-01": Number.POSITIVE_INFINITY },
      { "2026-10-01": 2e12 },
      ["2026-10-01"],
      Object.fromEntries(
        Array.from({ length: MAX_KPI_VALUES + 1 }, (_, i) => [
          addKpiPeriods("1900-01-01", "month", i),
          1,
        ]),
      ),
    ]) {
      expect(validateKpiValues(raw), JSON.stringify(raw).slice(0, 40)).toHaveProperty("error");
    }
  });
});

describe("kpiSummary", () => {
  const values = { "2025-11-01": 900, "2026-08-01": 1100, "2026-09-01": 1180 };

  it("shows the latest reported period, the one before and the year so far", () => {
    const summary = kpiSummary(values, "month", "sum", "2026-10-20");
    expect(summary.latest).toEqual({ period: "2026-09-01", value: 1180 });
    expect(summary.previous).toEqual({ period: "2026-08-01", value: 1100 });
    expect(summary.yearToDate).toBe(2280);
    expect(summary.series).toHaveLength(12);
    // October is still open and unreported: the bars end with September.
    expect(summary.series[0]).toEqual({ period: "2025-10-01", value: null });
    expect(summary.series[1]).toEqual({ period: "2025-11-01", value: 900 });
    expect(summary.series.at(-1)).toEqual({ period: "2026-09-01", value: 1180 });
    const reported = kpiSummary({ ...values, "2026-10-01": 50 }, "month", "sum", "2026-10-20");
    expect(reported.series.at(-1)).toEqual({ period: "2026-10-01", value: 50 });
  });

  it("takes the latest level for `last`, and knows nothing without values", () => {
    expect(kpiSummary(values, "month", "last", "2026-10-20").yearToDate).toBe(1180);
    expect(kpiSummary({}, "quarter", "sum", "2026-10-20")).toMatchObject({
      latest: null,
      previous: null,
      yearToDate: null,
    });
  });

  it("ignores a period in the future", () => {
    expect(kpiSummary({ "2026-11-01": 5 }, "month", "sum", "2026-10-20").latest).toBeNull();
  });
});
