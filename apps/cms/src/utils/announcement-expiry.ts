/**
 * Announcement expiry (DA02; owner answer 2026-09-29 (b): implement it).
 *
 * `announcement.expiresAt` is a `datetime` attribute: an instant, stored as
 * timestamptz under the UTC contract (deep-dive decision 04), written by an
 * editor as a wall time in APP_TIME_ZONE (the admin panel) or as an offset
 * instant (v2 authoring). The boundary is that instant itself, no calendar
 * day involved: an announcement is listed while `expiresAt` is unset or
 * still in the future, and from `expiresAt` on it is expired. So "expires
 * at 2026-10-01 00:00 Europe/Berlin" is gone from the first second of
 * October in Berlin, whatever the server's zone.
 *
 * An expired announcement disappears for everyone below the admin_role /
 * editor bypass, like one outside their audience:
 *   - the announcement list and single reads (policies/announcement-
 *     visibility.ts), and with them the ack banner, search and the
 *     dashboard;
 *   - its comment and reaction thread (utils/target-visibility.ts);
 *   - the e-mail digest (digest/send-digests.ts; the digest also skips it
 *     for admin_role and editor, whose digest is strictly their audience).
 * admin_role and editor keep reading it (they author it, and v2 authoring
 * shows it with its end date), like drafts.
 *
 * Two forms of one rule: `isAnnouncementExpired` for rows in memory and
 * `notExpiredWhere` for the query engine; announcement-expiry.test.ts holds
 * them equal. An `expiresAt` that is not a readable instant counts as "not
 * expired": expiry is a content lifecycle, not an access rule, and the
 * targeting rules still apply to the row.
 */
import { instantMsOrNull } from "./time";

/** The slice of an announcement row the rule reads. */
export interface ExpiringRow {
  expiresAt?: unknown;
}

/** Whether the row is expired at `now`: `expiresAt` set and not after `now`. */
export function isAnnouncementExpired(row: ExpiringRow, now: Date): boolean {
  const value = row.expiresAt;
  if (typeof value !== "string" && !(value instanceof Date)) return false;
  const expiresMs = instantMsOrNull(value);
  return expiresMs != null && expiresMs <= now.getTime();
}

/** The query-engine `where` for the rows that are NOT expired at `now`. */
export function notExpiredWhere(now: Date): Record<string, unknown> {
  return { $or: [{ expiresAt: { $null: true } }, { expiresAt: { $gt: now.toISOString() } }] };
}
