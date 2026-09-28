import { Contact } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { ORG_CHART_QUERY, toOrgPeople } from "@/lib/people-dto";
import { fetchAllUsers } from "@/lib/users";
import { tryFetch } from "@/lib/safe-fetch";
import type { UserLite } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { OrgTree } from "@/components/people/org-tree";

export async function generateMetadata() {
  const t = await getTranslations("people");
  return { title: t("orgChart") };
}

export default async function OrgChartPage() {
  const t = await getTranslations("people");
  // Field-limited fetch and a lean node DTO before the client boundary
  // (WD05): name, job title, department, avatar thumbnail and the manager's
  // id per person — the manager is no longer a full user row.
  const { data, failed } = await tryFetch(
    () => fetchAllUsers<UserLite>(ORG_CHART_QUERY),
    "org-chart",
  );
  const people = toOrgPeople(data?.users ?? []);

  return (
    <div className="space-y-6">
      <PageHeader title={t("orgChart")} />

      {failed && <FetchErrorBanner />}

      {people.length === 0 ? (
        <EmptyState icon={Contact} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        <OrgTree people={people} />
      )}
    </div>
  );
}
