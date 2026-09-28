/**
 * Digest scheduling decisions (issue #18) — pure, so the "who is due
 * when" logic is unit testable without Strapi or a clock.
 *
 * Contract:
 *  - The cron fires DAILY in the morning; this module decides per user
 *    whether a digest is due at that firing.
 *  - `daily` users are due when their last digest was before the start
 *    of today; `weekly` users whenever their last digest was before the
 *    start of this ISO week (FX48). Normally that is Monday's run; a
 *    Monday that failed or had nothing to send is caught up on the next
 *    morning with something to send, still at most once per week.
 *  - Idempotency anchor is `lastDigestAt` ON THE USER ROW (persisted →
 *    survives container restarts): it is advanced only AFTER a
 *    successful send, so a crash mid-run re-sends at most one digest
 *    per affected user and never skips anyone silently.
 *  - The content window starts at `lastDigestAt`, capped at 14 days so
 *    a long-disabled account's first digest doesn't dump months.
 *  - Days and weeks are calendar days of APP_TIME_ZONE (datetime contract,
 *    utils/time.ts), weeks start on Monday, and "start of day" is the first
 *    instant of that day in the zone (a 23- or 25-hour DST day included).
 *    The process zone plays no part; the content window and its fallbacks
 *    are elapsed durations.
 */

import { instantMsOrNull, startOfDayInstant, startOfIsoWeek, todayIn } from "../utils/time";

export type DigestFrequency = "daily" | "weekly";

export interface DigestUserFlags {
  digestAnnouncements?: boolean | null;
  digestMentions?: boolean | null;
  digestKudos?: boolean | null;
  digestFrequency?: string | null;
  lastDigestAt?: string | null;
  confirmed?: boolean | null;
  blocked?: boolean | null;
  email?: string | null;
}

const WINDOW_CAP_MS = 14 * 86400000;

export function wantsAnyDigest(user: DigestUserFlags): boolean {
  if (user.blocked) return false;
  if (!user.email || !user.email.includes("@")) return false;
  return !!(user.digestAnnouncements || user.digestMentions || user.digestKudos);
}

/**
 * `daily`: due iff the last digest is before the start of today.
 * `weekly`: due iff the last digest is before the start of this ISO week
 * (Monday 00:00), on any day (FX48): a Monday missed by a failed run, or
 * one without anything to send, is caught up the next morning instead of a
 * week later. A new weekly subscriber is due the next morning.
 * "Today" and "this week" are calendar days of `timeZone` (APP_TIME_ZONE).
 * A missing or unparseable lastDigestAt counts as "never sent".
 */
export function isDigestDue(user: DigestUserFlags, now: Date, timeZone?: string): boolean {
  if (!wantsAnyDigest(user)) return false;
  const frequency: DigestFrequency = user.digestFrequency === "daily" ? "daily" : "weekly";
  const last = instantMsOrNull(user.lastDigestAt) ?? 0;
  const today = todayIn(timeZone, now);

  if (frequency === "daily") return last < startOfDayInstant(today, timeZone).getTime();

  // weekly: once per ISO week, due until it has been sent.
  return last < startOfDayInstant(startOfIsoWeek(today), timeZone).getTime();
}

/** Content window start: since the last digest, capped, never in the future. */
export function digestWindowStart(user: DigestUserFlags, now: Date): Date {
  const frequency: DigestFrequency = user.digestFrequency === "daily" ? "daily" : "weekly";
  const fallbackMs = frequency === "daily" ? 86400000 : 7 * 86400000;
  const last = instantMsOrNull(user.lastDigestAt);
  const start = last ?? now.getTime() - fallbackMs;
  return new Date(Math.max(start, now.getTime() - WINDOW_CAP_MS));
}
