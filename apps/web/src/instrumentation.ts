/**
 * Next.js start hook: runs once when a server instance starts. It validates
 * the web's zones (datetime contract, lib/app-time-zone.ts). With an invalid
 * APP_TIME_ZONE Next.js 16 does not exit: it logs "An error occurred while
 * loading instrumentation hook: …" and answers every request with 500, so
 * the healthcheck fails instead of pages quietly computing deadlines or
 * rendering dates in a wrong zone.
 */
import { canonicalTimeZone, resolveAppTimeZone } from "./lib/plain-date";

/**
 * Datetime phase 2: the web renders every date with an explicit zone
 * (next-intl's formatter in APP_TIME_ZONE, plain-date.ts for calendar days;
 * the ESLint ban keeps it so), and its container runs in UTC like the cms
 * (TZ=UTC in the image and in compose). The process zone therefore no
 * longer decides anything, and any process zone is accepted, UTC included.
 *
 * APP_TIME_ZONE must still be an IANA name (resolveAppTimeZone): an empty or
 * unknown value, or a UTC offset, throws. Returns its canonical name.
 *
 * Before phase 2 the check here also required Node to run IN APP_TIME_ZONE
 * (compose set TZ from it). That is why a web image from before phase 2
 * refuses to start under this compose file's TZ=UTC: roll back to one only
 * with infra/docker-compose.web-legacy-tz.yml (docs/DEPLOYMENT.md).
 */
export function checkWebTimeZones(env: Record<string, string | undefined>): string {
  return resolveAppTimeZone(env.APP_TIME_ZONE);
}

/**
 * A warning when the container sets TZ to anything but UTC, e.g. the legacy
 * rollback override left in place for this image. Harmless for rendering,
 * but not the deployment contract. A process without TZ (local `next dev`)
 * keeps the machine's zone and gets no warning. null: nothing to say.
 */
export function webZoneWarning(
  env: Record<string, string | undefined>,
  processZone: string | undefined,
): string | null {
  if (!env.TZ?.trim()) return null;
  if (canonicalTimeZone(processZone ?? "") === "UTC") return null;
  return (
    `[datetime] The web process runs in ${processZone ?? "no zone Node recognises"} (TZ="${env.TZ}"), ` +
    "not UTC. Dates do not depend on it (they are rendered in APP_TIME_ZONE), but the web container " +
    "should run with TZ=UTC: remove a leftover infra/docker-compose.web-legacy-tz.yml, which only a " +
    "web image from before the datetime port needs."
  );
}

export function register(): void {
  const processZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const appZone = checkWebTimeZones(process.env);
  console.info(`[datetime] web process time zone ${processZone}, APP_TIME_ZONE ${appZone}`);
  const warning = webZoneWarning(process.env, processZone);
  if (warning) console.warn(warning);
}
