import { createFormatter } from "next-intl";
import { describe, expect, it } from "vitest";
import { eventBadge, eventTimeLabel } from "./event-dates";

/**
 * The dates of an /events card (datetime phase 2, FX49), rendered with
 * next-intl's own formatter in the zone i18n/request.ts configures. Fixed
 * ISO-Z instants: the labels are the same in every process zone.
 */
const BERLIN = "Europe/Berlin";
const NEW_YORK = "America/New_York";
const de = createFormatter({ locale: "de", timeZone: BERLIN });
const en = createFormatter({ locale: "en", timeZone: BERLIN });
const deNewYork = createFormatter({ locale: "de", timeZone: NEW_YORK });

describe("eventTimeLabel", () => {
  it("shows a timed event's day and time, and only the end time on the same day", () => {
    expect(eventTimeLabel({ start: "2026-10-05T07:00:00.000Z" }, de, BERLIN)).toBe(
      "Mo., 5. Okt. 2026, 09:00",
    );
    expect(
      eventTimeLabel(
        { start: "2026-10-05T07:00:00.000Z", end: "2026-10-05T15:00:00.000Z" },
        de,
        BERLIN,
      ),
    ).toBe("Mo., 5. Okt. 2026, 09:00 – 17:00");
  });

  it("adds the end day when a timed event ends on another calendar day (FX49)", () => {
    expect(
      eventTimeLabel(
        { start: "2026-10-05T07:00:00.000Z", end: "2026-10-07T15:00:00.000Z" },
        de,
        BERLIN,
      ),
    ).toBe("Mo., 5. Okt. 2026, 09:00 – Mi., 7. Okt. 2026, 17:00");
  });

  it("compares calendar days in APP_TIME_ZONE, not in UTC", () => {
    // 22:00 to 01:00 in Berlin crosses midnight there; in New York it is 16:00 to 19:00.
    const late = { start: "2026-10-05T20:00:00.000Z", end: "2026-10-05T23:00:00.000Z" };
    expect(eventTimeLabel(late, de, BERLIN)).toBe(
      "Mo., 5. Okt. 2026, 22:00 – Di., 6. Okt. 2026, 01:00",
    );
    expect(eventTimeLabel(late, deNewYork, NEW_YORK)).toBe("Mo., 5. Okt. 2026, 16:00 – 19:00");
    // 23:30Z on 30 Sep is already 1 Oct, 01:30 in Berlin.
    expect(eventTimeLabel({ start: "2026-09-30T23:30:00.000Z" }, de, BERLIN)).toBe(
      "Do., 1. Okt. 2026, 01:30",
    );
  });

  it("shows an all-day event's day, and its last day when it spans several", () => {
    // Entered as Berlin midnights.
    expect(
      eventTimeLabel(
        { start: "2026-10-04T22:00:00.000Z", end: "2026-10-04T22:00:00.000Z", allDay: true },
        de,
        BERLIN,
      ),
    ).toBe("Mo., 5. Okt. 2026");
    expect(
      eventTimeLabel({ start: "2026-10-04T22:00:00.000Z", end: null, allDay: true }, de, BERLIN),
    ).toBe("Mo., 5. Okt. 2026");
    expect(
      eventTimeLabel(
        { start: "2026-10-04T22:00:00.000Z", end: "2026-10-06T22:00:00.000Z", allDay: true },
        de,
        BERLIN,
      ),
    ).toBe("Mo., 5. Okt. 2026 – Mi., 7. Okt. 2026");
    // Across the DST change: 24 Oct (CEST) through 26 Oct (CET).
    expect(
      eventTimeLabel(
        { start: "2026-10-23T22:00:00.000Z", end: "2026-10-25T23:00:00.000Z", allDay: true },
        en,
        BERLIN,
      ),
    ).toBe("Sat, Oct 24, 2026 – Mon, Oct 26, 2026");
  });

  it("leaves out an end that is no instant or not after the start, and renders nothing for a bad start", () => {
    const start = "2026-10-05T07:00:00.000Z";
    for (const end of ["2026-10-05T06:00:00.000Z", start, "2026-10-05T12:00:00", "garbage", ""]) {
      expect(eventTimeLabel({ start, end }, de, BERLIN), end).toBe("Mo., 5. Okt. 2026, 09:00");
    }
    expect(eventTimeLabel({ start: "2026-10-05T09:00:00" }, de, BERLIN)).toBe("");
    expect(eventTimeLabel({ start: "not a date" }, de, BERLIN)).toBe("");
  });
});

describe("eventBadge", () => {
  it("names the month and day of the start in APP_TIME_ZONE", () => {
    const start = "2026-09-30T23:30:00.000Z";
    expect(eventBadge({ start }, de, BERLIN)).toEqual({ month: "Okt", day: 1 });
    expect(eventBadge({ start }, en, BERLIN)).toEqual({ month: "Oct", day: 1 });
    expect(eventBadge({ start }, deNewYork, NEW_YORK)).toEqual({ month: "Sep", day: 30 });
    expect(eventBadge({ start: "garbage" }, de, BERLIN)).toBeNull();
  });
});
