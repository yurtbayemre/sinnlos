/**
 * Events and their RSVP summaries (WD01). Uncached (D-DC01).
 *
 * Time-window fetches instead of one global list: a plain
 * sort=start:asc&pageSize=50 returns the 50 OLDEST events and starves the
 * calendar once history grows. Callers pass the first instant of today in
 * APP_TIME_ZONE (plain-date.zonedDayStart) and now, both ISO-Z, so events
 * that began earlier today still count as upcoming.
 *
 * The `organizer` user relation is field-limited to displayName — the only
 * organizer field any events consumer renders (`organizedBy { name }`). No
 * sensitive user field enters the payload (data minimisation, issue #10 /
 * F1). No departments populate (WD05): no events consumer renders them.
 */
import { strapi, type StrapiListResponse } from "@/lib/strapi/client";
import { strapiQuery, withQuery, type StrapiQuery } from "@/lib/strapi/query";
import type { Event, UserLite } from "@/lib/types";

/** An event of a list: own fields, the organizer's display name only. */
export type EventListItem = Omit<Event, "organizer" | "departments"> & {
  organizer?: Pick<UserLite, "id" | "displayName"> | null;
};

/** Most event documentIds per RSVP summary request (the cms caps it at 50). */
const RSVP_SUMMARY_CHUNK = 50;

/**
 * The /events list split (FX49). "Running": a timed event whose end is
 * still ahead (end >= now), or an all-day event whose last day is today or
 * later (end >= the start of today; all-day days are the APP_TIME_ZONE days
 * of start through end, decision 04 C7, and its end may be any time on its
 * last day). Upcoming = started today or later, or running. Past = the
 * exact complement: started before today and not running, spelled out for
 * SQL's three-valued logic: no end, an end before today, or an end before
 * now on an event that is not all-day (allDay false, or NULL on rows older
 * than the attribute). Both take ISO-Z instants.
 */
function upcomingFilter(startOfTodayIso: string, nowIso: string): StrapiQuery {
  return strapiQuery()
    .filter(["$or", 0, "start"], "$gte", startOfTodayIso)
    .filter(["$or", 1, "end"], "$gte", nowIso)
    .filter(["$or", 2, "allDay"], "$eq", true)
    .filter(["$or", 2, "end"], "$gte", startOfTodayIso);
}

function pastFilter(startOfTodayIso: string, nowIso: string): StrapiQuery {
  return strapiQuery()
    .filter("start", "$lt", startOfTodayIso)
    .filter(["$or", 0, "end"], "$null", true)
    .filter(["$or", 1, "end"], "$lt", startOfTodayIso)
    .filter(["$or", 2, "end"], "$lt", nowIso)
    .filter(["$or", 2, "allDay"], "$eq", false)
    .filter(["$or", 3, "end"], "$lt", nowIso)
    .filter(["$or", 3, "allDay"], "$null", true);
}

/** The upcoming filter as a query string (search preload, tests). */
export function eventsUpcomingFilter(startOfTodayIso: string, nowIso: string): string {
  return upcomingFilter(startOfTodayIso, nowIso).toString();
}

/** The past filter as a query string, the exact complement of the upcoming one. */
export function eventsPastFilter(startOfTodayIso: string, nowIso: string): string {
  return pastFilter(startOfTodayIso, nowIso).toString();
}

/**
 * Upcoming events, soonest first: start >= the start of today, OR still
 * running (FX49): a timed event whose end is still ahead, an all-day event
 * whose last day is today or later (C7: its days run through the day of
 * its end). Before, a multi-day event dropped under "Past" on its second
 * day. pageSize=50 is a deliberate feed/render cap (issue #26) — counts
 * must come from `meta.pagination.total`, never `data.length` (see the
 * dashboard).
 */
export function upcomingEvents(
  startOfTodayIso: string,
  nowIso: string,
): Promise<StrapiListResponse<EventListItem>> {
  return strapi<StrapiListResponse<EventListItem>>(
    withQuery(
      "/api/events",
      upcomingFilter(startOfTodayIso, nowIso)
        .populateFields("organizer", ["displayName"])
        .sortBy("start:asc")
        .pageSize(50),
    ),
  );
}

/**
 * The most recent past events, newest first — the list view shows only
 * this small tail of history: started before today and not running, the
 * exact complement of upcomingEvents (no event is listed twice, none is
 * lost).
 */
export function pastEvents(
  startOfTodayIso: string,
  nowIso: string,
  limit = 10,
): Promise<StrapiListResponse<EventListItem>> {
  return strapi<StrapiListResponse<EventListItem>>(
    withQuery(
      "/api/events",
      pastFilter(startOfTodayIso, nowIso)
        .populateFields("organizer", ["displayName"])
        .sortBy("start:desc")
        .pageSize(limit),
    ),
  );
}

/**
 * Events overlapping the half-open window [from, to) for the month grid —
 * multi-day spans included: start < window end AND (end ?? start) >= window
 * start ($or handles the nullable end). pageSize=100 is a deliberate render
 * cap (issue #26): a single month with >100 events would drop entries from
 * the grid, with no truncated signal on this path — accepted as far beyond
 * realistic volume.
 */
export function eventsInWindow(
  fromIso: string,
  toIso: string,
): Promise<StrapiListResponse<EventListItem>> {
  return strapi<StrapiListResponse<EventListItem>>(
    withQuery(
      "/api/events",
      strapiQuery()
        .filter("start", "$lt", toIso)
        .filter(["$or", 0, "end"], "$gte", fromIso)
        .filter(["$or", 1, "end"], "$null", true)
        .filter(["$or", 1, "start"], "$gte", fromIso)
        .populateFields("organizer", ["displayName"])
        .sortBy("start:asc")
        .pageSize(100),
    ),
  );
}

/**
 * RSVP summaries for a set of events (FX21): the CMS aggregates the
 * counts, the "yes" names and the caller's own answer
 * (GET /api/event-rsvps/summary), so no RSVP row and no decliner name
 * reaches the web; this replaced a walk of up to 3000 rows per view.
 * Per-user (myStatus). Guests never call this (no summary grant — the page
 * skips the fetch). The endpoint takes at most 50 targets per request; the
 * events list shows at most 50, so this is one request, chunked only as a
 * safeguard. The rows stay `unknown` until lib/event-rsvp.ts
 * rsvpSummaryMap checks them.
 */
export async function rsvpSummaries(documentIds: string[]): Promise<{ data: unknown[] }> {
  const chunks: string[][] = [];
  for (let i = 0; i < documentIds.length; i += RSVP_SUMMARY_CHUNK) {
    chunks.push(documentIds.slice(i, i + RSVP_SUMMARY_CHUNK));
  }
  const pages = await Promise.all(
    chunks.map((chunk) =>
      strapi<{ data?: unknown }>(
        withQuery("/api/event-rsvps/summary", strapiQuery().list("targets", chunk)),
      ),
    ),
  );
  return { data: pages.flatMap((page) => (Array.isArray(page?.data) ? page.data : [])) };
}
