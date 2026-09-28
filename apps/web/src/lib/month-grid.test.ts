import { describe, expect, it } from "vitest";
import { buildMonthGrid, bucketEventsByDay, resolveMonth } from "./month-grid";
import { addDaysToKey, zonedDateKey, zonedDayStart } from "./plain-date";
import type { Event } from "./types";

/**
 * The month grid of /events?view=month (WD02, datetime phase 2). Cells are
 * calendar days of APP_TIME_ZONE and the fetch window is made of that
 * zone's day starts; every input is a fixed ISO-Z instant, so the results
 * hold in every process zone `pnpm test:tz` runs (UTC, Europe/Berlin,
 * Pacific/Auckland).
 */

const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";
const TODAY = "2026-09-15";

let nextId = 1;
function event(start: string, end?: string | null, title = `e${nextId}`, allDay = false): Event {
  return { id: nextId++, title, start, end, allDay };
}

describe("resolveMonth", () => {
  it("reads a YYYY-MM param", () => {
    expect(resolveMonth("2027-02", TODAY)).toEqual({ year: 2027, month: 2 });
  });

  it.each([
    undefined,
    "",
    "2026-13",
    "2026-00",
    "2026-9",
    "26-09",
    "abc",
    "2026-09-01",
    "0050-01",
    "1899-12",
    "3000-01",
  ])("falls back to today's month for %j", (param) => {
    expect(resolveMonth(param, TODAY)).toEqual({ year: 2026, month: 9 });
  });

  it("takes today's month from the business-zone day, not from an instant", () => {
    // 2026-09-30T22:30Z is already 1 October in Berlin: the page passes that day.
    const today = zonedDateKey("2026-09-30T22:30:00.000Z", BERLIN);
    expect(today).toBe("2026-10-01");
    expect(resolveMonth(undefined, today)).toEqual({ year: 2026, month: 10 });
    expect(resolveMonth(undefined, zonedDateKey("2026-09-30T22:30:00.000Z", NEW_YORK))).toEqual({
      year: 2026,
      month: 9,
    });
  });
});

describe("buildMonthGrid", () => {
  it.each([
    // [param, leading days, cells, first cell, last cell]
    ["2026-06", 0, 35, "2026-06-01", "2026-07-05"], // starts on a Monday
    ["2026-09", 1, 35, "2026-08-31", "2026-10-04"], // starts on a Tuesday
    ["2026-02", 6, 35, "2026-01-26", "2026-03-01"], // starts on a Sunday
    ["2026-03", 6, 42, "2026-02-23", "2026-04-05"], // Sunday start, 31 days: six weeks
    ["2027-02", 0, 28, "2027-02-01", "2027-02-28"], // Monday start, 28 days: four weeks
    ["2028-02", 1, 35, "2028-01-31", "2028-03-05"], // leap February
  ])("%s: Monday-first, %i leading day(s), %i cells", (param, leading, cellCount, first, last) => {
    const grid = buildMonthGrid(param, TODAY, BERLIN);
    expect(grid.leading).toBe(leading);
    expect(grid.cells).toHaveLength(cellCount);
    expect(grid.cells[0]).toBe(first);
    expect(grid.cells.at(-1)).toBe(last);
    expect(grid.firstOfMonth).toBe(`${param}-01`);
    expect(grid.monthParam).toBe(param);
    // Consecutive calendar days, whatever the DST.
    grid.cells.forEach((cell, i) => expect(cell, `cell ${i}`).toBe(addDaysToKey(first, i)));
  });

  it("navigates across year boundaries", () => {
    expect(buildMonthGrid("2027-01", TODAY, BERLIN)).toMatchObject({
      prevMonthParam: "2026-12",
      nextMonthParam: "2027-02",
    });
    expect(buildMonthGrid("2026-12", TODAY, BERLIN)).toMatchObject({
      prevMonthParam: "2026-11",
      nextMonthParam: "2027-01",
    });
  });

  it("fetches [first instant of the first cell, first instant after the last cell) in the zone", () => {
    const grid = buildMonthGrid("2026-09", TODAY, BERLIN); // 2026-08-31 .. 2026-10-04
    expect(grid.from.toISOString()).toBe("2026-08-30T22:00:00.000Z");
    expect(grid.until.toISOString()).toBe("2026-10-04T22:00:00.000Z");
    const ny = buildMonthGrid("2026-09", TODAY, NEW_YORK);
    expect(ny.cells).toEqual(grid.cells);
    expect(ny.from.toISOString()).toBe("2026-08-31T04:00:00.000Z");
    expect(ny.until.toISOString()).toBe("2026-10-05T04:00:00.000Z");
  });

  it.each([
    // [param, zone, from, until]: the window crosses a DST change of the zone.
    ["2026-10", BERLIN, "2026-09-27T22:00:00.000Z", "2026-11-01T23:00:00.000Z"],
    ["2027-03", BERLIN, "2027-02-28T23:00:00.000Z", "2027-04-04T22:00:00.000Z"],
    ["2026-11", NEW_YORK, "2026-10-26T04:00:00.000Z", "2026-12-07T05:00:00.000Z"],
    ["2026-04", "Pacific/Auckland", "2026-03-29T11:00:00.000Z", "2026-05-03T12:00:00.000Z"],
  ])("%s in %s (a DST month): window %s .. %s", (param, zone, from, until) => {
    const grid = buildMonthGrid(param, TODAY, zone);
    expect(grid.from.toISOString()).toBe(from);
    expect(grid.until.toISOString()).toBe(until);
    expect(grid.from.getTime()).toBe(zonedDayStart(grid.cells[0]!, zone).getTime());
    expect(zonedDateKey(new Date(grid.until.getTime() - 1), zone)).toBe(grid.cells.at(-1));
  });

  it("uses today's month without a param", () => {
    expect(buildMonthGrid(undefined, TODAY, BERLIN)).toMatchObject({
      year: 2026,
      month: 9,
      firstOfMonth: "2026-09-01",
    });
  });
});

