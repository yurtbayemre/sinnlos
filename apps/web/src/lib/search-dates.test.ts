import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollClosesAtForDay } from "./poll-close";

/**
 * The ⌘K palette's dates (datetime contract, phase 2): the event preload
 * starts at the first instant of today in APP_TIME_ZONE, and the snippets
 * show days of that zone, whatever zone the process runs in. strapi() and
 * next-intl/server are mocked (search.test.ts covers the rest).
 */
const strapiMock = vi.fn<(path: string) => Promise<unknown>>();

vi.mock("@/lib/strapi", () => ({ strapi: (path: string) => strapiMock(path) }));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations: async () => (key: string, values?: { date?: string }) =>
    key === "pollCloses" ? `Closes ${values?.date}` : key,
}));

const { loadPreload, searchFormatFor } = await import("./search-action");

const labels = {
  pollCloses: (date: string) => `closes ${date}`,
  pollOpen: "open",
  unknown: "?",
};

beforeEach(() => {
  strapiMock.mockReset();
  strapiMock.mockResolvedValue({ data: [] });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("event preload window", () => {
  it.each([
    // [now, APP_TIME_ZONE, first instant of today there]
    ["2026-10-24T22:30:00.000Z", "Europe/Berlin", "2026-10-24T22:00:00.000Z"], // 25 Oct, the 25-hour day
    ["2026-10-24T21:30:00.000Z", "Europe/Berlin", "2026-10-23T22:00:00.000Z"],
    ["2027-03-28T12:00:00.000Z", "Europe/Berlin", "2027-03-27T23:00:00.000Z"], // the 23-hour day
    ["2026-10-24T22:30:00.000Z", "America/New_York", "2026-10-24T04:00:00.000Z"],
  ])("at %s in %s starts at %s", async (now, zone, from) => {
    vi.stubEnv("APP_TIME_ZONE", zone);
    await loadPreload("event", new Date(now));
    expect(strapiMock).toHaveBeenCalledTimes(1);
    expect(decodeURIComponent(strapiMock.mock.calls[0]![0])).toContain(`filters[start][$gte]=${from}&`);
  });
});

describe("snippet dates", () => {
  it("shows an event's day in APP_TIME_ZONE: 23:30Z is already the next day in Berlin", () => {
    const start = "2026-09-30T23:30:00.000Z";
    expect(searchFormatFor("en", "Europe/Berlin", labels).eventDate(start)).toBe("Oct 1, 2026");
    expect(searchFormatFor("de", "Europe/Berlin", labels).eventDate(start)).toBe("1. Okt. 2026");
    expect(searchFormatFor("en", "America/New_York", labels).eventDate(start)).toBe("Sep 30, 2026");
  });

  it("shows a poll's closing day as the day the form chose", () => {
    // "Closes on 25 Oct" = 25 Oct 23:59:59 in APP_TIME_ZONE, 22:59:59Z after the change back.
    const closesAt = pollClosesAtForDay("2026-10-25", "Europe/Berlin");
    expect(closesAt).toBe("2026-10-25T22:59:59.000Z");
    expect(searchFormatFor("de", "Europe/Berlin", labels).pollCloses(closesAt!)).toBe("closes 25.10.2026");
    expect(searchFormatFor("en", "Europe/Berlin", labels).pollCloses(closesAt!)).toBe("closes 10/25/2026");
  });

  it("has no date for a value that is no instant", () => {
    const format = searchFormatFor("en", "Europe/Berlin", labels);
    for (const value of ["2026-10-01T12:00:00", "2026-10-01", "garbage", ""]) {
      expect(format.eventDate(value), value).toBeUndefined();
      expect(format.pollCloses(value), value).toBeUndefined();
    }
  });
});
