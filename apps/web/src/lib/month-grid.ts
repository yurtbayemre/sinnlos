/**
 * Month grid of /events?view=month (WD02: moved out of
 * components/events/events-month-view.tsx, where the grid arithmetic existed
 * twice: once for the events page's fetch window, once for the cells).
 * buildMonthGrid is now the one source of both, so the window the page
 * fetches always covers exactly the cells the view renders.
 *
 * Week starts on MONDAY (ISO 8601 / DIN 1355). Dates are resolved in the
 * SERVER time zone with local Date construction, consistent with the list
 * view (the container runs in the users' zone, TZ in
 * infra/docker-compose.yml). Local construction keeps every cell at local
 * midnight across a DST switch, where fixed 24-hour steps would drift.
 * Datetime phase 2 (batch 3) makes this zone-explicit in APP_TIME_ZONE, in
 * this file only.
 */

import type { Event } from "@/lib/types";

/** Local YYYY-MM-DD key (toISOString would shift across UTC midnight). */
export function dayKey(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** The `month` search param (YYYY-MM) of the month containing `d`. */
export function monthParamOf(d: Date): string {
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

export interface MonthGrid {
  year: number;
  /** 0-based month index. */
  monthIdx: number;
  firstOfMonth: Date;
  /** Days of the previous month before the 1st (Monday-first, 0..6). */
  leading: number;
  /** Every visible day at local midnight, whole weeks (35 or 42 cells). */
  cells: Date[];
  /** Start of the half-open fetch window [from, until) = the first cell. */
  from: Date;
  /** Local midnight AFTER the last cell (exclusive end of the fetch window). */
  until: Date;
}

/**
 * The visible grid of the month named by `monthParam` (or of `now`): the
 * Monday-aligned leading days, the month, and the trailing fill of the last
 * week. The events page fetches exactly [from, until), so events on visible
 * adjacent-month days appear too.
 */
export function buildMonthGrid(monthParam: string | undefined, now: Date): MonthGrid {
  const { year, monthIdx } = resolveMonth(monthParam, now);
  const firstOfMonth = new Date(year, monthIdx, 1);
  const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
  // Monday-first offset: JS getDay() is Sunday=0 → shift so Monday=0.
  const leading = (firstOfMonth.getDay() + 6) % 7;
  const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7;
  const cells = Array.from(
    { length: totalCells },
    (_, i) => new Date(year, monthIdx, i - leading + 1),
  );
  return {
    year,
    monthIdx,
    firstOfMonth,
    leading,
    cells,
    from: new Date(year, monthIdx, 1 - leading),
    until: new Date(year, monthIdx, 1 - leading + totalCells),
  };
}

/**
 * Bucket events per visible day (dayKey → events, each bucket sorted by
 * start). A multi-day event lands on EVERY day of its span, clamped to the
 * grid; an end before the start, or an unparseable end, counts as a one-day
 * event, and an unparseable start drops the event.
 */
export function bucketEventsByDay(events: Event[], grid: MonthGrid): Map<string, Event[]> {
  const gridStart = grid.cells[0];
  const gridEnd = grid.cells[grid.cells.length - 1];
  const byDay = new Map<string, Event[]>();
  if (!gridStart || !gridEnd) return byDay;
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
  return byDay;
}
