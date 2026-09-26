/**
 * The poll close rule (datetime contract, deep-dive decision 04, C7), used
 * by the polls page (server) and the poll card (client).
 *
 *  - A poll is closed iff now >= closesAt. The cms vote handler uses the same
 *    rule (apps/cms/src/utils/poll-close.ts); before, the card treated the
 *    exact closing instant as open while the page listed it as closed.
 *  - The form's "closes on D" means the end of day D in APP_TIME_ZONE,
 *    stored as the instant D 23:59:59 there, whatever zone the web process
 *    or the browser runs in.
 */
import { isPlainDate, zonedWallTimeToInstant } from "./plain-date";

/** Wall-clock time a poll closes on its closing day, in APP_TIME_ZONE. */
export const POLL_CLOSING_TIME = "23:59:59";

const INSTANT_SUFFIX_RE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

function instantMs(value: string | Date): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (!INSTANT_SUFFIX_RE.test(value.trim())) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Closed iff now >= closesAt. No (or an unparseable) closesAt: open. */
export function isPollClosed(closesAt: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (closesAt == null || closesAt === "") return false;
  const closesAtMs = instantMs(closesAt);
  if (closesAtMs === null) return false;
  return now.getTime() >= closesAtMs;
}

/**
 * closesAt (ISO-Z) for "closes on `day`" ('YYYY-MM-DD'): 23:59:59 on that
 * day in `timeZone`. Returns null for anything that is not a calendar date.
 */
export function pollClosesAtForDay(day: string, timeZone: string): string | null {
  if (!isPlainDate(day)) return null;
  return zonedWallTimeToInstant(day, POLL_CLOSING_TIME, timeZone).toISOString();
}
