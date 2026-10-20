import { isPlainDate } from "./plain-date.js";

/**
 * Department KPIs ("Kennzahlen", v0.19; owner decisions of 2026-10-20):
 * generic figures with a name, a unit, a rhythm (month, quarter or year)
 * and a roll-up (`sum`: how much in total; `last`: the latest level, e.g.
 * open orders). Values are entered by hand per period and stored as one
 * JSON object keyed by the period's first day ('YYYY-MM-DD'). A missing
 * period is unknown, never zero.
 *
 * One rule for every writer: the cms lifecycle checks the shape
 * (validateKpiValues without a period), the authoring allowlist also the
 * alignment of every key with the KPI's period (kpiValuesCode).
 */

export const KPI_PERIODS = ["month", "quarter", "year"] as const;
export type KpiPeriod = (typeof KPI_PERIODS)[number];

export const KPI_AGGREGATIONS = ["sum", "last"] as const;
export type KpiAggregation = (typeof KPI_AGGREGATIONS)[number];

/** Period start ('YYYY-MM-DD') → value. */
export type KpiValues = Record<string, number>;

/** Most stored values per KPI: fifty years of months. */
export const MAX_KPI_VALUES = 600;
/** Largest absolute value (beyond any warehouse figure, well inside a double's exact range). */
export const MAX_KPI_ABS = 1e12;
/** Periods the charts and the entry table show. */
export const KPI_WINDOW = 12;

export const isKpiPeriod = (value: unknown): value is KpiPeriod =>
  typeof value === "string" && (KPI_PERIODS as readonly string[]).includes(value);

export const isKpiAggregation = (value: unknown): value is KpiAggregation =>
  typeof value === "string" && (KPI_AGGREGATIONS as readonly string[]).includes(value);

const MONTHS_OF: Readonly<Record<KpiPeriod, number>> = { month: 1, quarter: 3, year: 12 };

/** The first day of the period `day` falls in. */
export function kpiPeriodStart(day: string, period: KpiPeriod): string {
  const [year, month] = day.split("-").map(Number) as [number, number];
  const first = period === "year" ? 1 : period === "quarter" ? month - ((month - 1) % 3) : month;
  return `${String(year).padStart(4, "0")}-${String(first).padStart(2, "0")}-01`;
}

/** The start of the period `count` periods after (or before, negative) `start`. */
export function addKpiPeriods(start: string, period: KpiPeriod, count: number): string {
  const [year, month] = start.split("-").map(Number) as [number, number];
  const index = year * 12 + (month - 1) + count * MONTHS_OF[period];
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
}

/** The `count` period starts up to and including the period of `today`, newest first. */
export function recentKpiPeriods(today: string, period: KpiPeriod, count = KPI_WINDOW): string[] {
  const current = kpiPeriodStart(today, period);
  return Array.from({ length: count }, (_, i) => addKpiPeriods(current, period, -i));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type KpiValuesResult = { values: KpiValues } | { error: string };

/**
 * The values: missing means none; an object of period starts to finite
 * numbers within ±MAX_KPI_ABS, at most MAX_KPI_VALUES of them, keys sorted.
 * With `period`, every key must be the first day of such a period.
 */
export function validateKpiValues(raw: unknown, period?: KpiPeriod): KpiValuesResult {
  if (raw == null) return { values: {} };
  if (!isRecord(raw))
    return { error: "values: a JSON object of period starts to numbers is required" };
  const keys = Object.keys(raw).sort();
  if (keys.length > MAX_KPI_VALUES) return { error: `values: at most ${MAX_KPI_VALUES} periods` };
  const values: KpiValues = {};
  for (const key of keys) {
    const value = raw[key];
    if (!isPlainDate(key)) return { error: `values: "${key}" is no calendar date YYYY-MM-DD` };
    if (period && kpiPeriodStart(key, period) !== key) {
      return { error: `values: "${key}" is not the first day of a ${period}` };
    }
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_KPI_ABS) {
      return { error: `values["${key}"]: a number within ±${MAX_KPI_ABS} is required` };
    }
    values[key] = value;
  }
  return { values };
}

/** The field code of refused values (with `period`: also misaligned keys), or null. */
export function kpiValuesCode(raw: unknown, period?: KpiPeriod): "invalid" | null {
  return "error" in validateKpiValues(raw, period) ? "invalid" : null;
}

export interface KpiSummary {
  /** The latest reported period up to today, or null without any value. */
  latest: { period: string; value: number } | null;
  /** The period before `latest` and its value (null: not reported). */
  previous: { period: string; value: number | null } | null;
  /** Sum (or, for `last`, the latest value) over this year's periods up to today; null without one. */
  yearToDate: number | null;
  /** The last KPI_WINDOW periods up to today, oldest first; null where nothing was reported. */
  series: { period: string; value: number | null }[];
}

/** What the readers show of a KPI on calendar day `today`. */
export function kpiSummary(
  values: KpiValues,
  period: KpiPeriod,
  aggregation: KpiAggregation,
  today: string,
): KpiSummary {
  const current = kpiPeriodStart(today, period);
  const reported = Object.keys(values)
    .filter((key) => key <= current)
    .sort();
  const latestKey = reported[reported.length - 1];
  const latest = latestKey === undefined ? null : { period: latestKey, value: values[latestKey]! };
  const previousKey = latestKey === undefined ? null : addKpiPeriods(latestKey, period, -1);
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const thisYear = reported.filter((key) => key >= yearStart);
  const yearToDate =
    thisYear.length === 0
      ? null
      : aggregation === "sum"
        ? thisYear.reduce((total, key) => total + values[key]!, 0)
        : values[thisYear[thisYear.length - 1]!]!;
  return {
    latest,
    previous:
      previousKey === null ? null : { period: previousKey, value: values[previousKey] ?? null },
    yearToDate,
    series: recentKpiPeriods(today, period)
      .reverse()
      .map((key) => ({ period: key, value: values[key] ?? null })),
  };
}
