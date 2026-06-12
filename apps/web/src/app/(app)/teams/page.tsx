import Link from "next/link";
import { Users2 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { api } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import type { Team } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export async function generateMetadata() {
  const t = await getTranslations("teams");
  return { title: t("title") };
}

export default async function TeamsPage() {
  const t = await getTranslations("teams");
  const tCommon = await getTranslations("common");
  const { data, failed } = await tryFetch(() => api.teams.list(), "teams");
  const items = (data?.data ?? []) as Team[];

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />

      {failed && <FetchErrorBanner />}

      {items.length === 0 ? (
        <EmptyState
          icon={Users2}
          title={t("emptyTitle")}
          hint={t("emptyHint")}
        />
      ) : (
        <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((team) => (
            <Link key={team.id} href={`/teams/${team.slug}`} className="focus-card group">
              <Card className="card-lift h-full">
                <CardHeader>
                  <div
                    aria-hidden="true"
                    className="mb-1 flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary"
                  >
                    <Users2 className="h-4 w-4" />
                  </div>
                  <CardTitle className="transition-colors group-hover:text-primary">
                    {team.name}
                  </CardTitle>
                  <CardDescription>
                    {team.department?.name ? `${team.department.name} · ` : ""}
                    {tCommon("member", { count: team.members?.length ?? 0 })}
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
