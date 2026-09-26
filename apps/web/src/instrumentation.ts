/**
 * Next.js start hook: runs once when a server instance starts. It validates
 * APP_TIME_ZONE (datetime contract, lib/app-time-zone.ts). With an empty or
 * unknown zone name Next.js 16 does not exit: it logs "An error occurred
 * while loading instrumentation hook: APP_TIME_ZONE must be …" and answers
 * every request with 500, so the healthcheck fails instead of pages quietly
 * computing deadlines in a wrong zone.
 */
import { resolveAppTimeZone } from "./lib/plain-date";

export function register(): void {
  resolveAppTimeZone(process.env.APP_TIME_ZONE);
}
