/**
 * Expiry of a classified ad (datetime contract, deep-dive decision 04, C7).
 *
 * `expiresAt` is a calendar date ('YYYY-MM-DD', Postgres `date`): the last
 * day the ad is listed. The clamp runs in calendar-date space around
 * "today" in APP_TIME_ZONE, so it cannot drift by a day with the process
 * zone around midnight:
 *  - requested dates are clamped to [today, today + 90];
 *  - a missing or invalid value defaults to today + 30;
 *  - "today" is a valid floor: an ad expiring today stays listed for the
 *    rest of the day (the web lists expiresAt >= today; an ad is expired
 *    iff expiresAt < today).
 * Input is the web form's 'YYYY-MM-DD'. An instant with Z or an offset is
 * accepted too and read as its calendar day in the business zone.
 */
import { comparePlainDates, todayIn, tryParsePlainDate, zonedDateOf, type PlainDate } from "./time";

export const DEFAULT_LIFETIME_DAYS = 30;
export const MAX_LIFETIME_DAYS = 90;

function requestedDate(value: unknown, timeZone: string | undefined): PlainDate | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  const date = tryParsePlainDate(trimmed);
  if (date) return date;
  try {
    return zonedDateOf(trimmed, timeZone);
  } catch {
    return null;
  }
}

/** The clamped expiry date as 'YYYY-MM-DD'. */
export function clampExpiresAt(value: unknown, today: PlainDate = todayIn(), timeZone?: string): string {
  const max = today.add({ days: MAX_LIFETIME_DAYS });
  let candidate = requestedDate(value, timeZone) ?? today.add({ days: DEFAULT_LIFETIME_DAYS });
  if (comparePlainDates(candidate, max) > 0) candidate = max;
  if (comparePlainDates(candidate, today) < 0) candidate = today;
  return candidate.toString();
}
