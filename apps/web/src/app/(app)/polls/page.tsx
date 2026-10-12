import Link from "next/link";
import { BarChart3, Plus } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { loadPolls, type PollEntry } from "@/lib/loaders/polls";
import { canCreatePolls } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { SectionLabel } from "@/components/ui/section-label";
import { PollCard } from "@/components/polls/poll-card";
import { PollsEmptyState } from "@/components/polls/polls-empty-state";

export async function generateMetadata() {
  const t = await getTranslations("polls");
  return { title: t("title") };
}

export default async function PollsPage() {
  // Every role may read the list and canCreate only toggles a button, so the
  // reads run alongside getViewer()'s /api/me read instead of behind it.
  // Pages that gate their content (/polls/new, /manage/*) stay gate-first.
  // The list, the results and the active/closed split: lib/loaders/polls.ts
  // (WD03).
  const [t, viewer, view] = await Promise.all([
    getTranslations("polls"),
    getViewer(),
    loadPolls(new Date()),
  ]);
  const canCreate = canCreatePolls(viewer.role);

  // Keyed by the poll's address (its documentId), which a republish keeps:
  // a card whose vote was refused because the options changed keeps its
  // voteFailed message through the refresh that shows the new options,
  // instead of remounting under the new published row id.
  const card = ({ ref, results }: PollEntry) => (
    <PollCard key={ref} results={results} pollRef={ref} viewerRole={viewer.role} />
  );

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

      {view.failed && <FetchErrorBanner />}

      {view.empty ? (
        <PollsEmptyState viewerRole={viewer.role} />
      ) : (
        <>
          {view.active.length > 0 && (
            <section className="space-y-3">
              <SectionLabel icon={BarChart3}>{t("active")}</SectionLabel>
              <div className="stagger grid gap-4 md:grid-cols-2">{view.active.map(card)}</div>
            </section>
          )}

          {view.closed.length > 0 && (
            <section className="space-y-3">
              <SectionLabel>{t("closed")}</SectionLabel>
              <div className="stagger grid gap-4 md:grid-cols-2">{view.closed.map(card)}</div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
