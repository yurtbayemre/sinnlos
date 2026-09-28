import { errors } from "@strapi/utils";

import { validateLessonData } from "../../../../utils/training-validation";

/**
 * The repo's FIRST validating beforeCreate/beforeUpdate lifecycle
 * (issue #29): lessons are authored in the Strapi admin panel, whose
 * writes bypass every content-api controller override — a lifecycle is
 * the only chokepoint that sees admin writes (proof: the live-events
 * subscriber fires on admin announcement publishes).
 *
 * Landmines handled (documented in the announcement/event lifecycles):
 *  - Publish = delete + recreate → beforeCreate fires again on EVERY
 *    re-publish with the full recreate payload. Validation is pure and
 *    idempotent, so re-validating already-valid content is a no-op, and
 *    the normalised quiz written back below validates to itself.
 *  - Keys present: the Content Manager submits the WHOLE form on save and
 *    publish, but db.query and script writers send partial payloads, so
 *    validateLessonData checks strictly `field in data` (§ mirror of the
 *    `"body" in data` guard in wiki-page/lifecycles.ts). A missing key is
 *    never written.
 *  - JSON fields from the admin panel (FX08): an edited quiz arrives as the
 *    raw editor text and a cleared one as '' (utils/json-field.ts). The
 *    normalised value (the validated array, or null) replaces it in
 *    `event.params.data.quiz`, so the database never stores the text.
 *
 * ApplicationError surfaces as a readable message in the admin panel
 * (a plain throw would be a 500). The web player's render gate stays
 * the authoritative XSS layer regardless (mirror-pair rule, see
 * utils/training-validation.ts).
 */
interface LessonLifecycleEvent {
  params?: { data?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValid(event: LessonLifecycleEvent): void {
  const data = event?.params?.data;
  if (!isRecord(data)) return;
  const result = validateLessonData(data);
  if ("error" in result) throw new errors.ApplicationError(result.error);
  if ("quiz" in result.normalized) data.quiz = result.normalized.quiz;
}

export default {
  beforeCreate: assertValid,
  beforeUpdate: assertValid,
};
