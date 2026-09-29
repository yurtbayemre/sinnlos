import "server-only";

import { resolveAppTimeZone } from "./plain-date";

/**
 * APP_TIME_ZONE, the deployment's business and display zone (datetime
 * contract, deep-dive decision 04, C2/C3), default Europe/Berlin. The same
 * variable and validation as the cms (plain-date.ts, from @sinnlos/domain). Also
 * checked at server start by src/instrumentation.ts: an invalid value makes
 * every request fail (500) instead of only the first server action that
 * needs it.
 *
 * Since the web's phase 2 port every date the web computes or renders uses
 * it explicitly (i18n/request.ts gives it to next-intl's formatter), and the
 * web process runs in UTC like the cms (TZ=UTC in the image and compose).
 */
export function appTimeZone(): string {
  return resolveAppTimeZone(process.env.APP_TIME_ZONE);
}
