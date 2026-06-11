import Link from "next/link";
import { Users2 } from "lucide-react";
import { api } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import type { Team } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Teams" };

export default async function TeamsPage() {
  const { data, failed } = await tryFetch(() => api.teams.list(), "teams");
  const items = (data?.data ?? []) as Team[];

  return (
    <div className="space-y-6">
      <PageHeader title="Teams" description="All teams across the company." />

      {failed && <FetchErrorBanner />}

      {items.length === 0 ? (
        <EmptyState
          icon={Users2}
          title="No teams yet"
          hint="Teams belong to departments — add them in the Strapi admin."
        />
      ) : (
        <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((t) => (
            <Link key={t.id} href={`/teams/${t.slug}`} className="focus-card group">
              <Card className="card-lift h-full">
                <CardHeader>
                  <div
                    aria-hidden="true"
                    className="mb-1 flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary"
                  >
                    <Users2 className="h-4 w-4" />
                  </div>
                  <CardTitle className="transition-colors group-hover:text-primary">
                    {t.name}
                  </CardTitle>
                  <CardDescription>
                    {t.department?.name ? `${t.department.name} · ` : ""}
                    {t.members?.length ?? 0} {(t.members?.length ?? 0) === 1 ? "member" : "members"}
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
