import { Markdown } from "@/components/markdown";
import { stripHtml } from "@/lib/utils";

/** Legacy panel HTML remains escaped plain text; new Markdown uses the existing safe renderer. */
export function OrgDescription({
  value,
  empty,
}: {
  value: string | null | undefined;
  empty: string;
}) {
  if (!value) return <p className="mt-1 text-muted-foreground">{empty}</p>;
  if (/<\/?[a-z][^>]*>|<!--/i.test(value)) {
    return (
      <p className="mt-1 whitespace-pre-line text-muted-foreground">{stripHtml(value) || empty}</p>
    );
  }
  return (
    <Markdown className="prose prose-sm mt-2 max-w-none text-muted-foreground dark:prose-invert">
      {value}
    </Markdown>
  );
}
