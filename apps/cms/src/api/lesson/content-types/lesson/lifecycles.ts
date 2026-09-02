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
 *    idempotent, so re-validating already-valid content is a no-op.
 *  - Partial updates: admin saves send only changed fields, so
 *    validateLessonData checks strictly `field in data` (§ mirror of
 *    the `"body" in data` guard in wiki-page/lifecycles.ts).
 *
 * ApplicationError surfaces as a readable message in the admin panel
 * (a plain throw would be a 500). The web player's render gate stays
 * the authoritative XSS layer regardless (mirror-pair rule, see
 * utils/training-validation.ts).
 */
function assertValid(event: any): void {
  const data = event?.params?.data;
  if (!data || typeof data !== "object") return;
  const error = validateLessonData(data);
  if (error) throw new errors.ApplicationError(error);
}

export default {
  beforeCreate: assertValid,
  beforeUpdate: assertValid,
};
