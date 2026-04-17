import Link from "next/link";
import { Building2, Megaphone, Users2, BookOpen } from "lucide-react";
import { auth } from "@/auth";
import { api } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { FetchErrorBanner } from "@/components/fetch-error";
import { LatestNews } from "@/components/dashboard/latest-news";

export default async function DashboardPage() {
  const session = await auth();

  // In a fresh install these may be empty — we render a friendly empty state.
  // When a fetch fails (e.g. Strapi is unreachable), we flag it so the user
  // sees a banner instead of mistaking "API down" for "no content yet".
  const [departments, teams, announcements] = await Promise.all([
    tryFetch(() => api.departments.list(), "dashboard"),
    tryFetch(() => api.teams.list(), "dashboard"),
    tryFetch(() => api.announcements.list(), "dashboard"),
  ]);

  const deptCount = departments.data?.data.length ?? 0;
  const teamCount = teams.data?.data.length ?? 0;
  const anyFailed = departments.failed || teams.failed || announcements.failed;

  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm text-muted-foreground">
          {greeting()}, {session?.user?.name ?? "friend"}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Welcome back</h1>
      </header>

      {anyFailed && <FetchErrorBanner />}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={<Building2 className="h-5 w-5" />} label="Departments" value={deptCount} href="/departments" />
        <StatCard icon={<Users2 className="h-5 w-5" />} label="Teams" value={teamCount} href="/teams" />
        <StatCard icon={<BookOpen className="h-5 w-5" />} label="Wiki" value="Browse" href="/wiki" />
        <StatCard icon={<Megaphone className="h-5 w-5" />} label="News" value={announcements.data?.data.length ?? 0} href="/announcements" />
      </section>

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
    <Link href={href} className="block">
      <Card className="cursor-pointer">
        <CardContent className="flex items-center gap-4 p-6">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
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

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

