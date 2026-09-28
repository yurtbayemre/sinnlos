import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { BarChart3, Plus } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { canCreatePolls } from "@/lib/roles";
import { api, pollRef } from "@/lib/strapi";
import { StrapiError } from "@/lib/strapi-error";
import { getViewer } from "@/lib/viewer";
import { isPollClosed } from "@/lib/poll-close";
import { tryFetch } from "@/lib/safe-fetch";
import type { Poll, PollResults } from "@/lib/types";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { PollCard } from "@/components/polls/poll-card";
import { PollsEmptyState } from "@/components/polls/polls-empty-state";

export async function generateMetadata() {
  const t = await getTranslations("polls");
  return { title: t("title") };
}

export default async function PollsPage() {
  // Every role may read the list and canCreate only toggles a button, so the
  // list fetch runs alongside getViewer()'s /api/me read instead of behind
  // it. Pages that gate their content (/polls/new, /manage/*) stay gate-first.
  const [t, viewer, { data, failed }] = await Promise.all([
    getTranslations("polls"),
    getViewer(),
    tryFetch(() => api.polls.list(), "polls"),
  ]);
  const canCreate = canCreatePolls(viewer.role);
  const polls = (data?.data ?? []) as Poll[];

  // Per poll (FX47): an expired session's redirect (NEXT_REDIRECT) must
  // reach Next.js; a 404 is a race (the poll was deleted, unpublished or
  // retargeted after the list read, decision 02) and just drops the card;
  // any other failure also shows the error banner. Each poll is addressed
  // by its documentId (DA01), which a republish between the list read and
  // this request does not change; the cms decides visibility, canVote, the
  // audience and the guest flags per poll and caller.
  let resultsFailed = false;
  const resultsArr = await Promise.all(
    polls.map((p) =>
      api.polls.results(pollRef(p)).catch((e: unknown): PollResults | null => {
        unstable_rethrow(e);
        if (!(e instanceof StrapiError && e.status === 404)) {
          console.error("[polls] results fetch failed", e);
          resultsFailed = true;
        }
        return null;
      }),
    ),
  );

  // Closed iff now >= closesAt: the rule the cms vote handler and the card use.
  const now = new Date();
  const active = polls.filter((p) => !isPollClosed(p.closesAt, now));
  const closed = polls.filter((p) => isPollClosed(p.closesAt, now));

  const resultsMap = new Map<number, PollResults>();
  polls.forEach((p, i) => {
    const results = resultsArr[i];
    if (results) resultsMap.set(p.id, results);
  });
  // A poll without results (404 race or failed read) renders no card.
  // Keyed by the poll's address (its documentId), which a republish keeps:
  // a card whose vote was refused because the options changed keeps its
  // voteFailed message through the refresh that shows the new options,
  // instead of remounting under the new published row id.
  const card = (p: Poll) => {
    const results = resultsMap.get(p.id);
    const ref = pollRef(p);
    return results ? (
      <PollCard key={ref} results={results} pollRef={ref} viewerRole={viewer.role} />
    ) : null;
  };

  return (
    <div className="space-y-8">
      <PageHeader title={t("title")} description={t("description")}>
        {canCreate && (
          <Link
            href="/polls/new"
            className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {t("newPoll")}
          </Link>
        )}
      </PageHeader>

      {(failed || resultsFailed) && <FetchErrorBanner />}

      {polls.length === 0 ? (
        <PollsEmptyState viewerRole={viewer.role} />
      ) : (
        <>
          {active.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <BarChart3 className="h-3.5 w-3.5" />
                {t("active")}
              </div>
              <div className="stagger grid gap-4 md:grid-cols-2">{active.map(card)}</div>
            </section>
          )}

          {closed.length > 0 && (
            <section className="space-y-3">
              <div className="text-sm font-medium text-muted-foreground">{t("closed")}</div>
              <div className="stagger grid gap-4 md:grid-cols-2">{closed.map(card)}</div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
