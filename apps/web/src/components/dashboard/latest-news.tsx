import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ArrowRight, Megaphone } from "lucide-react";
import { AnnouncementCard } from "@/components/announcements/announcement-card";
import { EmptyState } from "@/components/empty-state";
import { SectionLabel } from "@/components/ui/section-label";
import { appTimeZone } from "@/lib/app-time-zone";
import type { LatestNewsView } from "@/lib/loaders/announcements";
import { relativeTime } from "@/lib/relative-time";

/**
 * The dashboard's news widget: a featured card (the first pinned
 * announcement, else the newest) and up to four more, all linking to
 * /announcements (the selection: lib/loaders/announcements.ts
 * pickLatestNews). The cards are the shared AnnouncementCard (UI08).
 */
export async function LatestNews({ news }: { news: LatestNewsView }) {
  const tDashboard = await getTranslations("dashboard");
  const tCommon = await getTranslations("common");
  const tRel = await getTranslations("relativeTime");
  const locale = await getLocale();
  const timeZone = appTimeZone();
  const relative = (iso: string | undefined) =>
    relativeTime(iso ? new Date(iso) : null, tRel, { longDate: true, locale, timeZone });
  const { featured, rest } = news;

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <SectionLabel as="p" icon={Megaphone}>
            {tDashboard("whatsNew")}
          </SectionLabel>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">{tDashboard("latestNews")}</h2>
        </div>
        <Link
          href="/announcements"
          className="group inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          {tCommon("viewAll")}
          <ArrowRight
            className="h-3.5 w-3.5 transition group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </Link>
      </div>

      {featured === null ? (
        <EmptyState
          icon={Megaphone}
          title={tDashboard("noAnnouncementsYet")}
          hint={tDashboard("noAnnouncementsHint")}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-5">
          <AnnouncementCard
            variant="featured"
            item={featured}
            badge={featured.pinned ? tDashboard("pinned") : tDashboard("featured")}
            dateLabel={relative(featured.createdAt)}
            unknownLabel={tCommon("unknown")}
          />

          <div className="flex flex-col gap-3 lg:col-span-2">
            {rest.map((n) => (
              <AnnouncementCard
                key={n.id}
                variant="compact"
                item={n}
                dateLabel={relative(n.createdAt)}
                unknownLabel={tCommon("unknown")}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
