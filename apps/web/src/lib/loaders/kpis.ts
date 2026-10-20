import {
  isKpiAggregation,
  isKpiPeriod,
  kpiSummary,
  validateKpiValues,
  type KpiAggregation,
  type KpiPeriod,
  type KpiSummary,
} from "@sinnlos/domain";
import { appTimeZone } from "@/lib/app-time-zone";
import { zonedDateKey } from "@/lib/plain-date";
import { tryFetch } from "@/lib/safe-fetch";
import { api } from "@/lib/strapi";

/** One published KPI as the readers show it (v0.19). */
export interface KpiView {
  documentId: string;
  name: string;
  unit: string | null;
  description: string | null;
  period: KpiPeriod;
  aggregation: KpiAggregation;
  department: { name: string; slug: string } | null;
  /** Latest, previous, year to date and the last periods, as of today in APP_TIME_ZONE. */
  summary: KpiSummary;
}

export interface KpisView {
  kpis: KpiView[];
  /** The KPIs could not be read: say so, never "no KPIs". */
  failed: boolean;
  truncated: boolean;
}

/** The published KPIs with their summaries; values off the KPI's rhythm read as none. */
export async function loadKpis(now: Date = new Date()): Promise<KpisView> {
  const res = await tryFetch(() => api.kpis.list(), "kpis");
  if (res.failed || !res.data) return { kpis: [], failed: true, truncated: false };
  const today = zonedDateKey(now, appTimeZone());
  const kpis = res.data.data.map((row) => {
    const period = isKpiPeriod(row.period) ? row.period : "month";
    const aggregation = isKpiAggregation(row.aggregation) ? row.aggregation : "sum";
    const values = validateKpiValues(row.values ?? null, period);
    return {
      documentId: row.documentId ?? String(row.id),
      name: row.name,
      unit: row.unit || null,
      description: row.description || null,
      period,
      aggregation,
      department: row.department ? { name: row.department.name, slug: row.department.slug } : null,
      summary: kpiSummary("error" in values ? {} : values.values, period, aggregation, today),
    };
  });
  return { kpis, failed: false, truncated: res.data.truncated };
}
