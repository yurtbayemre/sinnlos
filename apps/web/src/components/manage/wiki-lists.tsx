import Link from "next/link";
import { Eye, FileText, History } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type { WikiSpaceListRow } from "@sinnlos/domain";
import { ICONS } from "@/components/icon-map";
import { buttonVariants } from "@/components/ui/button";
import { formatInstant } from "@/lib/date-format";
import { areaItemPath } from "@/lib/manage/areas";
import type { WikiTreeNode } from "@/lib/loaders/manage/wiki";
import { wikiEditPath, wikiHistoryPath, wikiPagePath } from "@/lib/manage/wiki-paths";
import { cn } from "@/lib/utils";
import { wikiSpaceIconName } from "@/lib/wiki-content";
import { Badge, StatusBadges } from "./status-badges";

/**
 * The lists of /manage/wiki (deep-dive decision 06 §L1; batch 16 plan, lane
 * 16C item 4): the spaces, and one space's page tree with each page's
 * status (Draft, Published, Changes pending, Scheduled, Schedule failed).
 * Plain links, so everything works without JavaScript. Server components
 * (next-intl's hooks work in both).
 */

const UPDATED = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
} as const;

export function WikiSpaceList({ rows }: { rows: WikiSpaceListRow[] }) {
  const t = useTranslations("manage.wiki");
  return (
    <ul className="divide-y rounded-2xl border bg-card">
      {rows.map((row) => {
        const Icon = ICONS[wikiSpaceIconName(row.icon)];
        return (
          <li key={row.documentId} className="flex items-start gap-3 p-4">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
            >
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1 space-y-1.5">
              <Link
                href={areaItemPath("wiki", row.documentId)}
                className="block break-words font-medium outline-none hover:text-primary hover:underline focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring"
              >
                {row.label || "–"}
              </Link>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="neutral">{t(`visibility.${row.visibility}`)}</Badge>
                <Badge tone="neutral">{t("list.pages", { count: row.pageCount })}</Badge>
                {row.needsRetarget && (
                  <StatusBadges item={{ status: row.status, needsRetarget: true }} hideStatus />
                )}
              </div>
              <p className="break-all text-xs text-muted-foreground">
                {t("list.address", { slug: row.slug })}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The links of one page row: edit, view (published), history. */
function PageLinks({ node, spaceSlug }: { node: WikiTreeNode; spaceSlug: string }) {
  const t = useTranslations("manage.wiki.space");
  const { row } = node;
  const title = row.label || t("untitled");
  const link = cn(buttonVariants({ variant: "ghost", size: "icon" }), "h-8 w-8");
  return (
    <div className="flex shrink-0 items-center gap-1">
      {row.publishedAt !== null && (
        <Link
          href={wikiPagePath(spaceSlug, row.slug)}
          className={link}
          aria-label={t("viewPage", { title })}
          title={t("viewPage", { title })}
        >
          <Eye className="h-4 w-4" aria-hidden="true" />
        </Link>
      )}
      <Link
        href={wikiHistoryPath(spaceSlug, row.slug, row.documentId)}
        className={link}
        aria-label={t("history", { title })}
        title={t("history", { title })}
      >
        <History className="h-4 w-4" aria-hidden="true" />
      </Link>
    </div>
  );
}

function TreeItems({
  nodes,
  spaceSlug,
  depth,
}: {
  nodes: WikiTreeNode[];
  spaceSlug: string;
  depth: number;
}) {
  const t = useTranslations("manage.wiki.space");
  const tList = useTranslations("manage.common.list");
  const format = useFormatter();
  return (
    <ul className={cn(depth > 0 && "ml-3 border-l pl-3 sm:ml-5 sm:pl-4")}>
      {nodes.map((node) => {
        const { row } = node;
        const title = row.label || t("untitled");
        const updated = formatInstant(format, row.updatedAt, UPDATED);
        return (
          <li key={row.documentId} className="py-1.5">
            <div className="flex items-start gap-2 rounded-xl px-2 py-2 hover:bg-muted/40">
              <FileText
                className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1 space-y-1">
                <Link
                  href={wikiEditPath(spaceSlug, row.slug, row.documentId)}
                  className="block break-words font-medium outline-none hover:text-primary hover:underline focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={t("editPage", { title })}
                >
                  {title}
                </Link>
                <StatusBadges item={row} />
                <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  {updated && <span>{tList("updated", { date: updated })}</span>}
                  {row.authorName && <span>{tList("by", { name: row.authorName })}</span>}
                </div>
              </div>
              <PageLinks node={node} spaceSlug={spaceSlug} />
            </div>
            {node.children.length > 0 && (
              <TreeItems nodes={node.children} spaceSlug={spaceSlug} depth={depth + 1} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A space's pages as nested lists (the outline a screen reader announces
 * with its levels), each with its status badges; the title opens the wiki
 * editor (a draft has no published route: the link names the documentId).
 */
export function WikiPageTree({
  nodes,
  spaceSlug,
  label,
}: {
  nodes: WikiTreeNode[];
  spaceSlug: string;
  label: string;
}) {
  return (
    <nav aria-label={label} className="rounded-2xl border bg-card p-2 sm:p-3">
      <TreeItems nodes={nodes} spaceSlug={spaceSlug} depth={0} />
    </nav>
  );
}
