import Link from "next/link";
import type { Route } from "next";
import { getTranslations } from "next-intl/server";
import { TrendingUp } from "lucide-react";
import { KpiGrid } from "@/components/kpis/kpi-cards";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { SectionUnavailablePage } from "@/components/section-unavailable";
import { loadKpis, type KpiView } from "@/lib/loaders/kpis";
import { isReadDenied } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";

export async function generateMetadata() {
  const t = await getTranslations("kpis");
  return { title: t("title") };
}

/**
 * The KPIs of every department (v0.19, "Kennzahlen"): company-wide first,
 * then by department name. Every staff role reads; guests get the
 * explanation instead.
 */
export default async function KpisPage() {
  const t = await getTranslations("kpis");
  const viewer = await getViewer();
  if (isReadDenied(viewer.role, "kpis")) {
    return <SectionUnavailablePage title={t("title")} description={t("description")} />;
  }
  const view = await loadKpis();
  const groups = new Map<string, { name: string; slug: string | null; kpis: KpiView[] }>();
  for (const kpi of view.kpis) {
    const key = kpi.department?.slug ?? "";
    const group = groups.get(key) ?? {
      name: kpi.department?.name ?? t("companyWide"),
      slug: kpi.department?.slug ?? null,
      kpis: [],
    };
    group.kpis.push(kpi);
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((a, b) =>
    a.slug === null ? -1 : b.slug === null ? 1 : a.name.localeCompare(b.name),
  );

  return (
    <div className="space-y-8">
      <PageHeader title={t("title")} description={t("description")} />
      {view.failed && <FetchErrorBanner />}
      {!view.failed && view.kpis.length === 0 ? (
        <EmptyState icon={TrendingUp} title={t("empty")} />
      ) : (
        ordered.map((group) => (
          <section key={group.slug ?? ""} className="space-y-3">
            <h2 className="text-lg font-semibold tracking-tight">
              {group.slug ? (
                <Link
                  href={`/departments/${encodeURIComponent(group.slug)}` as Route}
                  className="hover:underline"
                >
                  {group.name}
                </Link>
              ) : (
                group.name
              )}
            </h2>
            <KpiGrid kpis={group.kpis} />
          </section>
        ))
      )}
    </div>
  );
}
