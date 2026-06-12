import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { api } from "@/lib/strapi";
import type { WikiPage as WikiPageEntry } from "@/lib/types";

interface Props {
  params: Promise<{ space: string; slug: string }>;
}

export default async function WikiPage({ params }: Props) {
  const { space, slug } = await params;
  const [t, tCommon] = await Promise.all([
    getTranslations("wiki"),
    getTranslations("common"),
  ]);
  // Let fetch errors propagate to app/(app)/error.tsx so the user sees a
  // retry prompt instead of a misleading 404.
  const data = await api.wiki.page(space, slug);
  const entry = data.data?.[0] as WikiPageEntry | undefined;
  if (!entry) notFound();

  const author = entry.author;
  const lastEditor = entry.lastEditor;
  const updated = entry.updatedAt ? new Date(entry.updatedAt) : null;

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
          {author ? <span>{tCommon("by")} {author.displayName ?? author.username}</span> : null}
          {lastEditor && lastEditor !== author ? (
            <span>· {t("lastEditedBy", { name: lastEditor.displayName ?? lastEditor.username })}</span>
          ) : null}
          {updated ? <span>· {updated.toLocaleString()}</span> : null}
        </div>
      </header>

      <div className="prose prose-neutral max-w-none dark:prose-invert">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSlug, [rehypeAutolinkHeadings, { behavior: "wrap" }]]}
        >
          {entry.body ?? ""}
        </ReactMarkdown>
      </div>
    </article>
  );
}
