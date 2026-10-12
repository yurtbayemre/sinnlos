import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrapiError } from "@/lib/strapi-error";

/**
 * WD03: the /events view-model (list and month) from mocked reads; the
 * month grid and the RSVP summary mapping are the real modules. Snapshots
 * per scenario: success, partial failure, truncation, CMS down.
 */
const reads = {
  upcoming: vi.fn<(from: string, now: string) => Promise<unknown>>(),
  past: vi.fn<(from: string, now: string) => Promise<unknown>>(),
  window: vi.fn<(from: string, to: string) => Promise<unknown>>(),
  rsvps: vi.fn<(ids: string[]) => Promise<unknown>>(),
};

vi.mock("@/lib/strapi", () => ({
  api: {
    events: {
      upcoming: (from: string, now: string) => reads.upcoming(from, now),
      past: (from: string, now: string) => reads.past(from, now),
      window: (from: string, to: string) => reads.window(from, to),
      rsvpSummaries: (ids: string[]) => reads.rsvps(ids),
    },
  },
}));

const { loadEvents } = await import("./events");

/** Monday 2026-09-28, 10:00 UTC = 12:00 in Berlin. */
const NOW = new Date("2026-09-28T10:00:00.000Z");
const ZONE = "Europe/Berlin";
const MEMBER = { userId: 7, role: "member" };

const event = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  documentId: `evt-${id}`,
  title: `Event ${id}`,
  start: `2026-09-${String(27 + id).padStart(2, "0")}T08:00:00.000Z`,
  end: null,
  allDay: false,
  location: "HQ",
  organizer: { id: 3, displayName: "Ada" },
  ...extra,
});
const list = (rows: unknown[], total = rows.length) => ({
  data: rows,
  meta: { pagination: { page: 1, pageSize: 50, pageCount: 1, total } },
});
const UPCOMING = list([event(1, { rsvpEnabled: true }), event(2), event(3, { rsvpEnabled: true })]);
const PAST = list([event(-1, { start: "2026-09-20T08:00:00.000Z" })]);
const SUMMARIES = {
  data: [
    {
      targetDocumentId: "evt-1",
      yesNames: ["Ada"],
      yesCount: 1,
      maybeCount: 2,
      noCount: 0,
      myStatus: "yes",
    },
    { targetDocumentId: "evt-3", yesCount: "broken" },
  ],
};
const outage = () => new StrapiError(502, "Bad Gateway", "");

