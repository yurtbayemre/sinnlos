import Link from "next/link";
import { api } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import { FetchErrorBanner } from "@/components/fetch-error";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Teams" };

export default async function TeamsPage() {
  const { data, failed } = await tryFetch(() => api.teams.list(), "teams");
  const items = data?.data ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Teams</h1>
        <p className="text-muted-foreground">All teams across the company.</p>
      </header>

      {failed && <FetchErrorBanner />}

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No teams yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((t: any) => (
            <Link key={t.id} href={`/teams/${t.slug}`}>
              <Card className="h-full">
                <CardHeader>
                  <CardTitle>{t.name}</CardTitle>
                  <CardDescription>
                    {t.department?.name ? `${t.department.name} · ` : ""}
                    {t.members?.length ?? 0} members
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
