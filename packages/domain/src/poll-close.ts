/**
 * The poll close rule (datetime contract, deep-dive decision 04, C7): a poll
 * is closed iff now >= closesAt. One rule for the cms vote handler
 * (apps/cms/src/utils/poll-close.ts), the polls page (server) and the poll
 * card (client) (apps/web/src/lib/poll-close.ts); before, the cms accepted
 * a vote at the exact closing instant while the web already listed the poll
 * as closed, and the card treated that instant as open while the page
 * listed it as closed.
 *
 * closesAt is an instant. The web form's "closes on D" means the end of day
 * D in APP_TIME_ZONE, stored as the instant D 23:59:59 there, whatever zone
 * the web process or the browser runs in. No closesAt means the poll never
 * closes; a value that is no instant counts as open (Strapi only stores
 * valid datetimes).
 */
import { instantEpochMs, isPlainDate, zonedWallTimeToInstant } from "./plain-date.js";

/** Wall-clock time a poll closes on its closing day, in APP_TIME_ZONE. */
export const POLL_CLOSING_TIME = "23:59:59";

/**
 * Closed iff now >= closesAt. No closesAt, or one that is no instant (an
 * offset-less date-time, a bare calendar date, garbage): open. The cms's
 * Temporal reading of an instant (time.ts instantMsOrNull) agrees with
 * instantEpochMs (apps/cms/src/utils/time-parity.test.ts).
 */
export function isPollClosed(
  closesAt: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
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
