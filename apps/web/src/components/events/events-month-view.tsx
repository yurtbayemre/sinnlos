import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { bucketEventsByDay, type MonthGrid } from "@/lib/month-grid";
import { addDaysToKey, formatPlainDate, instantEpochMs, zonedDateKey } from "@/lib/plain-date";
import type { Event } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Server-rendered month calendar for /events?view=month. Week starts on
 * MONDAY (ISO 8601 / DIN 1355); month navigation runs over the `month`
 * searchParam (full RSC re-render, no client state). Semantics: a real
 * <table> with a caption and column headers — this is a read-only
 * calendar, not an interactive date picker, so the APG grid/roving-
 * tabindex pattern does not apply; cells carry sr-only full dates instead.
 *
 * The events page builds the grid (lib/month-grid.ts) once and passes it
 * in, so its fetch window and these cells are one source (WD02). Every day
 * is a calendar date in APP_TIME_ZONE (datetime contract, phase 2): the
 * cells and labels are formatted as plain dates, the chip times with
 * next-intl's formatter, whose zone is APP_TIME_ZONE (i18n/request.ts).
 */

const MAX_CHIPS_PER_DAY = 3;

export async function EventsMonthView({
  events,
  grid,
  today,
  timeZone,
}: {
  events: Event[];
  /** The grid the page fetched `events` for (buildMonthGrid). */
  grid: MonthGrid;
  /** Today in APP_TIME_ZONE ('YYYY-MM-DD'). */
  today: string;
  /** APP_TIME_ZONE. */
  timeZone: string;
}) {
  const [t, locale, format] = await Promise.all([
    getTranslations("events"),
    getLocale(),
    getFormatter(),
  ]);

  const { cells } = grid;

  // Bucket events per visible day; multi-day events land on EVERY day of
  // their span (clamped to the visible grid).
  const byDay = bucketEventsByDay(events, grid, timeZone);

  const monthLabel = formatPlainDate(locale, grid.firstOfMonth, {
    month: "long",
    year: "numeric",
  });
  // 2024-01-01 is a Monday — a cheap anchor for localized weekday names.
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    formatPlainDate(locale, addDaysToKey("2024-01-01", i), { weekday: "short" }),
  );

  const weeks: string[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        {/* aria-live: month switches are soft navigations (Link), so the
            heading update is announced without a full page load. */}
        <h2 aria-live="polite" className="text-base font-semibold capitalize">
          {monthLabel}
        </h2>
        <div className="flex items-center gap-1">
          <Link
            href={`/events?view=month&month=${grid.prevMonthParam}`}
            aria-label={t("prevMonth")}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Link>
          <Link
            href="/events?view=month"
            className="inline-flex h-8 items-center rounded-lg border px-3 text-xs font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {t("currentMonth")}
          </Link>
          <Link
            href={`/events?view=month&month=${grid.nextMonthParam}`}
            aria-label={t("nextMonth")}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full table-fixed border-collapse">
          <caption className="sr-only">{monthLabel}</caption>
          <thead>
            <tr>
              {weekdays.map((w) => (
                <th
                  key={w}
                  scope="col"
                  className="border-b px-1 py-2 text-center text-xs font-medium text-muted-foreground"
                >
                  {w}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week, wi) => (
              <tr key={wi}>
                {week.map((key) => {
                  const inMonth = key.startsWith(`${grid.monthParam}-`);
                  const isToday = key === today;
                  const dayEvents = byDay.get(key) ?? [];
                  const overflow = dayEvents.length - MAX_CHIPS_PER_DAY;
                  const fullDate = formatPlainDate(locale, key, {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  });
                  return (
                    <td
                      key={key}
                      className={cn(
                        "h-24 border-b border-r p-1 align-top last:border-r-0",
                        !inMonth && "bg-muted/40",
                      )}
                    >
                      <span className="sr-only">
                        {fullDate}, {t("eventsOnDay", { count: dayEvents.length })}
                        {isToday && ` (${t("today")})`}
                      </span>
                      <div aria-hidden="true" className="flex justify-end">
                        <span
                          className={cn(
                            "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs",
                            !inMonth && "text-muted-foreground",
                            isToday && "bg-primary font-semibold text-primary-foreground",
                          )}
                        >
                          {Number(key.slice(8, 10))}
                        </span>
                      </div>
                      <div className="mt-0.5 space-y-0.5">
                        {dayEvents.slice(0, MAX_CHIPS_PER_DAY).map((event) => {
                          // bucketEventsByDay keeps only events with a real start instant.
                          const start = new Date(instantEpochMs(event.start) ?? Number.NaN);
                          const showTime = !event.allDay && zonedDateKey(start, timeZone) === key;
                          return (
                            <div
                              key={event.id}
                              title={event.title}
                              className="truncate rounded bg-primary/10 px-1 py-0.5 text-[11px] leading-tight text-primary"
                            >
                              {showTime && (
                                <span className="mr-1 font-medium">
                                  {format.dateTime(start, {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </span>
                              )}
                              {event.title}
                            </div>
                          );
                        })}
                        {overflow > 0 && (
                          <div className="px-1 text-[11px] text-muted-foreground">
                            {t("moreEvents", { count: overflow })}
                          </div>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