beforeEach(() => {
  reads.upcoming.mockReset().mockResolvedValue(UPCOMING);
  reads.past.mockReset().mockResolvedValue(PAST);
  reads.window.mockReset().mockResolvedValue(list([event(1), event(2)]));
  reads.rsvps.mockReset().mockResolvedValue(SUMMARIES);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadEvents: list", () => {
  it("success: upcoming with RSVP summaries where the caller may answer, past without", async () => {
    const view = await loadEvents({}, MEMBER, NOW, ZONE);
    expect(reads.upcoming).toHaveBeenCalledWith(
      "2026-09-27T22:00:00.000Z",
      "2026-09-28T10:00:00.000Z",
    );
    expect(reads.rsvps).toHaveBeenCalledWith(["evt-1", "evt-3"]);
    if (view.mode !== "list") throw new Error("list view expected");
    expect(view.upcoming.map((u) => u.rsvp?.yesCount ?? null)).toEqual([1, null, 0]);
    expect(view).toMatchSnapshot();
  });

  it("partial failure: summaries down hide the RSVP panels instead of showing zeros", async () => {
    reads.rsvps.mockRejectedValue(outage());
    const view = await loadEvents({}, MEMBER, NOW, ZONE);
    if (view.mode !== "list") throw new Error("list view expected");
    expect(view.failed).toBe(true);
    expect(view.upcoming.map((u) => u.rsvp)).toEqual([null, null, null]);
    expect(view.upcoming).toHaveLength(3);
    expect(view).toMatchSnapshot();
  });

  it("partial failure: past down keeps the upcoming list", async () => {
    reads.past.mockRejectedValue(outage());
    const view = await loadEvents({}, MEMBER, NOW, ZONE);
    if (view.mode !== "list") throw new Error("list view expected");
    expect(view).toMatchObject({ failed: true, empty: false, past: [] });
    expect(view.upcoming).toHaveLength(3);
  });

  it("truncated: more upcoming events than the capped read holds", async () => {
    reads.upcoming.mockResolvedValue(list([event(1)], 51));
    const view = await loadEvents({}, MEMBER, NOW, ZONE);
    expect(view.truncated).toBe(true);
    expect(view.failed).toBe(false);
    expect(view).toMatchSnapshot();
  });

  it("CMS down: failed, no cards, no empty state", async () => {
    reads.upcoming.mockRejectedValue(outage());
    reads.past.mockRejectedValue(outage());
    const view = await loadEvents({}, MEMBER, NOW, ZONE);
    expect(view).toMatchSnapshot();
    expect(view).toMatchObject({
      mode: "list",
      failed: true,
      empty: false,
      upcoming: [],
      past: [],
    });
    expect(reads.rsvps).not.toHaveBeenCalled();
  });

  it("no events at all is the empty state", async () => {
    reads.upcoming.mockResolvedValue(list([]));
    reads.past.mockResolvedValue(list([]));
    await expect(loadEvents({}, MEMBER, NOW, ZONE)).resolves.toMatchObject({
      empty: true,
      failed: false,
    });
  });

  it.each([
    ["a guest", { userId: 7, role: "guest" }],
    ["an unreadable role", { userId: 7, role: null }],
    ["a render without a user", { userId: null, role: "member" }],
  ])("%s gets no RSVP read and no panel", async (_name, viewer) => {
    const view = await loadEvents({}, viewer, NOW, ZONE);
    expect(reads.rsvps).not.toHaveBeenCalled();
    if (view.mode !== "list") throw new Error("list view expected");
    expect(view.upcoming.every((u) => u.rsvp === null)).toBe(true);
  });
});

describe("loadEvents: month", () => {
  it("success: the visible grid window, its events", async () => {
    const view = await loadEvents({ view: "month", month: "2026-10" }, MEMBER, NOW, ZONE);
    // October 2026 in Berlin: Monday 28 September .. Sunday 1 November.
    expect(reads.window).toHaveBeenCalledWith(
      "2026-09-27T22:00:00.000Z",
      "2026-11-01T23:00:00.000Z",
    );
    expect(reads.upcoming).not.toHaveBeenCalled();
    if (view.mode !== "month") throw new Error("month view expected");
    expect(view.grid.monthParam).toBe("2026-10");
    expect(view.events).toHaveLength(2);
    expect(view).toMatchObject({ failed: false, truncated: false, today: "2026-09-28" });
  });

  it("CMS down: the grid stays, no events, the banner", async () => {
    reads.window.mockRejectedValue(outage());
    const view = await loadEvents({ view: "month" }, MEMBER, NOW, ZONE);
    if (view.mode !== "month") throw new Error("month view expected");
    expect(view).toMatchObject({ failed: true, events: [] });
    expect(view.grid.monthParam).toBe("2026-09");
  });

  it("truncated: a window with more than the capped 100 events", async () => {
    reads.window.mockResolvedValue(list([event(1)], 140));
    await expect(loadEvents({ view: "month" }, MEMBER, NOW, ZONE)).resolves.toMatchObject({
      truncated: true,
    });
  });
});

describe("control flow", () => {
  it("never swallows the expired-session redirect of a read", async () => {
    const expired = (() => {
      try {
        redirect("/sign-in?expired=1");
      } catch (e) {
        return e;
      }
    })();
    reads.rsvps.mockRejectedValue(expired);
    await expect(loadEvents({}, MEMBER, NOW, ZONE)).rejects.toBe(expired);
  });
});
