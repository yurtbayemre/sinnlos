import type { KpiPeriod } from "@sinnlos/domain";

/**
 * A KPI period's label from its first day (v0.19): "Oktober 2026" (short
 * "Okt. 26"), "Q4 2026" (short "Q4 26"), "2026". Calendar arithmetic only:
 * the start is a plain date, so the formatter runs in UTC.
 */
export function kpiPeriodLabel(
  start: string,
  period: KpiPeriod,
  locale: string,
  short = false,
): string {
  const [year, month] = start.split("-").map(Number) as [number, number];
  const yy = short ? String(year).slice(2) : String(year);
  if (period === "year") return String(year);
  if (period === "quarter") return `Q${Math.floor((month - 1) / 3) + 1} ${yy}`;
  return new Intl.DateTimeFormat(locale, {
    month: short ? "short" : "long",
    year: short ? "2-digit" : "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}
