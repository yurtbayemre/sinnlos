import Link from "next/link";
import { BookOpen, Globe2, Lock } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { api } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import type { WikiSpace } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export async function generateMetadata() {
  const t = await getTranslations("wiki");
  return { title: t("title") };
}

export default async function WikiHomePage() {
  const t = await getTranslations("wiki");
  const { data, failed } = await tryFetch(() => api.wiki.spaces(), "wiki");
  const spaces = (data?.data ?? []) as WikiSpace[];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
      />

      {failed && <FetchErrorBanner />}

      {spaces.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title={t("emptySpacesTitle")}
          hint={t("emptySpacesHint")}
        />
      ) : (
        <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {spaces.map((s) => (
            <Link key={s.id} href={`/wiki/${s.slug}`} className="focus-card group">
              <Card className="card-lift h-full">
                <CardHeader>
                  <div
                    aria-hidden="true"
                    className="mb-1 flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary"
                  >
                    <BookOpen className="h-4 w-4" />
                  </div>
                  <CardTitle className="transition-colors group-hover:text-primary">
                    {s.name}
                  </CardTitle>
                  <CardDescription className="flex items-center gap-1.5">
                    {s.visibility === "public" ? (
                      <Globe2 className="h-3 w-3 shrink-0" aria-hidden="true" />
                    ) : (
                      <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
                    )}
                    <span className="truncate">{s.description ?? "No description"}</span>
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
