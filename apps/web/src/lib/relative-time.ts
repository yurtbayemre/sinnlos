/**
 * Shared relative-time formatter — replaces the ad-hoc `relative()`
 * helpers that were duplicated (with hardcoded English in places) across
 * the notification bell, comment threads and the dashboard news feed.
 *
 * Translations live in the `relativeTime` messages namespace. Pass the
 * scoped `t` function in from the component:
 *   - client: `useTranslations("relativeTime")`
 *   - server: `await getTranslations("relativeTime")`
 *
 * Datetime contract (decision 04, C6; FX49): minute and hour labels come
 * from the elapsed time; "today", "yesterday" and "N days ago" compare
 * calendar days in APP_TIME_ZONE (plain-date.zonedDateKey), so a comment
 * from 23:50 is "yesterday" at 00:10, not "today"; longer ago shows the day
 * itself, formatted in the app locale. Both come from the caller: server
 * code passes getLocale() and APP_TIME_ZONE, client components useLocale()
 * and useTimeZone() (the provider carries the request config's zone). No
 * process or browser zone is involved, so server and client render the same
 * label.
 */
import { daysBetweenKeys, formatPlainDate, instantEpochMs, zonedDateKey } from "./plain-date";

export type RelativeTimeKey =
  | "justNow"
  | "minutesAgo"
  | "hoursAgo"
  | "today"
  | "yesterday"
  | "daysAgo";

export type RelativeTimeT = (key: RelativeTimeKey, values?: Record<string, number>) => string;

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface RelativeTimeOptions {
  /** The app locale (BCP 47) for the date shown from 7 days on. */
  locale: string;
  /** APP_TIME_ZONE: the zone whose calendar days are compared. */
  timeZone: string;
  /**
   * "minute": just now / Xm / Xh below 24 hours of elapsed time, then days
   * (notifications). "day" (default): today / yesterday / Xd (comments,
   * news, kudos, ads).
   */
  granularity?: "minute" | "day";
  /** Include the year in the date shown from 7 days on. */
  longDate?: boolean;
  /** The current instant (tests); default: now. */
  now?: Date;
}

export function relativeTime(
  input: string | Date | null | undefined,
  t: RelativeTimeT,
  opts: RelativeTimeOptions,
): string {
  if (!input) return "";
  // An instant needs Z or an offset (C4); anything else renders nothing.
  const ms = instantEpochMs(input);
  if (ms === null) return "";

  const { locale, timeZone, granularity = "day", longDate = false } = opts;
  const now = opts.now ?? new Date();
  const diff = now.getTime() - ms;

  if (granularity === "minute" && diff < DAY) {
    if (diff < MIN) return t("justNow");
    if (diff < HOUR) return t("minutesAgo", { min: Math.floor(diff / MIN) });
    return t("hoursAgo", { hours: Math.floor(diff / HOUR) });
  }

  const day = zonedDateKey(new Date(ms), timeZone);
  const days = daysBetweenKeys(day, zonedDateKey(now, timeZone));
  if (granularity === "minute") {
    // 24 hours or more have passed: at least one day (a 25-hour DST day
    // can hold 24 elapsed hours within one calendar day).
    if (days < 7) return t("daysAgo", { days: Math.max(1, days) });
  } else {
    // A future instant (clock skew between cms and web) counts as today.
    if (days <= 0) return t("today");
    if (days === 1) return t("yesterday");
    if (days < 7) return t("daysAgo", { days });
  }

  return formatPlainDate(locale, day, {
    ...(longDate ? { year: "numeric" as const } : {}),
    month: "short",
    day: "numeric",
  });
}
