import "server-only";

import { resolveAppTimeZone } from "./plain-date";

/**
 * APP_TIME_ZONE, the deployment's business and display zone (datetime
 * contract, deep-dive decision 04, C2/C3), default Europe/Berlin. The same
 * variable and validation as the cms (plain-date.ts is mirrored). Checked at
 * server start by src/instrumentation.ts, so an invalid value fails the
 * start instead of the first server action that needs it.
 *
 * Phase 1 uses it for the poll deadline only; the web process still runs
 * with TZ=Europe/Berlin until its phase 2 port is done.
 */
export function appTimeZone(): string {
  return resolveAppTimeZone(process.env.APP_TIME_ZONE);
}
