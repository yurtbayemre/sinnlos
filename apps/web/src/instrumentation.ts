/**
 * Next.js start hook: runs once when a server instance starts. It validates
 * the web's zones (datetime contract, lib/app-time-zone.ts). With an invalid
 * setting Next.js 16 does not exit: it logs "An error occurred while loading
 * instrumentation hook: …" and answers every request with 500, so the
 * healthcheck fails instead of pages quietly computing deadlines or
 * rendering dates in a wrong zone.
 */
import { canonicalTimeZone, resolveAppTimeZone } from "./lib/plain-date";

/**
 * APP_TIME_ZONE must be an IANA name (resolveAppTimeZone). Where the
 * container sets TZ (compose and the Azure recipe set it from
 * APP_TIME_ZONE), Node must really run in that zone: until the web's own
 * datetime port it renders dates in its process zone. The comparison is on
 * canonical names, because Node reports valid links under another name
 * (Asia/Kolkata as Asia/Calcutta, US/Eastern as America/New_York), and it
 * catches what the name check alone cannot: APP_TIME_ZONE=europe/berlin
 * passes Intl's case-insensitive lookup, but TZ=europe/berlin is unknown to
 * Node, which then runs in UTC. A process without TZ (local `next dev`)
 * keeps the machine's zone and is not compared. Returns APP_TIME_ZONE.
 */
export function checkWebTimeZones(
  env: Record<string, string | undefined>,
  processZone: string | undefined,
): string {
  const appZone = resolveAppTimeZone(env.APP_TIME_ZONE);
  const tz = env.TZ?.trim();
  if (!tz) return appZone;
  if (canonicalTimeZone(processZone ?? "") !== appZone) {
    throw new Error(
      `The web process runs in ${processZone ?? "no zone Node recognises"} (TZ="${env.TZ}"), not in ` +
        `APP_TIME_ZONE ${appZone}. Until its datetime port the web renders dates in its process zone: ` +
        'spell APP_TIME_ZONE exactly as the tz database does (e.g. "Europe/Berlin"; compose passes it on ' +
        "as TZ) or set TZ to the same zone.",
    );
  }
  return appZone;
}

export function register(): void {
  checkWebTimeZones(process.env, Intl.DateTimeFormat().resolvedOptions().timeZone);
}
