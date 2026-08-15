import Link from "next/link";
import { Calendar, CalendarDays, Clock, Download, List, MapPin } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { api } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import type { Event, EventRsvp, EventRsvpSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { EventRsvpPanel } from "@/components/events/event-rsvp-panel";
import { EventsMonthView, monthGridRange } from "@/components/events/events-month-view";

export async function generateMetadata() {
  const t = await getTranslations("events");
  return { title: t("title") };
}

function formatDate(iso: string, allDay?: boolean) {
  const d = new Date(iso);
  if (allDay) {
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Collapse the raw RSVP rows into one summary per event documentId.
 * Dedupe per (event, user) keeping the LATEST respondedAt: the CMS accepts
 * a benign create race that can leave duplicate rows per user, so counting
 * rows directly would overstate the buckets.
 */
function buildRsvpSummaries(
  rows: EventRsvp[],
  myUserId: number | null,
): Map<string, EventRsvpSummary> {
  const latest = new Map<string, EventRsvp>();
  for (const row of rows) {
    if (!row.targetDocumentId) continue;
    const key = `${row.targetDocumentId}:${row.user?.id ?? `row-${row.id}`}`;
    const prev = latest.get(key);
    const rowTime = row.respondedAt ? new Date(row.respondedAt).getTime() : 0;
    const prevTime = prev?.respondedAt ? new Date(prev.respondedAt).getTime() : 0;
    if (!prev || rowTime >= prevTime) latest.set(key, row);
  }

  const map = new Map<string, EventRsvpSummary>();
  for (const row of latest.values()) {
    let summary = map.get(row.targetDocumentId);
    if (!summary) {
      summary = { yesNames: [], yesCount: 0, maybeCount: 0, noCount: 0, myStatus: null };
      map.set(row.targetDocumentId, summary);
    }
    if (row.status === "yes") {
      summary.yesCount += 1;
      if (row.user?.displayName) summary.yesNames.push(row.user.displayName);
    } else if (row.status === "maybe") summary.maybeCount += 1;
    else if (row.status === "no") summary.noCount += 1;
    if (myUserId != null && row.user?.id === myUserId) summary.myStatus = row.status;
  }
  return map;
}

const EMPTY_SUMMARY: EventRsvpSummary = {
  yesNames: [],
  yesCount: 0,
  maybeCount: 0,
  noCount: 0,
  myStatus: null,
};

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; month?: string }>;
}) {
  const { view, month } = await searchParams;
  const isMonthView = view === "month";

  const [t, session] = await Promise.all([getTranslations("events"), auth()]);

  // Time-window fetches (see api.events): a global "first 50 by start asc"
  // list would show the 50 OLDEST events forever. The list view gets all
  // upcoming events (start >= local start of today, soonest first) plus a
  // short tail of the most recent past ones; the month view fetches exactly
  // the visible grid window including overlapping multi-day events.
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let upcoming: Event[] = [];
  let past: Event[] = [];
  let monthEvents: Event[] = [];
  let failed = false;
  if (isMonthView) {
    const range = monthGridRange(month, now);
    const res = await tryFetch(
      () => api.events.window(range.from.toISOString(), range.until.toISOString()),
      "events",
    );
    monthEvents = (res.data?.data ?? []) as Event[];
    failed = res.failed;
  } else {
    const [upcomingRes, pastRes] = await Promise.all([
      tryFetch(() => api.events.upcoming(startOfToday.toISOString()), "events"),
      tryFetch(() => api.events.past(startOfToday.toISOString()), "events-past"),
    ]);
    upcoming = (upcomingRes.data?.data ?? []) as Event[];
    past = (pastRes.data?.data ?? []) as Event[];
    failed = upcomingRes.failed || pastRes.failed;
  }

  const userId = typeof session?.user?.id === "number" ? session.user.id : null;
  // Guests hold no event-rsvp grants — skip the fetch instead of running
  // into a 403 error banner (marketplace canCreate pattern).
  const canRsvp = userId != null && session?.user?.role !== "guest";
  const selfName = session?.user?.name ?? null;

  // RSVPs are only rendered in the list view and only on UPCOMING cards;
  // the month view shows compact chips without attendance.
  const rsvpDocIds = isMonthView
    ? []
    : [
        ...new Set(
          upcoming
            .filter((e) => e.rsvpEnabled && typeof e.documentId === "string")
            .map((e) => e.documentId as string),
        ),
      ];
  const rsvpResult =
    canRsvp && rsvpDocIds.length > 0
      ? await tryFetch(() => api.events.rsvps(rsvpDocIds), "event-rsvps")
      : { data: null, failed: false };
  const summaries = buildRsvpSummaries(
    (rsvpResult.data?.data ?? []) as EventRsvp[],
    userId,
  );
  const anyFailed = failed || rsvpResult.failed;

  const switchLinkClass = (active: boolean) =>
    cn(
      "inline-flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-sm font-medium transition",
      active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
    );

  return (
    <div className="space-y-8">
      <PageHeader title={t("title")} description={t("description")}>
        <div role="group" aria-label={t("viewLabel")} className="inline-flex rounded-xl border p-0.5">
          <Link
            href="/events"
            aria-current={!isMonthView ? "page" : undefined}
            className={switchLinkClass(!isMonthView)}
          >
            <List className="h-4 w-4" aria-hidden="true" />
            {t("viewList")}
          </Link>
          <Link
            href="/events?view=month"
            aria-current={isMonthView ? "page" : undefined}
            className={switchLinkClass(isMonthView)}
          >
            <CalendarDays className="h-4 w-4" aria-hidden="true" />
            {t("viewMonth")}
          </Link>
        </div>
      </PageHeader>

      {anyFailed && <FetchErrorBanner />}

      {isMonthView ? (
        <EventsMonthView events={monthEvents} monthParam={month} />
      ) : upcoming.length === 0 && past.length === 0 ? (
        <EmptyState icon={Calendar} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        <>
          {upcoming.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Calendar className="h-3.5 w-3.5" />
                {t("upcoming")}
              </div>
              <div className="stagger space-y-3">
                {upcoming.map((e) => (
                  <EventCard
                    key={e.id}
                    event={e}
                    t={t}
                    rsvp={
                      canRsvp && e.rsvpEnabled && typeof e.documentId === "string"
                        ? {
                            summary: summaries.get(e.documentId) ?? EMPTY_SUMMARY,
                            selfName,
                          }
                        : null
                    }
                  />
                ))}
              </div>
            </section>
          )}

          {past.length > 0 && (
            <section className="space-y-3">
              <div className="text-sm font-medium text-muted-foreground">{t("past")}</div>
              <div className="stagger space-y-3">
                {past.map((e) => (
                  <EventCard key={e.id} event={e} muted t={t} rsvp={null} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function EventCard({
  event,
  muted = false,
  t,
  rsvp,
}: {
  event: Event;
  muted?: boolean;
  t: (key: string, values?: Record<string, string>) => string;
  /** null = no RSVP UI (disabled, guest, past event). */
  rsvp: { summary: EventRsvpSummary; selfName: string | null } | null;
}) {
  const startDate = new Date(event.start);
  const month = startDate.toLocaleDateString(undefined, { month: "short" });
  const day = startDate.getDate();

  return (
    <Card className={muted ? "opacity-60" : undefined}>
      <CardContent className="flex items-start gap-4 p-4 sm:p-6">
        <div className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl bg-primary/10 text-primary">
          <span className="text-[10px] font-semibold uppercase leading-none">
            {month}
          </span>
          <span className="text-xl font-bold leading-tight">{day}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium">{event.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" aria-hidden="true" />
              {formatDate(event.start, event.allDay)}
              {event.end && !event.allDay && (
                <> &ndash; {new Date(event.end).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</>
              )}
            </span>
            {event.location && (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" aria-hidden="true" />
                {event.location}
              </span>
            )}
          </div>
          {event.organizer?.displayName && (
            <div className="mt-1 text-xs text-muted-foreground">
              {t("organizedBy", { name: event.organizer.displayName })}
            </div>
          )}
          {rsvp && (
            <EventRsvpPanel
              eventDocumentId={event.documentId as string}
              capacity={typeof event.capacity === "number" ? event.capacity : null}
              selfName={rsvp.selfName}
              summary={rsvp.summary}
            />
          )}
        </div>
        <a
          href={`/events/${event.id}/ics`}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition hover:bg-muted"
          title={t("downloadIcs")}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
        </a>
      </CardContent>
    </Card>
  );
}
