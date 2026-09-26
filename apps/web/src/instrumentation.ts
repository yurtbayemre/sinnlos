/**
 * Next.js start hook: runs once when a server instance starts. It validates
 * APP_TIME_ZONE (datetime contract, lib/app-time-zone.ts), so an empty or
 * unknown zone name fails the start instead of a later server action.
 */
import { resolveAppTimeZone } from "./lib/plain-date";

export function register(): void {
  resolveAppTimeZone(process.env.APP_TIME_ZONE);
}
