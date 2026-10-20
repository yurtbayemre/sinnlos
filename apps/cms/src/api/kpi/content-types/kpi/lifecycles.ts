import { isKpiPeriod, validateKpiValues } from "@sinnlos/domain";
import { errors } from "@strapi/utils";

import { parseAdminJsonField } from "../../../../utils/json-field";

/**
 * Server-side validation of a KPI's values (v0.19) for EVERY writer, like
 * the duty plans (api/duty-plan/content-types/duty-plan/lifecycles.ts):
 * only a payload that carries `values` is checked; admin JSON input is
 * parsed first; a cleared field is stored as null (no values); the sorted
 * value replaces the input. With a `period` in the same payload (the admin
 * panel, publish) every key must start such a period; the authoring
 * allowlist checks that against the stored period too.
 */
interface KpiLifecycleEvent {
  params?: { data?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidKpi(event: KpiLifecycleEvent): void {
  const data = event?.params?.data;
  if (!isRecord(data) || !("values" in data) || data.values === undefined) return;
  const parsed = parseAdminJsonField(data.values);
  if (!parsed.ok) throw new errors.ValidationError("values: not valid JSON");
  if (parsed.value === null) {
    data.values = null;
    return;
  }
  const result = validateKpiValues(
    parsed.value,
    isKpiPeriod(data.period) ? data.period : undefined,
  );
  if ("error" in result) throw new errors.ValidationError(result.error);
  data.values = result.values;
}

export default {
  beforeCreate: assertValidKpi,
  beforeUpdate: assertValidKpi,
};
