import Link from "next/link";
import { redirect } from "next/navigation";
import { FilePen } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { StatusBadges } from "@/components/manage/status-badges";
import { formatInstant } from "@/lib/date-format";
import { loadMyWikiDrafts } from "@/lib/loaders/manage/wiki";
import { wikiEditPath } from "@/lib/manage/wiki-paths";
import { capabilitiesFor } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";

export async function generateMetadata() {
  const t = await getTranslations("manage.wiki.drafts");
  return { title: t("title") };
}

/**
 * The caller's wiki drafts (deep-dive decision 06 §J2 `myDrafts`, §L1;
 * batch 16 plan, lane 16C item 6): their pages that were never published
 * or have unpublished changes, newest first as the cms answers them. Each
 * opens the wiki editor by documentId (a draft has no published route).
 * Every role that edits wiki pages; everyone else goes back to the wiki.
 */
export default async function WikiDraftsPage() {
  const viewer = await getViewer();
  if (capabilitiesFor(viewer.role).wikiPages.edit === "none") redirect("/wiki");
  const [t, tWiki, format] = await Promise.all([
    getTranslations("manage.wiki.drafts"),
    getTranslations("wiki"),
    getFormatter(),
  ]);
  const view = await loadMyWikiDrafts();

  return (
    <div className="space-y-6">
      <ManagePageHeader
        title={t("title")}
        description={t("description")}
        back="/wiki"
        backLabel={tWiki("title")}
      />
      {view.failed && <FetchErrorBanner />}
      {!view.failed && view.rows.length === 0 ? (
        <EmptyState icon={FilePen} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : view.rows.length > 0 ? (
        <ul className="divide-y rounded-2xl border bg-card">
          {view.rows.map((row) => {
            const updated = formatInstant(format, row.updatedAt, {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            });
            return (
              <li key={row.documentId} className="flex flex-col gap-1.5 p-4">
                {row.space ? (
                  <Link
                    href={wikiEditPath(row.space.slug, row.slug, row.documentId)}
                    className="break-words font-medium outline-none hover:text-primary hover:underline focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {row.title || t("untitled")}
                  </Link>
                ) : (
                  <span className="break-words font-medium">{row.title || t("untitled")}</span>
                )}
                <StatusBadges item={{ status: row.status }} />
                <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <span>{row.space ? t("inSpace", { space: row.space.name }) : t("noSpace")}</span>
                  {updated && <span>{t("updated", { date: updated })}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
