import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown, { type Options as MarkdownOptions } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import { ArrowLeft, Tag } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { formatInstant, LONG_DAY } from "@/lib/date-format";
import { api } from "@/lib/strapi";
import type { WikiPage as WikiPageEntry } from "@/lib/types";
import { rehypeWikiToc, showsToc, wikiTags } from "@/lib/wiki-content";

interface Props {
  params: Promise<{ space: string; slug: string }>;
}

export default async function WikiPage({ params }: Props) {
  const { space, slug } = await params;
  // `format` renders instants in APP_TIME_ZONE (i18n/request.ts).
  const [t, tCommon, format] = await Promise.all([
    getTranslations("wiki"),
    getTranslations("common"),
    getFormatter(),
  ]);
  // Let fetch errors propagate to app/(app)/error.tsx so the user sees a
  // retry prompt instead of a misleading 404.
  const data = await api.wiki.page(space, slug);
  const entry = data.data?.[0] as WikiPageEntry | undefined;
  if (!entry) notFound();

  const author = entry.author;
  const lastEditor = entry.lastEditor;
  // By user id (FX24): author and lastEditor are separate objects in every
  // response, so an identity check showed "last edited by" on every page,
  // the author's own edits included.
  const showLastEditor = !!lastEditor && lastEditor.id !== author?.id;
  // An instant, shown as its day in APP_TIME_ZONE (next-intl's formatter).
  const updated = formatInstant(format, entry.updatedAt, LONG_DAY);
  // DA02: tags as chips, and the table of contents unless the page turns it
  // off; the TOC is labelled with the page title (no new message key).
  const tags = wikiTags(entry.tags);
  const rehypePlugins: NonNullable<MarkdownOptions["rehypePlugins"]> = [
    rehypeSlug,
    [rehypeAutolinkHeadings, { behavior: "wrap" }],
  ];
  // After rehype-slug: the TOC links the ids it gave the headings.
  if (showsToc(entry.tocEnabled)) rehypePlugins.push([rehypeWikiToc, { label: entry.title }]);

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
        <h1 className="text-4xl font-semibold tracking-tight">{entry.title}</h1>
        {entry.summary ? (
          <p className="mt-2 text-lg text-muted-foreground">{entry.summary}</p>
        ) : null}
        <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
          {author ? (
            <span>
              {tCommon("by")} {author.displayName ?? author.username}
            </span>
          ) : null}
          {showLastEditor ? (
            <span>
              · {t("lastEditedBy", { name: lastEditor.displayName ?? lastEditor.username ?? "" })}
            </span>
          ) : null}
          {updated ? <span>· {updated}</span> : null}
        </div>
        {tags.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Tag className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <ul className="flex flex-wrap gap-1.5">
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

      <div className="prose prose-slate max-w-none dark:prose-invert">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins}>
          {entry.body ?? ""}
        </ReactMarkdown>
      </div>
    </article>
  );
}
