import { describe, expect, it } from "vitest";

import { icsEventDateLines } from "./ics-dates";

const NOW = "2026-09-24T08:15:30.123Z";
const BERLIN = "Europe/Berlin";

describe("icsEventDateLines", () => {
  it("writes timed events in UTC with Z (DTEND = DTSTART without an end)", () => {
    expect(icsEventDateLines({ start: "2026-10-01T10:00:00.000Z" }, NOW, BERLIN)).toEqual([
      "DTSTAMP:20260924T081530Z",
      "DTSTART:20261001T100000Z",
      "DTEND:20261001T100000Z",
    ]);
    expect(
      icsEventDateLines(
        { start: "2026-10-01T10:00:00.000Z", end: "2026-10-01T11:30:00.000Z", allDay: false },
        NOW,
        BERLIN,
      ),
    ).toEqual(["DTSTAMP:20260924T081530Z", "DTSTART:20261001T100000Z", "DTEND:20261001T113000Z"]);
  });

  it("writes an all-day event as VALUE=DATE with an exclusive DTEND", () => {
    // Entered as local midnight in Berlin (22:00Z the day before).
    expect(icsEventDateLines({ start: "2026-09-30T22:00:00.000Z", allDay: true }, NOW, BERLIN)).toEqual([
      "DTSTAMP:20260924T081530Z",
      "DTSTART;VALUE=DATE:20261001",
      "DTEND;VALUE=DATE:20261002",
    ]);
  });

  it("covers every day of a multi-day all-day event across the DST change", () => {
    // Sat 2026-10-24 00:00 CEST to Mon 2026-10-26 00:00 CET, inclusive days.
    const lines = icsEventDateLines(
      { start: "2026-10-23T22:00:00.000Z", end: "2026-10-25T23:00:00.000Z", allDay: true },
      NOW,
      BERLIN,
    );
    expect(lines.slice(1)).toEqual(["DTSTART;VALUE=DATE:20261024", "DTEND;VALUE=DATE:20261027"]);
  });

  it("takes the days in the business zone, not in UTC", () => {
    const event = { start: "2026-10-01T02:00:00.000Z", allDay: true };
    expect(icsEventDateLines(event, NOW, BERLIN)[1]).toBe("DTSTART;VALUE=DATE:20261001");
    expect(icsEventDateLines(event, NOW, "America/New_York")[1]).toBe("DTSTART;VALUE=DATE:20260930");
  });

  it("never ends an all-day event before it starts", () => {
    const lines = icsEventDateLines(
      { start: "2026-10-05T10:00:00.000Z", end: "2026-10-01T10:00:00.000Z", allDay: true },
      NOW,
      BERLIN,
    );
    expect(lines.slice(1)).toEqual(["DTSTART;VALUE=DATE:20261005", "DTEND;VALUE=DATE:20261006"]);
  });
});
