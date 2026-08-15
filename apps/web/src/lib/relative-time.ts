/**
 * Shared relative-time formatter — replaces the ad-hoc `relative()`
 * helpers that were duplicated (with hardcoded English in places) across
 * the notification bell, comment threads and the dashboard news feed.
 *
 * Translations live in the `relativeTime` messages namespace. Pass the
 * scoped `t` function in from the component:
 *   - client: `useTranslations("relativeTime")`
 *   - server: `await getTranslations("relativeTime")`
 */
export type RelativeTimeKey =
  | "justNow"
  | "minutesAgo"
  | "hoursAgo"
  | "today"
  | "yesterday"
  | "daysAgo";

export type RelativeTimeT = (
  key: RelativeTimeKey,
  values?: Record<string, number>,
) => string;

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function relativeTime(
  input: string | Date | null | undefined,
  t: RelativeTimeT,
  opts: {
    /**
     * "minute": just now / Xm / Xh below one day (notifications).
     * "day" (default): today / yesterday (comments, news, kudos).
     */
    granularity?: "minute" | "day";
    /** Include the year in the absolute-date fallback (>= 7 days old). */
    longDate?: boolean;
  } = {},
): string {
  if (!input) return "";
  const date = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return "";

  const diff = Date.now() - date.getTime();
  const { granularity = "day", longDate = false } = opts;

  if (granularity === "minute") {
    if (diff < MIN) return t("justNow");
    if (diff < HOUR) return t("minutesAgo", { min: Math.floor(diff / MIN) });
    if (diff < DAY) return t("hoursAgo", { hours: Math.floor(diff / HOUR) });
  } else {
    if (diff < DAY) return t("today");
    if (diff < 2 * DAY) return t("yesterday");
  }
  if (diff < 7 * DAY) return t("daysAgo", { days: Math.floor(diff / DAY) });

  return date.toLocaleDateString(undefined, {
    ...(longDate ? { year: "numeric" as const } : {}),
    month: "short",
    day: "numeric",
  });
}
