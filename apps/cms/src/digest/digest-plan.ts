/**
 * Digest scheduling decisions (issue #18) — pure, so the "who is due
 * when" logic is unit testable without Strapi or a clock.
 *
 * Contract:
 *  - The cron fires DAILY in the morning; this module decides per user
 *    whether a digest is due at that firing.
 *  - `daily` users are due when their last digest was before the start
 *    of today; `weekly` users only on Monday, when the last digest was
 *    before the start of this week.
 *  - Idempotency anchor is `lastDigestAt` ON THE USER ROW (persisted →
 *    survives container restarts): it is advanced only AFTER a
 *    successful send, so a crash mid-run re-sends at most one digest
 *    per affected user and never skips anyone silently.
 *  - The content window starts at `lastDigestAt`, capped at 14 days so
 *    a long-disabled account's first digest doesn't dump months.
 */

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

/** Local (container TZ = Europe/Berlin) start of the given day. */
function startOfDay(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Local start of the ISO week (Monday) containing `now`. */
function startOfWeek(now: Date): Date {
  const d = startOfDay(now);
  const weekday = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  d.setDate(d.getDate() - weekday);
  return d;
}

export function isDigestDue(user: DigestUserFlags, now: Date): boolean {
  if (!wantsAnyDigest(user)) return false;
  const frequency: DigestFrequency = user.digestFrequency === "daily" ? "daily" : "weekly";
  const last = user.lastDigestAt ? new Date(user.lastDigestAt).getTime() : 0;

  if (frequency === "daily") return last < startOfDay(now).getTime();

  // weekly: only on Mondays, once per week.
  if (now.getDay() !== 1) return false;
  return last < startOfWeek(now).getTime();
}

/** Content window start: since the last digest, capped, never in the future. */
export function digestWindowStart(user: DigestUserFlags, now: Date): Date {
  const frequency: DigestFrequency = user.digestFrequency === "daily" ? "daily" : "weekly";
  const fallbackMs = frequency === "daily" ? 86400000 : 7 * 86400000;
  const last = user.lastDigestAt ? new Date(user.lastDigestAt).getTime() : NaN;
  const start = Number.isFinite(last) ? last : now.getTime() - fallbackMs;
  return new Date(Math.max(start, now.getTime() - WINDOW_CAP_MS));
}
