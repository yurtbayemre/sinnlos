import { Contact } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { strapi } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import type { UserLite } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { PeopleGrid } from "@/components/people/people-grid";

export async function generateMetadata() {
  const t = await getTranslations("people");
  return { title: t("title") };
}

export default async function PeoplePage() {
  const t = await getTranslations("people");
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
        title={t("title")}
      />

      {failed && <FetchErrorBanner />}

      {people.length === 0 ? (
        <EmptyState
          icon={Contact}
          title={t("emptyTitle")}
          hint={t("emptyHint")}
        />
      ) : (
        <PeopleGrid people={people} />
      )}
    </div>
  );
}
