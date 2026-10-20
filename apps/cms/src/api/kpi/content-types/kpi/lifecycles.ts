import { isKpiPeriod, validateKpiValues } from "@sinnlos/domain";
import { errors } from "@strapi/utils";

import { parseAdminJsonField } from "../../../../utils/json-field";

/**
 * Server-side validation of a KPI's values (v0.19) for EVERY writer, like
 * the duty plans (api/duty-plan/content-types/duty-plan/lifecycles.ts):
 * only a payload that carries `values` or `period` is checked; admin JSON
 * input is parsed first; a cleared field is stored as null (no values); the
 * sorted value replaces the input. Every key must start a period of the
 * KPI's rhythm as it will be stored: the payload over each row an update
 * matches (a partial admin update of `period` alone or `values` alone
 * included), the schema default `month` on a create without one. The
 * authoring allowlist checks the same (kpiCrossCheck).
 */
const KPI_UID = "api::kpi.kpi";

interface KpiLifecycleEvent {
  params?: { data?: unknown; where?: unknown };
}

interface StoredKpi {
  period?: unknown;
  values?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertValidKpi(event: KpiLifecycleEvent, update: boolean): Promise<void> {
  const data = event?.params?.data;
  if (!isRecord(data)) return;
  const carriesValues = "values" in data && data.values !== undefined;
  const carriesPeriod = "period" in data && data.period !== undefined;
  if (!carriesValues && !carriesPeriod) return;

  if (carriesValues) {
    const parsed = parseAdminJsonField(data.values);
    if (!parsed.ok) throw new errors.ValidationError("values: not valid JSON");
    if (parsed.value === null) {
      data.values = null;
    } else {
      const shape = validateKpiValues(parsed.value);
      if ("error" in shape) throw new errors.ValidationError(shape.error);
      data.values = shape.values;
    }
  }

  const where = event.params?.where;
  // Joins the write's transaction (the query engine reuses the ambient one).
  const rows: StoredKpi[] =
    update && where
      ? await strapi.db.query(KPI_UID).findMany({ where, select: ["period", "values"] })
      : [];
  for (const row of rows.length > 0 ? rows : [{}]) {
    const period = carriesPeriod ? data.period : row.period;
    const values = carriesValues ? data.values : row.values;
    if (values === null || values === undefined) continue;
    const aligned = validateKpiValues(values, isKpiPeriod(period) ? period : "month");
    if ("error" in aligned) throw new errors.ValidationError(aligned.error);
  }
}

export default {
  beforeCreate: (event: KpiLifecycleEvent) => assertValidKpi(event, false),
  beforeUpdate: (event: KpiLifecycleEvent) => assertValidKpi(event, true),
};
