import { errors } from "@strapi/utils";

import { parseAdminJsonField } from "../../../../utils/json-field";
import { validatePollOptions } from "../../../../utils/poll-options";

/**
 * Server-side validation of poll answer options (FX20) for EVERY writer:
 * the web's createPoll, direct content-API calls and the admin panel, where
 * editors author polls and where no content-API controller runs. Rules in
 * utils/poll-options.ts (2 to 10 unique, trimmed, non-empty texts).
 *
 *  - Keys present: only a payload that carries `options` is checked, so a
 *    db.query update of other fields (the audience guard, the department
 *    delete cascade) passes untouched.
 *  - Admin JSON input: an edited field arrives as the raw editor text, a
 *    cleared one as '' or null (utils/json-field.ts). The text is parsed;
 *    the normalised array replaces it in `event.params.data.options`.
 *  - A cleared (null) value is left to Strapi's own `required` rule, which
 *    draft & publish applies on publish only, so a draft may be saved
 *    before its answers are filled in.
 *  - Idempotent: publish re-creates the published row, so beforeCreate runs
 *    again with the stored array, which validates to itself.
 *
 * errors.ValidationError answers 400 on the content API and shows the
 * message in the admin panel. Registered by file convention; nothing in
 * src/index.ts. The audience flag has its own write-time guard
 * (utils/poll-audience-guard.ts), untouched here.
 */
interface PollLifecycleEvent {
  params?: { data?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidOptions(event: PollLifecycleEvent): void {
  const data = event?.params?.data;
  if (!isRecord(data) || !("options" in data) || data.options === undefined) return;
  const parsed = parseAdminJsonField(data.options);
  if (!parsed.ok) throw new errors.ValidationError("options: not valid JSON");
  if (parsed.value === null) {
    data.options = null;
    return;
  }
  const result = validatePollOptions(parsed.value);
  if ("error" in result) throw new errors.ValidationError(result.error);
  data.options = result.options;
}

export default {
  beforeCreate: assertValidOptions,
  beforeUpdate: assertValidOptions,
};
