import { describe, expect, it } from "vitest";
import {
  buildMonthGrid,
  bucketEventsByDay,
  dayKey,
  monthParamOf,
  resolveMonth,
} from "./month-grid";
import type { Event } from "./types";

/**
 * The month grid of /events?view=month (WD02). Everything runs in the
 * process zone (local Date construction), so the assertions are about the
 * local calendar and hold in every zone `pnpm test:tz` runs (UTC,
 * Europe/Berlin, Pacific/Auckland).
 */

const NOW = new Date(2026, 8, 15, 12, 0); // 15 September 2026, local noon

/** The expected calendar day `offset` days after y-m-d, independent of any zone. */
function calendarKey(year: number, monthIdx: number, day: number): string {
  const d = new Date(Date.UTC(year, monthIdx, day));
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const date = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${month}-${date}`;
}

let nextId = 1;
function event(start: Date, end?: Date | null, title = `e${nextId}`): Event {
  return {
    id: nextId++,
    title,
    start: start.toISOString(),
    end: end === undefined ? undefined : end === null ? null : end.toISOString(),
  };
}

describe("resolveMonth", () => {
  it("reads a YYYY-MM param", () => {
    expect(resolveMonth("2027-02", NOW)).toEqual({ year: 2027, monthIdx: 1 });
  });

  it.each([undefined, "", "2026-13", "2026-00", "2026-9", "26-09", "abc", "2026-09-01"])(
    "falls back to now's month for %j",
    (param) => {
      expect(resolveMonth(param, NOW)).toEqual({ year: 2026, monthIdx: 8 });
    },
  );
});

describe("buildMonthGrid", () => {
  it.each([
    // [param, leading days, cells, first cell, day after the last cell]
    ["2026-06", 0, 35, "2026-06-01", "2026-07-06"], // starts on a Monday
    ["2026-09", 1, 35, "2026-08-31", "2026-10-05"], // starts on a Tuesday
    ["2026-02", 6, 35, "2026-01-26", "2026-03-02"], // starts on a Sunday
    ["2026-03", 6, 42, "2026-02-23", "2026-04-06"], // Sunday start, 31 days: six weeks
    ["2027-02", 0, 28, "2027-02-01", "2027-03-01"], // Monday start, 28 days: four weeks
  ])("%s: Monday-first, %i leading day(s), %i cells", (param, leading, cellCount, first, until) => {
    const grid = buildMonthGrid(param, NOW);
    expect(grid.leading).toBe(leading);
    expect(grid.cells).toHaveLength(cellCount);
    expect(grid.cells.length % 7).toBe(0);
    expect(dayKey(grid.cells[0]!)).toBe(first);
    // The first cell is always a Monday, the last a Sunday.
    expect(grid.cells[0]!.getDay()).toBe(1);
    expect(grid.cells[grid.cells.length - 1]!.getDay()).toBe(0);
    // One source for the fetch window and the cells.
    expect(grid.from.getTime()).toBe(grid.cells[0]!.getTime());
    expect(dayKey(grid.until)).toBe(until);
  });

  it.each(["2026-03", "2026-04", "2026-10", "2026-09"])(
    "%s (a DST switch in Europe or New Zealand): consecutive local midnights",
    (param) => {
      const grid = buildMonthGrid(param, NOW);
      const { year, monthIdx, leading } = grid;
      grid.cells.forEach((cell, i) => {
        expect(dayKey(cell), `cell ${i}`).toBe(calendarKey(year, monthIdx, 1 - leading + i));
        expect(cell.getHours(), `cell ${i}`).toBe(0);
      });
      expect(dayKey(grid.until)).toBe(calendarKey(year, monthIdx, 1 - leading + grid.cells.length));
      expect(grid.until.getHours()).toBe(0);
    },
  );

  it("uses now's month without a param", () => {
    const grid = buildMonthGrid(undefined, NOW);
    expect(grid).toMatchObject({ year: 2026, monthIdx: 8 });
    expect(dayKey(grid.firstOfMonth)).toBe("2026-09-01");
  });
});

describe("dayKey / monthParamOf", () => {
  it("formats the local calendar day and month", () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(monthParamOf(new Date(2026, 11, 31, 23, 59))).toBe("2026-12");
    // Round trip: the param of a month resolves to that month.
    expect(resolveMonth(monthParamOf(new Date(2027, 1, 1)), NOW)).toEqual({
      year: 2027,
      monthIdx: 1,
    });
  });
});

describe("bucketEventsByDay", () => {
  const grid = buildMonthGrid("2026-09", NOW); // 2026-08-31 .. 2026-10-04

  const keysOf = (byDay: Map<string, Event[]>, e: Event) =>
    [...byDay].filter(([, events]) => events.includes(e)).map(([key]) => key);

  it("puts a single-day event on its day only", () => {
    const e = event(new Date(2026, 8, 10, 9, 0), new Date(2026, 8, 10, 10, 0));
    expect(keysOf(bucketEventsByDay([e], grid), e)).toEqual(["2026-09-10"]);
  });

  it("puts a multi-day event on every day of its span", () => {
    const e = event(new Date(2026, 8, 29, 18, 0), new Date(2026, 9, 1, 8, 0));
    expect(keysOf(bucketEventsByDay([e], grid), e)).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
    ]);
  });

  it("clamps a span that starts before and ends after the grid to the visible cells", () => {
    const e = event(new Date(2026, 7, 1, 9, 0), new Date(2026, 10, 30, 17, 0));
    const keys = keysOf(bucketEventsByDay([e], grid), e);
    expect(keys).toHaveLength(grid.cells.length);
    expect(keys[0]).toBe("2026-08-31");
    expect(keys[keys.length - 1]).toBe("2026-10-04");
  });

  it("covers a span across a DST switch once per calendar day", () => {
    const march = buildMonthGrid("2026-03", NOW);
    const e = event(new Date(2026, 2, 28, 20, 0), new Date(2026, 2, 30, 9, 0));
    expect(keysOf(bucketEventsByDay([e], march), e)).toEqual([
      "2026-03-28",
      "2026-03-29",
      "2026-03-30",
    ]);
  });

  it("shows visible adjacent-month days too", () => {
    const e = event(new Date(2026, 7, 31, 9, 0), null);
    expect(keysOf(bucketEventsByDay([e], grid), e)).toEqual(["2026-08-31"]);
  });

  it("treats an end before the start, or an unparseable end, as a one-day event", () => {
    const backwards = event(new Date(2026, 8, 10, 9, 0), new Date(2026, 8, 8, 9, 0));
    const garbled = { ...event(new Date(2026, 8, 11, 9, 0)), end: "not a date" };
    const byDay = bucketEventsByDay([backwards, garbled], grid);
    expect(keysOf(byDay, backwards)).toEqual(["2026-09-10"]);
    expect(keysOf(byDay, garbled)).toEqual(["2026-09-11"]);
  });

  it("drops an event with an unparseable start and one outside the grid", () => {
    const garbled = { ...event(new Date(2026, 8, 10, 9, 0)), start: "not a date" };
    const outside = event(new Date(2026, 10, 10, 9, 0));
    expect(bucketEventsByDay([garbled, outside], grid).size).toBe(0);
  });

  it("sorts each day's bucket by start", () => {
    const late = event(new Date(2026, 8, 10, 15, 0), null, "late");
    const early = event(new Date(2026, 8, 10, 8, 0), null, "early");
    const spanning = event(new Date(2026, 8, 9, 12, 0), new Date(2026, 8, 10, 12, 0), "spanning");
    const bucket = bucketEventsByDay([late, early, spanning], grid).get("2026-09-10");
    expect(bucket?.map((e) => e.title)).toEqual(["spanning", "early", "late"]);
  });
});
