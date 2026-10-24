import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, History, Pencil, Tag } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { Markdown, type MarkdownRehypePlugins } from "@/components/markdown";
import { buttonVariants } from "@/components/ui/button";
import type { WikiPageDetail } from "@/lib/api/wiki";
import { formatInstant, LONG_DAY } from "@/lib/date-format";
import { canEditWikiPage } from "@/lib/manage/wiki-edit-access";
import { wikiEditPath, wikiHistoryPath } from "@/lib/manage/wiki-paths";
import { capabilitiesFor } from "@/lib/roles";
import { tryFetch } from "@/lib/safe-fetch";
import { api } from "@/lib/strapi";
import { displayNameOf } from "@/lib/utils";
import { getViewer } from "@/lib/viewer";
import { rehypeWikiToc, showsToc, wikiTags } from "@/lib/wiki-content";

interface Props {
  params: Promise<{ space: string; slug: string }>;
}

export async function generateMetadata({ params }: Props) {
  const { space, slug } = await params;
  const t = await getTranslations("wiki");
  // Same GET as the page's, sent once per render (Next's fetch dedupe).
  const { data } = await tryFetch(() => api.wiki.page(space, slug), "wiki-page-meta");
  const entry = data?.data?.[0] as WikiPageDetail | undefined;
  return { title: entry?.title ?? t("title") };
}

export default async function WikiPage({ params }: Props) {
  const { space, slug } = await params;
  // `format` renders instants in APP_TIME_ZONE (i18n/request.ts).
  const [t, tCommon, format, viewer] = await Promise.all([
    getTranslations("wiki"),
    getTranslations("common"),
    getFormatter(),
    getViewer(),
  ]);
  // Let fetch errors propagate to app/(app)/error.tsx so the user sees a
  // retry prompt instead of a misleading 404.
  const data = await api.wiki.page(space, slug);
  const entry = data.data?.[0] as WikiPageDetail | undefined;
  if (!entry) notFound();
  // Edit and History (batch 16, K17): the cms's own row rule on the page's
  // author, department and team lead; UX only, the editor's `editable`
  // decides (lib/manage/wiki-edit-access.ts).
  const editable = canEditWikiPage(viewer, capabilitiesFor(viewer.role), entry);

  const author = entry.author;
  const lastEditor = entry.lastEditor;
  // By user id (FX24): author and lastEditor are separate objects in every
  // response, so an identity check showed "last edited by" on every page,
  // the author's own edits included.
  const showLastEditor = !!lastEditor && lastEditor.id !== author?.id;
  // An instant, shown as its day in APP_TIME_ZONE (next-intl's formatter).
  const updated = formatInstant(format, entry.updatedAt, LONG_DAY);
  // DA02: tags as chips, and the table of contents unless the page turns it
  // off. Both lists are named for screen readers (wiki.tags, wiki.contents):
  // the chips' only other label is an aria-hidden icon.
  const tags = wikiTags(entry.tags);
  // The shared renderer (UI03) runs these after its heading anchors
  // (rehype-slug), so the TOC links the ids the headings got.
  const tocPlugins: MarkdownRehypePlugins = showsToc(entry.tocEnabled)
    ? [[rehypeWikiToc, { label: t("contents") }]]
    : [];

  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <header className="border-b pb-6">
        <Link
          href={`/wiki/${space}`}
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {entry.space?.name ?? t("backToSpace")}
        </Link>
        <h1 className="wrap-break-word text-4xl font-semibold tracking-tight">{entry.title}</h1>
        {entry.summary ? (
          <p className="mt-2 text-lg text-muted-foreground">{entry.summary}</p>
        ) : null}
        <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
          {author ? (
            <span>
              {tCommon("by")} {displayNameOf(author, "")}
            </span>
          ) : null}
          {showLastEditor ? (
            <span>· {t("lastEditedBy", { name: displayNameOf(lastEditor, "") })}</span>
          ) : null}
          {updated ? <span>· {updated}</span> : null}
        </div>
        {editable && entry.documentId ? (
          <div role="group" aria-label={t("pageActions")} className="mt-4 flex flex-wrap gap-2">
            <Link
              href={wikiEditPath(space, slug, entry.documentId)}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <Pencil className="h-4 w-4" aria-hidden="true" />
              {t("edit")}
            </Link>
            <Link
              href={wikiHistoryPath(space, slug, entry.documentId)}
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              <History className="h-4 w-4" aria-hidden="true" />
              {t("history")}
            </Link>
          </div>
        ) : null}
        {tags.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Tag className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <ul className="flex flex-wrap gap-1.5" aria-label={t("tags")}>
              {tags.map((tag) => (
                <li
                  key={tag}
                  className="rounded-full border bg-muted/50 px-2.5 py-0.5 text-xs text-muted-foreground"
                >
                  {tag}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </header>

      <Markdown headingAnchors rehypePlugins={tocPlugins}>
        {entry.body}
      </Markdown>
    </article>
  );
}
