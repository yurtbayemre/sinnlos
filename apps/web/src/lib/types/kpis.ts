import type { KpiAggregation, KpiPeriod } from "@sinnlos/domain";

/** A published KPI as readers get it (v0.19, "Kennzahlen"). */
export interface Kpi {
  id: number;
  documentId?: string;
  name: string;
  unit?: string | null;
  description?: string | null;
  period?: KpiPeriod | null;
  aggregation?: KpiAggregation | null;
  values?: Record<string, number> | null;
  department?: { id: number; documentId?: string; name: string; slug: string } | null;
}
