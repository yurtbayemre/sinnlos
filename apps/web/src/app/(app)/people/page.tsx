import { Contact } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { PEOPLE_QUERY, toPersonCards } from "@/lib/people-dto";
import { fetchAllUsers } from "@/lib/users";
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
  // Field-limited fetch and a lean card DTO before the client boundary
  // (WD05): the grid gets name, job title, email (search only; stripped by
  // the CMS for non-staff), department and the avatar thumbnail per person.
  const { data, failed } = await tryFetch(() => fetchAllUsers<UserLite>(PEOPLE_QUERY), "people");
  const people = toPersonCards(data?.users ?? []);

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} />

      {failed && <FetchErrorBanner />}

      {people.length === 0 ? (
        <EmptyState icon={Contact} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        <PeopleGrid people={people} />
      )}
    </div>
  );
}
