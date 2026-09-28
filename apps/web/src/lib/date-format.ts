/**
 * Rendering dates on pages (datetime contract, decision 04, C6; UI08's
 * date-formatting part). Two value classes, two paths:
 *   - an instant (createdAt, updatedAt, acknowledgedAt, …) goes through
 *     next-intl's formatter — getFormatter() on the server, useFormatter()
 *     on the client — whose zone is APP_TIME_ZONE (i18n/request.ts);
 *   - a calendar date (ackDeadline, expiresAt, …) goes through
 *     plain-date.formatPlainDate: it is a day, and no zone may move it.
 * Neither ever uses the process or browser zone (toLocaleDateString did).
 * A value that is not of its class renders nothing (null): an offset-less
 * date-time or a malformed day is not guessed at.
 */
import { formatPlainDate, instantEpochMs, isPlainDate } from "@/lib/plain-date";

/** The date and time fields the pages use. */
export type DateTimeFields = Pick<
  Intl.DateTimeFormatOptions,
  "weekday" | "year" | "month" | "day" | "hour" | "minute"
>;

/** The part of next-intl's formatter used here (getFormatter/useFormatter). */
export interface DateTimeFormatter {
  dateTime(value: Date, options: DateTimeFields): string;
}

/** "September 30, 2026" / "30. September 2026". */
export const LONG_DAY: DateTimeFields = { year: "numeric", month: "long", day: "numeric" };
/** "Sep 30, 2026" / "30. Sept. 2026". */
export const SHORT_DAY: DateTimeFields = { year: "numeric", month: "short", day: "numeric" };

/** An instant (ISO with Z or an offset, or a Date) in the formatter's zone; null if it is none. */
export function formatInstant(
  format: DateTimeFormatter,
  value: string | Date | null | undefined,
  options: DateTimeFields,
): string | null {
  if (value == null || value === "") return null;
  const ms = instantEpochMs(value);
  return ms === null ? null : format.dateTime(new Date(ms), options);
}

/** A calendar date 'YYYY-MM-DD' as that day; null if it is none. */
export function formatDateOnly(
  locale: string,
  value: string | null | undefined,
  options: DateTimeFields,
): string | null {
  return value && isPlainDate(value) ? formatPlainDate(locale, value, options) : null;
}
