import { Contact } from "lucide-react";
import { strapi } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import type { UserLite } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { OrgTree } from "@/components/people/org-tree";

export const metadata = { title: "Org Chart" };

export default async function OrgChartPage() {
  const { data, failed } = await tryFetch(
    () =>
      strapi<any[]>(
        "/api/users?populate[manager]=true&populate[avatar]=true&populate[department]=true&pagination[pageSize]=500&sort=displayName:asc",
        { noCache: true },
      ),
    "org-chart",
  );
  const people = (data ?? []) as (UserLite & { manager?: { id: number } | null })[];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Org Chart"
        description="Visual overview of reporting lines."
      />

      {failed && <FetchErrorBanner />}

      {people.length === 0 ? (
        <EmptyState
          icon={Contact}
          title="No people yet"
          hint="Users appear here automatically after signing in."
        />
      ) : (
        <OrgTree people={people} />
      )}
    </div>
  );
}
