import { Suspense } from "react";
import { Award, BookOpen, Building2, Calendar, Contact, Megaphone, Users2 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { appTimeZone } from "@/lib/app-time-zone";
import { loadDashboard } from "@/lib/loaders/dashboard";
import { loadPeopleCount } from "@/lib/loaders/people-count";
import { zonedHour } from "@/lib/plain-date";
import { getSession } from "@/lib/session";
import { getViewer } from "@/lib/viewer";
import { StatCount, StatTile, StatValueSkeleton } from "@/components/ui/stat-tile";
import { FetchErrorBanner } from "@/components/fetch-error";
import { AckBanner } from "@/components/dashboard/ack-banner";
import { TrainingBanner } from "@/components/training/training-banner";
import { LatestNews } from "@/components/dashboard/latest-news";
import { QuickLinks } from "@/components/dashboard/quick-links";
import { DutiesNowSection } from "@/components/duties/duty-lists";

/**
 * The dashboard. Its data comes from lib/loaders/dashboard.ts (WD03): the
 * sections the role can read, the counts with their failed/truncated
 * state, the quick links and the news selection. A failed read shows the
 * CMS-down banner and "–" on its tile, never a misleading 0.
 */
export default async function DashboardPage() {
  const [session, viewer] = await Promise.all([getSession(), getViewer()]);
  // Today and the greeting hour in APP_TIME_ZONE (datetime contract,
  // phase 2), from one instant.
  const timeZone = appTimeZone();
  const now = new Date();
  const view = await loadDashboard(viewer.role, now, timeZone);
  const { sections, counts } = view;

  const t = await getTranslations("dashboard");
  const tNav = await getTranslations("nav");
  const tCommon = await getTranslations("common");
  const unknown = tCommon("unknown");

  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm text-muted-foreground">
          {greeting(t, zonedHour(now, timeZone))}, {session?.user?.name ?? t("friendFallback")}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">{t("welcomeBack")}</h1>
      </header>

      {view.failed && <FetchErrorBanner />}

      {/* AckBanner does its own per-user reads — inside Suspense it
          streams in after the initial dashboard flush instead of blocking
          the whole page on the acknowledgements round-trips. */}
      {sections.acks && (
        <Suspense fallback={null}>
          <AckBanner />
        </Suspense>
      )}

      {/* Same streaming rationale as AckBanner — per-user training state. */}
      {sections.training && (
        <Suspense fallback={null}>
          <TrainingBanner />
        </Suspense>
      )}

      <section className="stagger grid gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <Suspense fallback={<PeopleTile label={tNav("people")} value={<StatValueSkeleton />} />}>
          <PeopleStatTile label={tNav("people")} unknownLabel={unknown} />
        </Suspense>
        {counts.departments && (
          <StatTile
            icon={Building2}
            label={tNav("departments")}
            value={<StatCount count={counts.departments} unknownLabel={unknown} />}
            href="/departments"
          />
        )}
        {counts.teams && (
          <StatTile
            icon={Users2}
            label={tNav("teams")}
            value={<StatCount count={counts.teams} unknownLabel={unknown} />}
            href="/teams"
          />
        )}
        <StatTile
          icon={Calendar}
          label={tNav("events")}
          value={<StatCount count={counts.events} unknownLabel={unknown} />}
          href="/events"
        />
        <StatTile icon={BookOpen} label={tNav("wiki")} value={t("browse")} href="/wiki" />
        {counts.news && (
          <StatTile
            icon={Megaphone}
            label={tNav("news")}
            value={<StatCount count={counts.news} unknownLabel={unknown} />}
            href="/announcements"
          />
        )}
        {sections.kudos && (
          <StatTile icon={Award} label={tNav("kudos")} value={t("give")} href="/kudos" />
        )}
      </section>

      {/* Who is on duty (v0.18): its own reads, streamed like the banners. */}
      <Suspense fallback={null}>
        <DutiesNowSection />
      </Suspense>

      <QuickLinks items={view.quickLinks} />

      {view.latestNews && <LatestNews news={view.latestNews} />}
    </div>
  );
}

/**
 * The people count (WD10): the directory walk in its own Suspense boundary,
 * so it streams in after the dashboard's first flush. A failed walk shows
 * "–" (the dashboard's banner has been sent by then).
 */
async function PeopleStatTile({ label, unknownLabel }: { label: string; unknownLabel: string }) {
  const count = await loadPeopleCount("dashboard-people");
  return (
    <PeopleTile label={label} value={<StatCount count={count} unknownLabel={unknownLabel} />} />
  );
}

function PeopleTile({ label, value }: { label: string; value: React.ReactNode }) {
  return <StatTile icon={Contact} label={label} value={value} href="/people" />;
}

/** The greeting of the wall-clock hour `h` (0-23) in APP_TIME_ZONE, not the process zone. */
function greeting(t: Awaited<ReturnType<typeof getTranslations<"dashboard">>>, h: number) {
  if (h < 12) return t("goodMorning");
  if (h < 18) return t("goodAfternoon");
  return t("goodEvening");
}
