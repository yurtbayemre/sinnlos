import { validateDutyShifts, validateDutyTemplates } from "@sinnlos/domain";
import { errors } from "@strapi/utils";

import { parseAdminJsonField } from "../../../../utils/json-field";

/**
 * Server-side validation of a duty plan's shift templates and shifts (v0.18)
 * for EVERY writer: the web's /manage form, direct content-API calls and
 * the admin panel. Rules in @sinnlos/domain duty.ts. Like the poll options
 * (api/poll/content-types/poll/lifecycles.ts):
 *  - only a payload that carries the field is checked;
 *  - admin JSON input arrives as editor text and is parsed first
 *    (utils/json-field.ts); a cleared field is stored as null (no shifts);
 *  - the normalised value replaces the input (instants as ISO-Z, shifts
 *    sorted by start), so publish, which re-creates the published row,
 *    validates the stored value to itself.
 */
interface DutyPlanLifecycleEvent {
  params?: { data?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalise(
  data: Record<string, unknown>,
  key: "shiftTemplates" | "shifts",
  validate: (raw: unknown) => { error: string } | Record<string, unknown>,
  resultKey: "templates" | "shifts",
): void {
  if (!(key in data) || data[key] === undefined) return;
  const parsed = parseAdminJsonField(data[key]);
  if (!parsed.ok) throw new errors.ValidationError(`${key}: not valid JSON`);
  if (parsed.value === null) {
    data[key] = null;
    return;
  }
  const result = validate(parsed.value);
  if ("error" in result && typeof result.error === "string") {
    throw new errors.ValidationError(result.error);
  }
  data[key] = result[resultKey];
}

function assertValidPlan(event: DutyPlanLifecycleEvent): void {
  const data = event?.params?.data;
  if (!isRecord(data)) return;
  normalise(data, "shiftTemplates", validateDutyTemplates, "templates");
  normalise(data, "shifts", validateDutyShifts, "shifts");
}

export default {
  beforeCreate: assertValidPlan,
  beforeUpdate: assertValidPlan,
};
