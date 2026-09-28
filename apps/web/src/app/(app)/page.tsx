import Link from "next/link";
import type { Route } from "next";
import { Suspense } from "react";
import { Award, Building2, Calendar, Contact, Megaphone, Users2, BookOpen } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { appTimeZone } from "@/lib/app-time-zone";
import { zonedDateKey, zonedDayStart, zonedHour } from "@/lib/plain-date";
import { getSession } from "@/lib/session";
import { api } from "@/lib/strapi";
import { fetchAllUsers } from "@/lib/users";
import { tryFetch } from "@/lib/safe-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FetchErrorBanner } from "@/components/fetch-error";
import { AckBanner } from "@/components/dashboard/ack-banner";
import { TrainingBanner } from "@/components/training/training-banner";
import { LatestNews } from "@/components/dashboard/latest-news";
import { QuickLinks } from "@/components/dashboard/quick-links";

export default async function DashboardPage() {
  const session = await getSession();
  // Today in APP_TIME_ZONE (datetime contract, phase 2): events that began
  // earlier today, or are still running, count as upcoming.
  const timeZone = appTimeZone();
  const now = new Date();
  const startOfToday = zonedDayStart(zonedDateKey(now, timeZone), timeZone).toISOString();

  // In a fresh install these may be empty — we render a friendly empty state.
  // When a fetch fails (e.g. Strapi is unreachable), we flag it so the user
  // sees a banner instead of mistaking "API down" for "no content yet".
  // The people count is NOT in this Promise.all (WD10): /api/users has no
  // count for every role, so it walks the whole directory, and that walk
  // must not hold back the first flush of the dashboard. PeopleStatCard
  // streams it in its own Suspense boundary below.
  const [departments, teams, announcements, events, quickLinks] = await Promise.all([
    tryFetch(() => api.departments.list(), "dashboard"),
    tryFetch(() => api.teams.list(), "dashboard"),
    // Targeting is applied by the CMS policy — no department argument.
    tryFetch(() => api.announcements.list(), "dashboard"),
    // Upcoming only — the stat card counts events that still matter, not
    // the 50 oldest history entries (api.events is time-window based now).
    tryFetch(() => api.events.upcoming(startOfToday, now.toISOString()), "dashboard"),
    tryFetch(() => api.quickLinks.list(), "dashboard"),
  ]);

  // Stat-card counts are decoupled from any render cap (issue #26):
  // departments/teams are now COMPLETE page walks (data.length is the real
  // total), while events/news keep their feed pageSize and read the count
  // from `meta.pagination.total` of the same response — no extra request,
  // and correct per user (the announcement-visibility policy filters the
  // query before the count). Optional chaining on meta: DEMO_MODE and the
  // walk results are covered, but a future fixture drift must not crash.
  const deptCount = departments.data?.data.length ?? 0;
  const teamCount = teams.data?.data.length ?? 0;
  const eventCount = events.data?.meta?.pagination?.total ?? events.data?.data.length ?? 0;
  const newsCount =
    announcements.data?.meta?.pagination?.total ?? announcements.data?.data.length ?? 0;
  const anyFailed =
    departments.failed ||
    teams.failed ||
    announcements.failed ||
    events.failed ||
    quickLinks.failed;

  const t = await getTranslations("dashboard");
  const tNav = await getTranslations("nav");

  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm text-muted-foreground">
          {greeting(t, zonedHour(now, timeZone))}, {session?.user?.name ?? t("friendFallback")}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">{t("welcomeBack")}</h1>
      </header>

      {anyFailed && <FetchErrorBanner />}

      {/* AckBanner does its own per-user fetches — inside Suspense it
          streams in after the initial dashboard flush instead of blocking
          the whole page on the acknowledgements round-trips. */}
      <Suspense fallback={null}>
        <AckBanner />
      </Suspense>

      {/* Same streaming rationale as AckBanner — per-user training state. */}
      <Suspense fallback={null}>
        <TrainingBanner />
      </Suspense>

      <section className="stagger grid gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <Suspense
          fallback={<PeopleStatCardShell label={tNav("people")} value={<ValueSkeleton />} />}
        >
          <PeopleStatCard label={tNav("people")} />
        </Suspense>
        <StatCard
          icon={<Building2 className="h-5 w-5" aria-hidden="true" />}
          label={tNav("departments")}
          value={deptCount}
          href="/departments"
        />
        <StatCard
          icon={<Users2 className="h-5 w-5" aria-hidden="true" />}
          label={tNav("teams")}
          value={teamCount}
          href="/teams"
        />
        <StatCard
          icon={<Calendar className="h-5 w-5" aria-hidden="true" />}
          label={tNav("events")}
          value={eventCount}
          href="/events"
        />
        <StatCard
          icon={<BookOpen className="h-5 w-5" aria-hidden="true" />}
          label={tNav("wiki")}
          value={t("browse")}
          href="/wiki"
        />
        <StatCard
          icon={<Megaphone className="h-5 w-5" aria-hidden="true" />}
          label={tNav("news")}
          value={newsCount}
          href="/announcements"
        />
        <StatCard
          icon={<Award className="h-5 w-5" aria-hidden="true" />}
          label={tNav("kudos")}
          value={t("give")}
          href="/kudos"
        />
      </section>

      <QuickLinks items={(quickLinks.data?.data ?? []) as any[]} />

      <LatestNews items={(announcements.data?.data ?? []) as any[]} />
    </div>
  );
}

/**
 * The people count (WD10): the directory walk in its own Suspense boundary,
 * so it streams in after the dashboard's first flush. A failed walk shows
 * "–" in the card instead of a misleading 0 (the dashboard's error banner
 * has already been sent by then).
 */
async function PeopleStatCard({ label }: { label: string }) {
  const result = await tryFetch(() => fetchAllUsers("fields[0]=id"), "dashboard-people");
  const value = result.failed ? "–" : (result.data?.users.length ?? 0);
  return <PeopleStatCardShell label={label} value={value} />;
}

function PeopleStatCardShell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <StatCard
      icon={<Contact className="h-5 w-5" aria-hidden="true" />}
      label={label}
      value={value}
      href="/people"
    />
  );
}

/** Placeholder for a count that is still loading. */
function ValueSkeleton() {
  return <Skeleton aria-hidden="true" className="mt-1 h-7 w-12 rounded-md" />;
}

function StatCard({
  icon,
  label,
  value,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  href: Route;
}) {
  return (
    <Link href={href} className="focus-card group block">
      <Card className="card-lift cursor-pointer">
        <CardContent className="flex items-center gap-4 p-6">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary transition-transform duration-200 group-hover:scale-110">
            {icon}
          </div>
          <div>
            <div className="text-sm text-muted-foreground">{label}</div>
            <div className="text-2xl font-semibold tracking-tight">{value}</div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/** The greeting of the wall-clock hour `h` (0-23) in APP_TIME_ZONE, not the process zone. */
function greeting(t: (key: string) => string, h: number) {
  if (h < 12) return t("goodMorning");
  if (h < 18) return t("goodAfternoon");
  return t("goodEvening");
}
