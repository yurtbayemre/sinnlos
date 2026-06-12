import Link from "next/link";
import { Building2 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { api } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import type { Department } from "@/lib/types";
import { stripHtml } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export async function generateMetadata() {
  const t = await getTranslations("departments");
  return { title: t("title") };
}

export default async function DepartmentsPage() {
  const t = await getTranslations("departments");
  const tCommon = await getTranslations("common");
  const { data, failed } = await tryFetch(() => api.departments.list(), "departments");
  const items = (data?.data ?? []) as Department[];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
      />

      {failed && <FetchErrorBanner />}

      {items.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={t("emptyTitle")}
          hint={t("emptyHint")}
        />
      ) : (
        <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((d) => (
            <Link key={d.id} href={`/departments/${d.slug}`} className="focus-card group">
              <Card className="card-lift h-full">
                <CardHeader>
                  <div
                    aria-hidden="true"
                    className="mb-3 h-20 rounded-xl transition-transform duration-200 group-hover:scale-[1.015]"
                    style={{
                      background: `linear-gradient(135deg, ${d.color ?? "#6366f1"}, ${d.color ?? "#818cf8"}88)`,
                    }}
                  />
                  <CardTitle className="transition-colors group-hover:text-primary">
                    {d.name}
                  </CardTitle>
                  <CardDescription className="line-clamp-2">
                    {stripHtml(d.description) || tCommon("noDescription")}
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
