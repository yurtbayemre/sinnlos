import Link from "next/link";
import { Building2, Megaphone, Users2, BookOpen } from "lucide-react";
import { auth } from "@/auth";
import { api } from "@/lib/strapi";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function DashboardPage() {
  const session = await auth();

  // In a fresh install these may be empty — we render a friendly empty state.
  const [departments, teams, announcements] = await Promise.all([
    safe(() => api.departments.list()),
    safe(() => api.teams.list()),
    safe(() => api.announcements.list()),
  ]);

  const deptCount = departments?.data.length ?? 0;
  const teamCount = teams?.data.length ?? 0;

  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm text-muted-foreground">
          {greeting()}, {session?.user?.name ?? "friend"}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Welcome back</h1>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={<Building2 className="h-5 w-5" />} label="Departments" value={deptCount} href="/departments" />
        <StatCard icon={<Users2 className="h-5 w-5" />} label="Teams" value={teamCount} href="/teams" />
        <StatCard icon={<BookOpen className="h-5 w-5" />} label="Wiki" value="Browse" href="/wiki" />
        <StatCard icon={<Megaphone className="h-5 w-5" />} label="News" value={announcements?.data.length ?? 0} href="/announcements" />
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold">Latest announcements</h2>
        {announcements && announcements.data.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2">
            {announcements.data.slice(0, 4).map((a: any) => (
              <Card key={a.id}>
                <CardHeader>
                  <CardTitle className="text-base">{a.title ?? a.attributes?.title}</CardTitle>
                  <CardDescription>
                    {new Date(a.createdAt ?? a.attributes?.createdAt).toLocaleDateString()}
                  </CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No announcements yet"
            hint="Editors can post company news from the Strapi admin panel."
          />
        )}
      </section>
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

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <Card>
      <CardContent className="py-12 text-center">
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    console.error("[dashboard] strapi fetch failed", e);
    return null;
  }
}
