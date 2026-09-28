/**
 * Month grid of /events?view=month (WD02: moved out of
 * components/events/events-month-view.tsx, where the grid arithmetic existed
 * twice: once for the events page's fetch window, once for the cells).
 * buildMonthGrid is the one source of both, so the window the page fetches
 * always covers exactly the cells the view renders.
 *
 * Week starts on MONDAY (ISO 8601 / DIN 1355). Datetime contract (decision
 * 04, phase 2): every day is a calendar date 'YYYY-MM-DD' in APP_TIME_ZONE,
 * never a local Date of the process. Cells are calendar-day keys
 * (plain-date.addDaysToKey: no DST involved), an event lands on the days
 * zonedDateKey gives for its start and end in the zone, and the fetch
 * window is half-open [first instant of the first cell, first instant of the
 * day after the last cell) in the zone (plain-date.zonedDayStart: 23- and
 * 25-hour days included). The process zone (UTC in the container) plays no
 * part.
 */

import {
  addDaysToKey,
  daysBetweenKeys,
  instantEpochMs,
  isoWeekdayOfKey,
  isPlainDate,
  zonedDateKey,
  zonedDayStart,
} from "@/lib/plain-date";
import type { Event } from "@/lib/types";

/**
 * 'YYYY-MM' with a year from 1900 to 2999: the grid and its neighbours stay
 * four-digit calendar dates (Date.UTC maps the years 0-99 to 1900-1999).
 */
const MONTH_PARAM_RE = /^(19\d\d|2\d\d\d)-(0[1-9]|1[0-2])$/;

/** The first day ('YYYY-MM-01') of the month `offset` months after year/month. */
function firstOfMonth(year: number, month: number, offset = 0): string {
  const index = year * 12 + (month - 1) + offset;
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
}

/**
 * The displayed month (1-based) of the `month` param; a missing or
 * malformed param falls back to the month of `today` ('YYYY-MM-DD' in
 * APP_TIME_ZONE).
 */
export function resolveMonth(
  monthParam: string | undefined,
  today: string,
): { year: number; month: number } {
  const match = monthParam ? MONTH_PARAM_RE.exec(monthParam) : null;
  if (match) return { year: Number(match[1]), month: Number(match[2]) };
  if (!isPlainDate(today)) throw new RangeError(`Not a calendar date (YYYY-MM-DD): ${today}`);
  return { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
}

export interface MonthGrid {
  year: number;
  /** 1-based month. */
  month: number;
  /** 'YYYY-MM' of the displayed month (a cell outside it starts differently). */
  monthParam: string;
  /** 'YYYY-MM-01' of the displayed month. */
  firstOfMonth: string;
  /** Days of the previous month before the 1st (Monday-first, 0..6). */
  leading: number;
  /** Every visible day as 'YYYY-MM-DD', whole weeks (28, 35 or 42 cells). */
  cells: string[];
  /** Start of the half-open fetch window [from, until): the first cell's first instant. */
  from: Date;
  /** The first instant of the day AFTER the last cell (exclusive end). */
  until: Date;
  /** `month` params of the previous and the next month (navigation). */
  prevMonthParam: string;
  nextMonthParam: string;
}

/**
 * The visible grid of the month named by `monthParam` (or of `today`): the
 * Monday-aligned leading days, the month, and the trailing fill of the last
 * week. `from`/`until` are instants of `timeZone` (APP_TIME_ZONE): the
 * events page fetches exactly [from, until), so events on visible
 * adjacent-month days appear too.
 */
export function buildMonthGrid(
  monthParam: string | undefined,
  today: string,
  timeZone: string,
): MonthGrid {
  const { year, month } = resolveMonth(monthParam, today);
  const first = firstOfMonth(year, month);
  const daysInMonth = daysBetweenKeys(first, firstOfMonth(year, month, 1));
  // Monday-first offset: ISO weekday 1 (Monday) → 0 leading days.
  const leading = isoWeekdayOfKey(first) - 1;
  const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7;
  const gridStart = addDaysToKey(first, -leading);
  const cells = Array.from({ length: totalCells }, (_, i) => addDaysToKey(gridStart, i));
  return {
    year,
    month,
    monthParam: first.slice(0, 7),
    firstOfMonth: first,
    leading,
    cells,
    from: zonedDayStart(gridStart, timeZone),
    until: zonedDayStart(addDaysToKey(gridStart, totalCells), timeZone),
    prevMonthParam: firstOfMonth(year, month, -1).slice(0, 7),
    nextMonthParam: firstOfMonth(year, month, 1).slice(0, 7),
  };
}

/**
 * Bucket events per visible day (day key → events, each bucket sorted by
 * start). An event covers the days of its start through its end in
 * `timeZone` (for all-day events the decision's rule, C7: zonedDateOf(start)
 * through zonedDateOf(end ?? start), inclusive), clamped to the grid. An end
 * before the start, or one that is no instant, counts as a one-day event; a
 * start that is no instant (garbage, or a date-time without Z or an offset)
 * drops the event.
 */
export function bucketEventsByDay(
  events: Event[],
  grid: MonthGrid,
  timeZone: string,
): Map<string, Event[]> {
  const gridStart = grid.cells[0];
  const gridEnd = grid.cells[grid.cells.length - 1];
  const byDay = new Map<string, Event[]>();
  const startMs = new Map<Event, number>();
  if (!gridStart || !gridEnd) return byDay;
  for (const event of events) {
    const start = instantEpochMs(event.start);
    if (start === null) continue;
    startMs.set(event, start);
    const end = event.end ? instantEpochMs(event.end) : null;
    const spanEnd = end === null || end < start ? start : end;
    const firstDay = zonedDateKey(new Date(start), timeZone);
    const lastDay = zonedDateKey(new Date(spanEnd), timeZone);
    // 'YYYY-MM-DD' keys compare like the days they name.
    let cursor = firstDay < gridStart ? gridStart : firstDay;
    const stop = lastDay < gridEnd ? lastDay : gridEnd;
    while (cursor <= stop) {
      const bucket = byDay.get(cursor);
      if (bucket) bucket.push(event);
      else byDay.set(cursor, [event]);
      cursor = addDaysToKey(cursor, 1);
    }
  }
  for (const bucket of byDay.values()) {
    bucket.sort((a, b) => (startMs.get(a) ?? 0) - (startMs.get(b) ?? 0));
  }
  return byDay;
}
