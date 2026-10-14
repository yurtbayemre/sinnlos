import Link from "next/link";
import { notFound } from "next/navigation";
import type { Route } from "next";
import { BookOpen, ExternalLink, Pencil } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { StatusBadges } from "@/components/manage/status-badges";
import { WikiPageTree } from "@/components/manage/wiki-lists";
import { buttonVariants } from "@/components/ui/button";
import { canDo } from "@/lib/manage/access";
import { AREA_PATH, areaItemPath } from "@/lib/manage/areas";
import { areaGate } from "@/lib/manage/page-gate";
import { wikiNewPagePath, wikiSpacePath } from "@/lib/manage/wiki-paths";
import { loadWikiPageTree, loadWikiSpaceEditable } from "@/lib/loaders/manage/wiki";

type Params = { params: Promise<{ space: string }> };

export async function generateMetadata() {
  const t = await getTranslations("manage.wiki");
  return { title: t("space.pagesTitle") };
}

/**
 * One space's page tree in /manage/wiki (deep-dive decision 06 §L1; batch
 * 16 plan, lane 16C item 4; moderators only): every page of the space from
 * the moderators' wiki-page authoringList, drafts and schedules included,
 * nested under its parent with its status badges. The space is addressed by
 * its documentId. New pages are written in the wiki itself.
 */
export default async function ManageWikiSpacePage({ params }: Params) {
  const { space: documentId } = await params;
  const { access, capabilities } = await areaGate("wiki");
  const t = await getTranslations("manage.wiki");
  const load = await loadWikiSpaceEditable(documentId);
  if (load.state === "notFound") notFound();
  if (load.state === "failed") {
    return (
      <div className="space-y-8">
        <ManagePageHeader
          title={t("space.pagesTitle")}
          back={AREA_PATH.wiki}
          backLabel={t("title")}
        />
        <FetchErrorBanner />
      </div>
    );
  }
  const space = load.editable;
  const tree = await loadWikiPageTree(space.documentId);
  const link = buttonVariants({ variant: "outline", size: "sm" });

  return (
    <div className="space-y-6">
      <ManagePageHeader
        title={space.name}
        description={t("space.description")}
        back={AREA_PATH.wiki}
        backLabel={t("title")}
        action={
          capabilities.wikiPages.create
            ? { href: wikiNewPagePath(space.slug), label: t("space.newPage") }
            : undefined
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        {canDo(access, "edit") && (
          <Link href={`${areaItemPath("wiki", space.documentId)}/edit` as Route} className={link}>
            <Pencil className="h-4 w-4" aria-hidden="true" />
            {t("space.edit")}
          </Link>
        )}
        <Link href={wikiSpacePath(space.slug)} className={link}>
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
          {t("space.open")}
        </Link>
        <StatusBadges
          item={{ status: space.status, needsRetarget: space.needsRetarget }}
          hideStatus
        />
      </div>
      {tree.failed && <FetchErrorBanner />}
      {tree.truncated && (
        <p className="rounded-xl border border-amber-600/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          {t("space.truncated")}
        </p>
      )}
      <section aria-labelledby="wiki-pages" className="space-y-3">
        <h2 id="wiki-pages" className="text-lg font-semibold">
          {t("space.pagesTitle")}
        </h2>
        {!tree.failed && tree.nodes.length === 0 ? (
          <EmptyState icon={BookOpen} title={t("space.emptyTitle")} hint={t("space.emptyHint")} />
        ) : tree.nodes.length > 0 ? (
          <WikiPageTree
            nodes={tree.nodes}
            spaceSlug={space.slug}
            label={t("space.treeLabel", { space: space.name })}
          />
        ) : null}
      </section>
    </div>
  );
}