describe("bucketEventsByDay", () => {
  const grid = buildMonthGrid("2026-09", TODAY, BERLIN); // 2026-08-31 .. 2026-10-04

  const keysOf = (byDay: Map<string, Event[]>, e: Event) =>
    [...byDay].filter(([, events]) => events.includes(e)).map(([key]) => key);

  it("puts a single-day event on its day only", () => {
    const e = event("2026-09-10T07:00:00.000Z", "2026-09-10T08:00:00.000Z");
    expect(keysOf(bucketEventsByDay([e], grid, BERLIN), e)).toEqual(["2026-09-10"]);
  });

  it("buckets by the day in APP_TIME_ZONE: 23:30Z is already the next day in Berlin", () => {
    const e = event("2026-09-10T23:30:00.000Z");
    expect(keysOf(bucketEventsByDay([e], grid, BERLIN), e)).toEqual(["2026-09-11"]);
    expect(keysOf(bucketEventsByDay([e], grid, NEW_YORK), e)).toEqual(["2026-09-10"]);
  });

  it("puts a multi-day event on every day of its span", () => {
    const e = event("2026-09-29T16:00:00.000Z", "2026-10-01T06:00:00.000Z");
    expect(keysOf(bucketEventsByDay([e], grid, BERLIN), e)).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
    ]);
  });

  it("covers an all-day event from its start day through its end day in the zone", () => {
    // Entered as Berlin midnights: 2026-10-02 .. 2026-10-03.
    const e = event("2026-10-01T22:00:00.000Z", "2026-10-02T22:00:00.000Z", "offsite", true);
    expect(keysOf(bucketEventsByDay([e], grid, BERLIN), e)).toEqual(["2026-10-02", "2026-10-03"]);
  });

  it("clamps a span that starts before and ends after the grid to the visible cells", () => {
    const e = event("2026-08-01T07:00:00.000Z", "2026-11-30T16:00:00.000Z");
    const keys = keysOf(bucketEventsByDay([e], grid, BERLIN), e);
    expect(keys).toEqual(grid.cells);
  });

  it("covers a span across a DST change once per calendar day", () => {
    const october = buildMonthGrid("2026-10", TODAY, BERLIN);
    // 24 Oct 20:00 CEST .. 26 Oct 09:00 CET, over the 25-hour day.
    const e = event("2026-10-24T18:00:00.000Z", "2026-10-26T08:00:00.000Z");
    expect(keysOf(bucketEventsByDay([e], october, BERLIN), e)).toEqual([
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
    ]);
    const march = buildMonthGrid("2027-03", TODAY, BERLIN);
    const spring = event("2027-03-27T19:00:00.000Z", "2027-03-29T07:00:00.000Z");
    expect(keysOf(bucketEventsByDay([spring], march, BERLIN), spring)).toEqual([
      "2027-03-27",
      "2027-03-28",
      "2027-03-29",
    ]);
  });

  it("shows visible adjacent-month days too", () => {
    const e = event("2026-08-31T07:00:00.000Z", null);
    expect(keysOf(bucketEventsByDay([e], grid, BERLIN), e)).toEqual(["2026-08-31"]);
  });

  it("treats an end before the start, or an end that is no instant, as a one-day event", () => {
    const backwards = event("2026-09-10T07:00:00.000Z", "2026-09-08T07:00:00.000Z");
    const garbled = event("2026-09-11T07:00:00.000Z", "not a date");
    const offsetless = event("2026-09-12T07:00:00.000Z", "2026-09-14T07:00:00");
    const byDay = bucketEventsByDay([backwards, garbled, offsetless], grid, BERLIN);
    expect(keysOf(byDay, backwards)).toEqual(["2026-09-10"]);
    expect(keysOf(byDay, garbled)).toEqual(["2026-09-11"]);
    expect(keysOf(byDay, offsetless)).toEqual(["2026-09-12"]);
  });

  it("drops an event whose start is no instant, and one outside the grid", () => {
    const garbled = event("not a date");
    const offsetless = event("2026-09-10T09:00:00");
    const outside = event("2026-11-10T08:00:00.000Z");
    expect(bucketEventsByDay([garbled, offsetless, outside], grid, BERLIN).size).toBe(0);
  });

  it("sorts each day's bucket by start", () => {
    const late = event("2026-09-10T13:00:00.000Z", null, "late");
    const early = event("2026-09-10T06:00:00.000Z", null, "early");
    const spanning = event("2026-09-09T10:00:00.000Z", "2026-09-10T10:00:00.000Z", "spanning");
    const bucket = bucketEventsByDay([late, early, spanning], grid, BERLIN).get("2026-09-10");
    expect(bucket?.map((e) => e.title)).toEqual(["spanning", "early", "late"]);
  });
});
