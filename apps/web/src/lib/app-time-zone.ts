import "server-only";

import { resolveAppTimeZone } from "./plain-date";

/**
 * APP_TIME_ZONE, the deployment's business and display zone (datetime
 * contract, deep-dive decision 04, C2/C3), default Europe/Berlin. The same
 * variable and validation as the cms (plain-date.ts is mirrored). Also
 * checked at server start by src/instrumentation.ts: an invalid value makes
 * every request fail (500) instead of only the first server action that
 * needs it.
 *
 * Phase 1 uses it for the poll deadline only; until the web's phase 2 port
 * the web process itself runs in this zone (compose sets TZ from it).
 */
export function appTimeZone(): string {
  return resolveAppTimeZone(process.env.APP_TIME_ZONE);
}
