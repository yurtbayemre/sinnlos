import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
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
 * Dates are resolved in the SERVER timezone — consistent with the list
 * view, which also formats server-side.
 */

/** Local YYYY-MM-DD key (toISOString would shift across UTC midnight). */
function dayKey(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

function monthParamOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Resolve the displayed month; malformed params fall back to `now`. */
export function resolveMonth(
  monthParam: string | undefined,
  now: Date,
): { year: number; monthIdx: number } {
  let year = now.getFullYear();
  let monthIdx = now.getMonth();
  if (monthParam && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam)) {
    year = Number(monthParam.slice(0, 4));
    monthIdx = Number(monthParam.slice(5, 7)) - 1;
  }
  return { year, monthIdx };
}

/**
 * The half-open local-time window [from, until) covered by the visible
 * month grid (Monday-aligned leading days through the trailing fill of
 * the last week). The events page fetches exactly this window, so events
 * on visible adjacent-month days appear too. Local Date construction on
 * purpose — the container runs in the users' timezone (TZ env in
 * infra/docker-compose.yml), so no UTC parsing drift.
 */
export function monthGridRange(
  monthParam: string | undefined,
  now: Date,
): { from: Date; until: Date } {
  const { year, monthIdx } = resolveMonth(monthParam, now);
  const firstOfMonth = new Date(year, monthIdx, 1);
  const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
  const leading = (firstOfMonth.getDay() + 6) % 7;
  const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7;
  return {
    from: new Date(year, monthIdx, 1 - leading),
    until: new Date(year, monthIdx, 1 - leading + totalCells),
  };
}

const MAX_CHIPS_PER_DAY = 3;

export async function EventsMonthView({
  events,
  monthParam,
}: {
  events: Event[];
  monthParam?: string;
}) {
  const [t, locale] = await Promise.all([getTranslations("events"), getLocale()]);

  const now = new Date();
  const { year, monthIdx } = resolveMonth(monthParam, now);

  const firstOfMonth = new Date(year, monthIdx, 1);
  const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
  // Monday-first offset: JS getDay() is Sunday=0 → shift so Monday=0.
  const leading = (firstOfMonth.getDay() + 6) % 7;
  const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7;
  const cells: Date[] = Array.from(
    { length: totalCells },
    (_, i) => new Date(year, monthIdx, i - leading + 1),
  );
  const gridStart = cells[0];
  const gridEnd = cells[cells.length - 1];

  // Bucket events per visible day; multi-day events land on EVERY day of
  // their span (clamped to the visible grid).
  const byDay = new Map<string, Event[]>();
  for (const event of events) {
    const start = new Date(event.start);
    const end = event.end ? new Date(event.end) : start;
    if (Number.isNaN(start.getTime())) continue;
    const spanEnd = Number.isNaN(end.getTime()) || end < start ? start : end;
    let cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    if (cursor < gridStart) cursor = new Date(gridStart);
    const last = new Date(spanEnd.getFullYear(), spanEnd.getMonth(), spanEnd.getDate());
    const stop = last < gridEnd ? last : gridEnd;
    while (cursor <= stop) {
      const key = dayKey(cursor);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(event);
      else byDay.set(key, [event]);
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }
  }
  for (const bucket of byDay.values()) {
    bucket.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  }

  const monthLabel = firstOfMonth.toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
  });
  // 2024-01-01 is a Monday — a cheap anchor for localized weekday names.
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 0, 1 + i).toLocaleDateString(locale, { weekday: "short" }),
  );
  const todayKey = dayKey(now);
  const prevParam = monthParamOf(new Date(year, monthIdx - 1, 1));
  const nextParam = monthParamOf(new Date(year, monthIdx + 1, 1));

  const weeks: Date[][] = [];
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
            href={`/events?view=month&month=${prevParam}`}
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
            href={`/events?view=month&month=${nextParam}`}
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
                {week.map((day) => {
                  const key = dayKey(day);
                  const inMonth = day.getMonth() === monthIdx;
                  const isToday = key === todayKey;
                  const dayEvents = byDay.get(key) ?? [];
                  const overflow = dayEvents.length - MAX_CHIPS_PER_DAY;
                  const fullDate = day.toLocaleDateString(locale, {
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
                          {day.getDate()}
                        </span>
                      </div>
                      <div className="mt-0.5 space-y-0.5">
                        {dayEvents.slice(0, MAX_CHIPS_PER_DAY).map((event) => {
                          const start = new Date(event.start);
                          const showTime = !event.allDay && dayKey(start) === key;
                          return (
                            <div
                              key={event.id}
                              title={event.title}
                              className="truncate rounded bg-primary/10 px-1 py-0.5 text-[11px] leading-tight text-primary"
                            >
                              {showTime && (
                                <span className="mr-1 font-medium">
                                  {start.toLocaleTimeString(locale, {
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
