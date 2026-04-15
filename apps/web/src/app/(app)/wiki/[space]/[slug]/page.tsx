import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import { api } from "@/lib/strapi";

interface Props {
  params: Promise<{ space: string; slug: string }>;
}

export default async function WikiPage({ params }: Props) {
  const { space, slug } = await params;
  const data = await api.wiki.page(space, slug).catch(() => null);
  const entry = data?.data?.[0];
  if (!entry) notFound();
  const attrs = entry.attributes ?? entry;

  const author = attrs.author?.data ?? attrs.author;
  const lastEditor = attrs.lastEditor?.data ?? attrs.lastEditor;
  const updated = attrs.updatedAt ? new Date(attrs.updatedAt) : null;

  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <header className="border-b pb-6">
        <h1 className="text-4xl font-semibold tracking-tight">{attrs.title}</h1>
        {attrs.summary ? (
          <p className="mt-2 text-lg text-muted-foreground">{attrs.summary}</p>
        ) : null}
        <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
          {author ? <span>by {author.displayName ?? author.username}</span> : null}
          {lastEditor && lastEditor !== author ? (
            <span>· last edited by {lastEditor.displayName ?? lastEditor.username}</span>
          ) : null}
          {updated ? <span>· {updated.toLocaleString()}</span> : null}
        </div>
      </header>

      <div className="prose prose-neutral max-w-none dark:prose-invert">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSlug, [rehypeAutolinkHeadings, { behavior: "wrap" }]]}
        >
          {attrs.body ?? ""}
        </ReactMarkdown>
      </div>
    </article>
  );
}
