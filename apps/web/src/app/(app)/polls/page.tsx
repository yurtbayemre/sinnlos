import { BarChart3 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { api } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import type { Poll } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { PollCard } from "@/components/polls/poll-card";

export async function generateMetadata() {
  const t = await getTranslations("polls");
  return { title: t("title") };
}

export default async function PollsPage() {
  const t = await getTranslations("polls");
  const { data, failed } = await tryFetch(() => api.polls.list(), "polls");
  const polls = (data?.data ?? []) as Poll[];

  const resultsArr = await Promise.all(
    polls.map((p) =>
      api.polls.results(p.id).catch(() => null),
    ),
  );

  const active = polls.filter(
    (p) => !p.closesAt || new Date(p.closesAt) > new Date(),
  );
  const closed = polls.filter(
    (p) => p.closesAt && new Date(p.closesAt) <= new Date(),
  );

  const resultsMap = new Map<number, any>();
  polls.forEach((p, i) => {
    if (resultsArr[i]) resultsMap.set(p.id, resultsArr[i]);
  });

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("title")}
        description={t("description")}
      />

      {failed && <FetchErrorBanner />}

      {polls.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title={t("emptyTitle")}
          hint={t("emptyHint")}
        />
      ) : (
        <>
          {active.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <BarChart3 className="h-3.5 w-3.5" />
                {t("active")}
              </div>
              <div className="stagger grid gap-4 md:grid-cols-2">
                {active.map((p) => (
                  resultsMap.has(p.id) ? (
                    <PollCard key={p.id} results={resultsMap.get(p.id)} />
                  ) : null
                ))}
              </div>
            </section>
          )}

          {closed.length > 0 && (
            <section className="space-y-3">
              <div className="text-sm font-medium text-muted-foreground">Closed</div>
              <div className="stagger grid gap-4 md:grid-cols-2">
                {closed.map((p) => (
                  resultsMap.has(p.id) ? (
                    <PollCard key={p.id} results={resultsMap.get(p.id)} />
                  ) : null
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
