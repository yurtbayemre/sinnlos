import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { History, Pencil } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { RestoreRevision } from "@/components/wiki-editor/restore-revision";
import {
  WikiHistoryList,
  WikiHistoryPagination,
  WikiRevisionPreview,
} from "@/components/wiki-editor/wiki-history";
import { pageParam, type ListSearchParams } from "@/lib/loaders/manage/list";
import {
  loadWikiHistory,
  loadWikiPageEditable,
  loadWikiRevision,
  resolveWikiPageId,
  revisionParam,
} from "@/lib/loaders/manage/wiki";
import {
  wikiEditPath,
  wikiHistoryPath,
  wikiPagePath,
  wikiSpacePath,
} from "@/lib/manage/wiki-paths";
import { capabilitiesFor } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";

type Props = {
  params: Promise<{ space: string; slug: string }>;
  searchParams: Promise<ListSearchParams>;
};

export async function generateMetadata() {
  const t = await getTranslations("manage.wiki.history");
  return { title: t("title") };
}

/**
 * A wiki page's history (deep-dive decision 06 §J3, §L1; batch 16 plan,
 * lane 16C item 6; question 9): for the page's editors (its author, its
 * department's head, its team's lead) and moderators, not every reader.
 * The page resolves like the editor's (`?doc=`, else the published page);
 * `editable` decides access and gives the version a restore sends. The
 * versions come newest first, 25 per page; `?rev=` shows one version below
 * the list with "Restore this version". A version of another page answers
 * the not-found text, never its content.
 */
export default async function WikiHistoryPage({ params, searchParams }: Props) {
  const [{ space: spaceSlug, slug }, query] = await Promise.all([params, searchParams]);
  const viewer = await getViewer();
  if (capabilitiesFor(viewer.role).wikiPages.edit === "none") {
    redirect(wikiPagePath(spaceSlug, slug));
  }
  const t = await getTranslations("manage.wiki.history");
  const tEditor = await getTranslations("manage.wiki.editor");
  const failed = (
    <div className="space-y-8">
      <ManagePageHeader
        title={t("title")}
        back={wikiSpacePath(spaceSlug)}
        backLabel={tEditor("backToSpace", { space: spaceSlug })}
      />
      <FetchErrorBanner />
    </div>
  );

  const ref = await resolveWikiPageId(spaceSlug, slug, query.doc);
  if (!ref.documentId) {
    if (ref.failed) return failed;
    notFound();
  }
  const page = pageParam(query);
  const revisionId = revisionParam(query);
  const [load, history, revision] = await Promise.all([
    loadWikiPageEditable(ref.documentId),
    loadWikiHistory(ref.documentId, page),
    revisionId === null ? null : loadWikiRevision(ref.documentId, revisionId),
  ]);
  if (load.state === "notFound" || history.state === "notFound") notFound();
  if (load.state === "failed") return failed;
  const { editable } = load;
  if (editable.space && (editable.space.slug !== spaceSlug || editable.slug !== slug)) {
    redirect(
      wikiHistoryPath(editable.space.slug, editable.slug, editable.documentId, {
        page,
        ...(revisionId ? { revision: revisionId } : {}),
      }),
    );
  }
  const space = editable.space?.slug ?? spaceSlug;
  const published = editable.publishedAt !== null;
  const restorePage = {
    documentId: editable.documentId,
    version: editable.version,
    status: editable.status,
    publishedAt: editable.publishedAt,
  };
  const link = buttonVariants({ variant: "outline", size: "sm" });

  return (
    <div className="space-y-6">
      <ManagePageHeader
        title={t("title")}
        description={t("description", { title: editable.title })}
        back={published ? wikiPagePath(space, editable.slug) : wikiSpacePath(space)}
        backLabel={
          published
            ? t("backToPage")
            : tEditor("backToSpace", { space: editable.space?.name ?? space })
        }
      />
      <div className="flex flex-wrap gap-2">
        <Link href={wikiEditPath(space, editable.slug, editable.documentId)} className={link}>
          <Pencil className="h-4 w-4" aria-hidden="true" />
          {t("backToEditor")}
        </Link>
      </div>

      {history.state === "failed" ? (
        <FetchErrorBanner />
      ) : history.entries.length === 0 ? (
        <EmptyState icon={History} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        <>
          <WikiHistoryList
            entries={history.entries}
            spaceSlug={space}
            slug={editable.slug}
            documentId={editable.documentId}
            page={page}
            selected={revisionId}
          />
          <WikiHistoryPagination
            pagination={history.pagination}
            spaceSlug={space}
            slug={editable.slug}
            documentId={editable.documentId}
          />
        </>
      )}

      {revision?.state === "ok" && (
        <WikiRevisionPreview revision={revision.revision}>
          <RestoreRevision
            page={restorePage}
            revisionId={revision.revision.id}
            legacy={revision.revision.kind === "before"}
          />
        </WikiRevisionPreview>
      )}
      {revision?.state === "notFound" && (
        <p
          role="status"
          className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground"
        >
          {t("previewNotFound")}
        </p>
      )}
      {revision?.state === "failed" && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          {t("previewFailed")}
        </p>
      )}
    </div>
  );
}
