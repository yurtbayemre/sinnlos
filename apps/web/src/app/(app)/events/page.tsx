import { Calendar, Clock, MapPin, Download } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { api } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import type { Event } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";

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

function isUpcoming(iso: string) {
  return new Date(iso).getTime() > Date.now();
}

export default async function EventsPage() {
  const t = await getTranslations("events");
  const { data, failed } = await tryFetch(() => api.events.list(), "events");
  const all = (data?.data ?? []) as Event[];

  const upcoming = all.filter((e) => isUpcoming(e.end ?? e.start));
  const past = all.filter((e) => !isUpcoming(e.end ?? e.start));

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("title")}
        description={t("description")}
      />

      {failed && <FetchErrorBanner />}

      {all.length === 0 ? (
        <EmptyState
          icon={Calendar}
          title={t("emptyTitle")}
          hint={t("emptyHint")}
        />
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
                  <EventCard key={e.id} event={e} t={t} />
                ))}
              </div>
            </section>
          )}

          {past.length > 0 && (
            <section className="space-y-3">
              <div className="text-sm font-medium text-muted-foreground">{t("past")}</div>
              <div className="stagger space-y-3">
                {past.map((e) => (
                  <EventCard key={e.id} event={e} muted t={t} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function EventCard({ event, muted = false }: { event: Event; muted?: boolean }) {
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
              Organized by {event.organizer.displayName}
            </div>
          )}
        </div>
        <a
          href={`/events/${event.id}/ics`}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition hover:bg-muted"
          title="Download .ics"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
        </a>
      </CardContent>
    </Card>
  );
}
