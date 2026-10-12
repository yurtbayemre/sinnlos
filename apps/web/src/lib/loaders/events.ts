import type { EventListItem } from "@/lib/api/events";
import { EMPTY_RSVP_SUMMARY, rsvpSummaryMap } from "@/lib/event-rsvp";
import { buildMonthGrid, type MonthGrid } from "@/lib/month-grid";
import { zonedDateKey, zonedDayStart } from "@/lib/plain-date";
import { canRsvp as roleCanRsvp } from "@/lib/roles";
import { SKIPPED_READ, tryFetch } from "@/lib/safe-fetch";
import { api } from "@/lib/strapi";
import type { EventRsvpSummary } from "@/lib/types";
import { listTotal, type CountedList } from "./count";

/**
 * The /events page (WD03). Time-window reads (lib/api/events.ts): a global
 * "first 50 by start" list would show the 50 OLDEST events forever. The
 * list view reads the upcoming events (from the first instant of today,
 * or still running; soonest first) plus a short tail of past ones; the
 * month view reads exactly the visible grid window. "Today" and every
 * window are APP_TIME_ZONE days (datetime contract, phase 2).
 */

type Role = string | null | undefined;

/** One upcoming card: the event and, where the caller may answer, its RSVP summary. */
export interface UpcomingEvent {
  event: EventListItem;
  /** null: no RSVP panel (RSVP off, a role without the grant, or the summaries could not be read). */
  rsvp: EventRsvpSummary | null;
}

interface EventsCommon {
  /** 'YYYY-MM-DD' of today in APP_TIME_ZONE. */
  today: string;
  /** A read failed: the CMS-down banner. */
  failed: boolean;
  /**
   * A capped read (upcoming: 50, month window: 100) holds fewer rows than
   * its total: events are missing from the page.
   */
  truncated: boolean;
}

export type EventsView =
  | (EventsCommon & { mode: "month"; grid: MonthGrid; events: EventListItem[] })
  | (EventsCommon & {
      mode: "list";
      upcoming: UpcomingEvent[];
      /** The most recent past events, newest first (no RSVP). */
      past: EventListItem[];
      /**
       * The list read answered and holds no event: the empty state. Never
       * set when it failed (the banner says so instead).
       */
      empty: boolean;
    });

/** More rows exist than the capped read returned. */
function cut(list: (CountedList & { data?: unknown[] | null }) | null): boolean {
  return !!list && listTotal(list) > (list.data?.length ?? 0);
}

/**
 * Everything /events renders. `viewer` gates the RSVP summaries: guests
 * hold no event-rsvp grant (the read would answer 403), and the gate is
 * the fail-closed allowlist of lib/roles.ts canRsvp; a signed-out render
 * (no user id) has none either.
 */
export async function loadEvents(
  query: { view?: string; month?: string },
  viewer: { userId: number | null; role: Role },
  now: Date,
  timeZone: string,
): Promise<EventsView> {
  const today = zonedDateKey(now, timeZone);

  if (query.view === "month") {
    const grid = buildMonthGrid(query.month, today, timeZone);
    const res = await tryFetch(
      () => api.events.window(grid.from.toISOString(), grid.until.toISOString()),
      "events",
    );
    return {
      mode: "month",
      grid,
      events: res.data?.data ?? [],
      today,
      failed: res.failed,
      truncated: cut(res.data),
    };
  }

  const startOfToday = zonedDayStart(today, timeZone).toISOString();
  const nowIso = now.toISOString();
  const [upcomingRes, pastRes] = await Promise.all([
    tryFetch(() => api.events.upcoming(startOfToday, nowIso), "events"),
    tryFetch(() => api.events.past(startOfToday, nowIso), "events-past"),
  ]);
  const upcoming = upcomingRes.data?.data ?? [];
  const past = pastRes.data?.data ?? [];

  // RSVPs show on UPCOMING cards only; the CMS aggregates them per event
  // (FX21): counts, the "yes" names and the caller's own answer.
  const canRsvp = viewer.userId !== null && roleCanRsvp(viewer.role);
  const answerable = (e: EventListItem): e is EventListItem & { documentId: string } =>
    canRsvp && !!e.rsvpEnabled && typeof e.documentId === "string";
  const rsvpDocIds = [...new Set(upcoming.filter(answerable).map((e) => e.documentId))];
  const rsvpRes =
    rsvpDocIds.length > 0
      ? await tryFetch(() => api.events.rsvpSummaries(rsvpDocIds), "event-rsvps")
      : SKIPPED_READ;
  const summaries = rsvpSummaryMap(rsvpRes.data?.data ?? []);

  return {
    mode: "list",
    upcoming: upcoming.map((event) => ({
      event,
      // Without the summaries the panel would claim nobody has answered.
      rsvp:
        answerable(event) && !rsvpRes.failed
          ? (summaries.get(event.documentId) ?? EMPTY_RSVP_SUMMARY)
          : null,
    })),
    past,
    empty: !upcomingRes.failed && !pastRes.failed && upcoming.length === 0 && past.length === 0,
    today,
    failed: upcomingRes.failed || pastRes.failed || rsvpRes.failed,
    truncated: cut(upcomingRes.data),
  };
}
