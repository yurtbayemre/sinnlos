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
import { instantEpochMs, isPlainDate, zonedWallTimeToInstant } from "./plain-date";

/** Wall-clock time a poll closes on its closing day, in APP_TIME_ZONE. */
export const POLL_CLOSING_TIME = "23:59:59";

/**
 * Closed iff now >= closesAt. No closesAt, or one that is no instant (an
 * offset-less date-time, a bare calendar date, garbage): open, like the cms.
 */
export function isPollClosed(closesAt: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (closesAt == null || closesAt === "") return false;
  const closesAtMs = instantEpochMs(closesAt);
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
