import Link from "next/link";
import { Calendar, CalendarDays, Clock, Download, List, MapPin } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import type { EventListItem } from "@/lib/api/events";
import { appTimeZone } from "@/lib/app-time-zone";
import type { DateTimeFormatter } from "@/lib/date-format";
import { eventBadge, eventTimeLabel } from "@/lib/event-dates";
import { icsHref } from "@/lib/event-ics";
import { loadEvents } from "@/lib/loaders/events";
import { getSession } from "@/lib/session";
import { getViewer } from "@/lib/viewer";
import type { EventRsvpSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import { EventRsvpPanel } from "@/components/events/event-rsvp-panel";
import { EventsMonthView } from "@/components/events/events-month-view";

export async function generateMetadata() {
  const t = await getTranslations("events");
  return { title: t("title") };
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; month?: string }>;
}) {
  const query = await searchParams;

  const [t, format, session, viewer] = await Promise.all([
    getTranslations("events"),
    getFormatter(),
    getSession(),
    getViewer(),
  ]);
  // The reads, the month grid and the RSVP gate: lib/loaders/events.ts
  // (WD03). Every window is an APP_TIME_ZONE day.
  const timeZone = appTimeZone();
  const userId = typeof session?.user?.id === "number" ? session.user.id : null;
  const view = await loadEvents(
    { view: query.view, month: query.month },
    { userId, role: viewer.role },
    new Date(),
    timeZone,
  );
  const isMonthView = view.mode === "month";
  const selfName = session?.user?.name ?? null;

  const switchLinkClass = (active: boolean) =>
    cn(
      "inline-flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-sm font-medium transition-colors",
      "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
    );

  return (
    <div className="space-y-8">
      <PageHeader title={t("title")} description={t("description")}>
        <div
          role="group"
          aria-label={t("viewLabel")}
          className="inline-flex rounded-xl border p-0.5"
        >
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

      {view.failed && <FetchErrorBanner />}

      {view.mode === "month" ? (
        <EventsMonthView
          events={view.events}
          grid={view.grid}
          today={view.today}
          timeZone={timeZone}
        />
      ) : view.empty ? (
        <EmptyState icon={Calendar} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        <>
          {view.upcoming.length > 0 && (
            <section className="space-y-3">
              <SectionLabel icon={Calendar}>{t("upcoming")}</SectionLabel>
              <div className="stagger space-y-3">
                {view.upcoming.map(({ event, rsvp }) => (
                  <EventCard
                    key={event.id}
                    event={event}
                    t={t}
                    format={format}
                    timeZone={timeZone}
                    rsvp={rsvp ? { summary: rsvp, selfName } : null}
                  />
                ))}
              </div>
            </section>
          )}

          {view.past.length > 0 && (
            <section className="space-y-3">
              <SectionLabel>{t("past")}</SectionLabel>
              <div className="stagger space-y-3">
                {view.past.map((e) => (
                  <EventCard
                    key={e.id}
                    event={e}
                    muted
                    t={t}
                    format={format}
                    timeZone={timeZone}
                    rsvp={null}
                  />
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
  format,
  timeZone,
  rsvp,
}: {
  event: EventListItem;
  muted?: boolean;
  /** The page's `events` translator (typed keys and arguments, AC03). */
  t: Awaited<ReturnType<typeof getTranslations<"events">>>;
  /** next-intl's formatter: formats in APP_TIME_ZONE. */
  format: DateTimeFormatter;
  /** APP_TIME_ZONE, for the calendar-day comparisons. */
  timeZone: string;
  /** null = no RSVP UI (disabled, guest, past event). */
  rsvp: { summary: EventRsvpSummary; selfName: string | null } | null;
}) {
  const badge = eventBadge(event, format, timeZone);

  return (
    <Card className={muted ? "opacity-60" : undefined}>
      <CardContent className="flex items-start gap-4 p-4 sm:p-6">
        <div className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl bg-primary/10 text-primary">
          <span className="text-[10px] font-semibold uppercase leading-none">{badge?.month}</span>
          <span className="text-xl font-bold leading-tight">{badge?.day}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium">{event.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" aria-hidden="true" />
              {eventTimeLabel(event, format, timeZone)}
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
          href={icsHref(event)}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          title={t("downloadIcs")}
          aria-label={t("downloadIcs")}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
        </a>
      </CardContent>
    </Card>
  );
}
