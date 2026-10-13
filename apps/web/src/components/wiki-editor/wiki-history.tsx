import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type {
  AuthoringPagination,
  WikiRevisionDetail,
  WikiRevisionEntry,
  WikiRevisionKind,
} from "@sinnlos/domain";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/manage/status-badges";
import { buttonVariants } from "@/components/ui/button";
import { formatInstant, type DateTimeFields } from "@/lib/date-format";
import { wikiHistoryPath } from "@/lib/manage/wiki-paths";
import { cn } from "@/lib/utils";

/**
 * The history of a wiki page (deep-dive decision 06 §J3, §L1; batch 16
 * plan, lane 16C item 6): the versions newest first, each with when, who
 * (a user, the admin panel, or nobody recorded: a baseline), its change
 * note and, for a restore, the version it brought back; and one version's
 * content below the list. Server components: plain links (`?rev=`), so the
 * list works without JavaScript; the restore button is the one client
 * part (restore-revision.tsx).
 *
 * The three kinds (K15): `after`, a save; `baseline`, the page's state at
 * the upgrade to batch 16; `before`, a legacy entry from before batch 16
 * that holds only the text before an edit, labelled "state before an edit
 * (older format)" (spike 5 risk "mixed semantics").
 */

const WHEN: DateTimeFields = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

const KIND_TONE: Readonly<Record<WikiRevisionKind, "neutral" | "info" | "warning">> = {
  after: "neutral",
  baseline: "info",
  before: "warning",
};

/** Who saved a version, in words. */
function useEditorName() {
  const t = useTranslations("manage.wiki.history");
  return (entry: WikiRevisionEntry): string => {
    const editor = entry.editor;
    if (editor && "admin" in editor) return t("editorAdmin");
    if (editor && typeof editor.displayName === "string" && editor.displayName.trim() !== "") {
      return editor.displayName;
    }
    return t("editorNone");
  };
}

export function KindBadge({ kind }: { kind: WikiRevisionKind }) {
  const t = useTranslations("manage.wiki.history.kinds");
  const known: WikiRevisionKind = kind in KIND_TONE ? kind : "after";
  return <Badge tone={KIND_TONE[known]}>{t(known)}</Badge>;
}

export function WikiHistoryList({
  entries,
  spaceSlug,
  slug,
  documentId,
  page,
  selected,
}: {
  entries: WikiRevisionEntry[];
  spaceSlug: string;
  slug: string;
  documentId: string;
  page: number;
  /** The version shown below, if any. */
  selected: number | null;
}) {
  const t = useTranslations("manage.wiki.history");
  const format = useFormatter();
  const editorName = useEditorName();
  return (
    <ol aria-label={t("listLabel")} className="divide-y rounded-2xl border bg-card">
      {entries.map((entry) => {
        const when = formatInstant(format, entry.createdAt, WHEN);
        const current = entry.id === selected;
        return (
          <li
            key={entry.id}
            className={cn(
              "flex flex-col gap-2 p-4 sm:flex-row sm:items-start",
              current && "bg-primary/5",
            )}
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t("version", { id: entry.id })}</span>
                <KindBadge kind={entry.kind} />
              </div>
              <p className="break-words text-sm">
                {entry.title ?? <span className="italic">{t("untitled")}</span>}
              </p>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                {when && <span>{when}</span>}
                <span>{t("by", { name: editorName(entry) })}</span>
                {entry.restoredFrom !== null && (
                  <span>{t("restoredFrom", { id: entry.restoredFrom })}</span>
                )}
              </div>
              {entry.changeSummary && (
                <p className="break-words text-sm text-muted-foreground">
                  {t("note", { note: entry.changeSummary })}
                </p>
              )}
            </div>
            <div className="shrink-0">
              {current ? (
                <span className="text-sm text-muted-foreground" aria-current="true">
                  {t("shown")}
                </span>
              ) : (
                <Link
                  href={wikiHistoryPath(spaceSlug, slug, documentId, {
                    revision: entry.id,
                    page,
                  })}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  aria-label={t("showLabel", { id: entry.id })}
                >
                  {t("show")}
                </Link>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function WikiHistoryPagination({
  pagination,
  spaceSlug,
  slug,
  documentId,
}: {
  pagination: AuthoringPagination;
  spaceSlug: string;
  slug: string;
  documentId: string;
}) {
  const t = useTranslations("manage.common.list");
  const tHistory = useTranslations("manage.wiki.history");
  const { page, pageCount } = pagination;
  if (pageCount <= 1) return null;
  const link = buttonVariants({ variant: "outline", size: "sm" });
  return (
    <nav
      aria-label={tHistory("pagination")}
      className="flex flex-wrap items-center justify-end gap-2 text-sm text-muted-foreground"
    >
      {page > 1 && (
        <Link
          href={wikiHistoryPath(spaceSlug, slug, documentId, { page: page - 1 })}
          className={link}
          rel="prev"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only sm:not-sr-only">{t("previous")}</span>
        </Link>
      )}
      <span aria-current="page">{t("page", { page, pageCount })}</span>
      {page < pageCount && (
        <Link
          href={wikiHistoryPath(spaceSlug, slug, documentId, { page: page + 1 })}
          className={link}
          rel="next"
        >
          <span className="sr-only sm:not-sr-only">{t("next")}</span>
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      )}
    </nav>
  );
}

/**
 * One version's content: its title, summary and text, rendered with the
 * readers' Markdown renderer (UI03: no raw HTML, unsafe links dropped). A
 * legacy entry holds the text only, which the preview says.
 */
export function WikiRevisionPreview({
  revision,
  children,
}: {
  revision: WikiRevisionDetail;
  /** The restore button. */
  children?: React.ReactNode;
}) {
  const t = useTranslations("manage.wiki.history");
  const format = useFormatter();
  const editorName = useEditorName();
  const when = formatInstant(format, revision.createdAt, WHEN);
  const legacy = revision.kind === "before";
  return (
    <section aria-labelledby="wiki-revision" className="space-y-4">
      <div className="space-y-1">
        <h2 id="wiki-revision" className="flex flex-wrap items-center gap-2 text-lg font-semibold">
          {t("previewTitle", { id: revision.id })}
          <KindBadge kind={revision.kind} />
        </h2>
        <p className="text-sm text-muted-foreground">
          {[when, t("by", { name: editorName(revision) })].filter(Boolean).join(" · ")}
        </p>
      </div>
      {legacy && (
        <p className="rounded-xl border border-amber-600/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          {t("previewLegacy")}
        </p>
      )}
      <article className="space-y-3 rounded-2xl border border-dashed p-4 sm:p-6">
        {revision.title && (
          <h3 className="break-words text-2xl font-semibold tracking-tight">{revision.title}</h3>
        )}
        {revision.pageSummary && (
          <p className="break-words text-muted-foreground">{revision.pageSummary}</p>
        )}
        {revision.body && revision.body.trim() !== "" ? (
          <Markdown className="prose prose-slate max-w-none dark:prose-invert">
            {revision.body}
          </Markdown>
        ) : (
          <p className="text-sm italic text-muted-foreground">{t("emptyBody")}</p>
        )}
      </article>
      {children}
    </section>
  );
}
