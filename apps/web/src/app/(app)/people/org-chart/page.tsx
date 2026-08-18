import { Contact } from "lucide-react";
import { getTranslations } from "next-intl/server";
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
  const { data, failed } = await tryFetch(
    () =>
      fetchAllUsers(
        "populate[manager]=true&populate[avatar]=true&populate[department]=true&sort=displayName:asc",
      ),
    "org-chart",
  );
  const people = (data?.users ?? []) as (UserLite & { manager?: { id: number } | null })[];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("orgChart")}
      />

      {failed && <FetchErrorBanner />}

      {people.length === 0 ? (
        <EmptyState
          icon={Contact}
          title={t("emptyTitle")}
          hint={t("emptyHint")}
        />
      ) : (
        <OrgTree people={people} />
      )}
    </div>
  );
}
