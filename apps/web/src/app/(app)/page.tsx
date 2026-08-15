import Link from "next/link";
import { Suspense } from "react";
import { Award, Building2, Calendar, Contact, Megaphone, Users2, BookOpen } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { api } from "@/lib/strapi";
import { fetchAllUsers } from "@/lib/users";
import { tryFetch } from "@/lib/safe-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { FetchErrorBanner } from "@/components/fetch-error";
import { AckBanner } from "@/components/dashboard/ack-banner";
import { LatestNews } from "@/components/dashboard/latest-news";
import { QuickLinks } from "@/components/dashboard/quick-links";

/** Local start of today — date-based, so the events cache key changes daily. */
function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export default async function DashboardPage() {
  const session = await auth();

  // In a fresh install these may be empty — we render a friendly empty state.
  // When a fetch fails (e.g. Strapi is unreachable), we flag it so the user
  // sees a banner instead of mistaking "API down" for "no content yet".
  const [departments, teams, announcements, peopleResult, events, quickLinks] = await Promise.all([
    tryFetch(() => api.departments.list(), "dashboard"),
    tryFetch(() => api.teams.list(), "dashboard"),
    tryFetch(() => api.announcements.list(session?.user?.department?.id), "dashboard"),
    tryFetch(() => fetchAllUsers("fields[0]=id"), "dashboard"),
    // Upcoming only — the stat card counts events that still matter, not
    // the 50 oldest history entries (api.events is time-window based now).
    tryFetch(() => api.events.upcoming(startOfToday().toISOString()), "dashboard"),
    tryFetch(() => api.quickLinks.list(), "dashboard"),
  ]);

  const deptCount = departments.data?.data.length ?? 0;
  const teamCount = teams.data?.data.length ?? 0;
  const peopleCount = Array.isArray(peopleResult.data) ? peopleResult.data.length : 0;
  const eventCount = events.data?.data.length ?? 0;
  const anyFailed =
    departments.failed ||
    teams.failed ||
    announcements.failed ||
    peopleResult.failed ||
    events.failed ||
    quickLinks.failed;

  const t = await getTranslations("dashboard");
  const tNav = await getTranslations("nav");

  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm text-muted-foreground">
          {greeting(t)}, {session?.user?.name ?? "friend"}
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

      <section className="stagger grid gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        <StatCard icon={<Contact className="h-5 w-5" aria-hidden="true" />} label={tNav("people")} value={peopleCount} href="/people" />
        <StatCard icon={<Building2 className="h-5 w-5" aria-hidden="true" />} label={tNav("departments")} value={deptCount} href="/departments" />
        <StatCard icon={<Users2 className="h-5 w-5" aria-hidden="true" />} label={tNav("teams")} value={teamCount} href="/teams" />
        <StatCard icon={<Calendar className="h-5 w-5" aria-hidden="true" />} label={tNav("events")} value={eventCount} href="/events" />
        <StatCard icon={<BookOpen className="h-5 w-5" aria-hidden="true" />} label={tNav("wiki")} value={t("browse")} href="/wiki" />
        <StatCard icon={<Megaphone className="h-5 w-5" aria-hidden="true" />} label={tNav("news")} value={announcements.data?.data.length ?? 0} href="/announcements" />
        <StatCard icon={<Award className="h-5 w-5" aria-hidden="true" />} label={tNav("kudos")} value={t("give")} href="/kudos" />
      </section>

      <QuickLinks items={(quickLinks.data?.data ?? []) as any[]} />

      <LatestNews items={(announcements.data?.data ?? []) as any[]} />
    </div>
  );
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
  href: string;
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

function greeting(t: (key: string) => string) {
  const h = new Date().getHours();
  if (h < 12) return t("goodMorning");
  if (h < 18) return t("goodAfternoon");
  return t("goodEvening");
}

