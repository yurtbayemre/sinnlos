import { Contact } from "lucide-react";
import { strapi } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import type { UserLite } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { PeopleGrid } from "@/components/people/people-grid";

export const metadata = { title: "People" };

export default async function PeoplePage() {
  const { data, failed } = await tryFetch(
    () =>
      strapi<any[]>(
        "/api/users?populate[department]=true&populate[avatar]=true&populate[role]=true&pagination[pageSize]=200&sort=displayName:asc",
        { noCache: true },
      ),
    "people",
  );
  const people = (data ?? []) as UserLite[];

  return (
    <div className="space-y-6">
      <PageHeader
        title="People"
        description="Find colleagues across the company."
      />

      {failed && <FetchErrorBanner />}

      {people.length === 0 ? (
        <EmptyState
          icon={Contact}
          title="No people yet"
          hint="Users are synced automatically when they sign in with Microsoft."
        />
      ) : (
        <PeopleGrid people={people} />
      )}
    </div>
  );
}
