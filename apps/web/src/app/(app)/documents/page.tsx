import { ChevronLeft, ChevronRight, FileText, Download, File, ClipboardCheck } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { fetchMyDocumentAcks } from "@/lib/acknowledgements";
import { formatInstant, LONG_DAY, SHORT_DAY } from "@/lib/date-format";
import { isReadDenied } from "@/lib/roles";
import { isOff } from "@/lib/switches";
import { api } from "@/lib/strapi";
import { SKIPPED_READ, tryFetch } from "@/lib/safe-fetch";
import { getViewer } from "@/lib/viewer";
import { pageParam, type ListSearchParams } from "@/lib/loaders/manage/list";
import { mediaUrl } from "@/lib/config";
import { formatKilobytes } from "@/lib/manage/upload-check";
import type { Document } from "@/lib/types";
import { AckButton } from "@/components/announcements/ack-button";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export async function generateMetadata() {
  const t = await getTranslations("documents");
  return { title: t("title") };
}

/** The document categories, each with its label in the `documents` namespace. */
const DOCUMENT_CATEGORIES = [
  "policy",
  "form",
  "template",
  "guide",
  "other",
] as const satisfies readonly NonNullable<Document["category"]>[];

/** A category this web has a label for (the cms may know a newer one). */
function isDocumentCategory(value: string): value is (typeof DOCUMENT_CATEGORIES)[number] {
  return (DOCUMENT_CATEGORIES as readonly string[]).includes(value);
}

/** The library's URL for `page`; page 1 has no parameter. */
const documentsHref = (page: number) =>
  (page > 1 ? `/documents?page=${page}` : "/documents") as Route;

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<ListSearchParams>;
}) {
  const page = pageParam(await searchParams);
  // `format` renders instants in APP_TIME_ZONE (i18n/request.ts).
  const [t, tCommon, tList, format, viewer] = await Promise.all([
    getTranslations("documents"),
    getTranslations("common"),
    getTranslations("manage.common.list"),
    getFormatter(),
    getViewer(),
  ]);
  const updatedLabel = (iso: string | undefined) => formatInstant(format, iso, SHORT_DAY);
  const { data, failed: docsFailed } = await tryFetch(() => api.documents.list(page), "documents");
  const docs = (data?.data ?? []) as Document[];
  // A page past the end (an old link after deletions) starts over.
  if (!docsFailed && page > 1 && docs.length === 0) redirect(documentsHref(1));
  const pageCount = data?.meta?.pagination?.pageCount ?? 1;
  const pagerLink = buttonVariants({ variant: "outline", size: "sm" });

  // Read confirmation (v0.20): only a role holding the acknowledgement
  // grants confirms (guest reads documents, never acknowledges). Without
  // receipts every mandatory document shows its button, with the banner.
  // Nobody confirms while FEATURES_OFF switches read confirmations off.
  const canAck = !isReadDenied(viewer.role, "acknowledgements") && !isOff("read-confirmations");
  const receipts =
    canAck && docs.some((d) => d.requiresAck)
      ? await tryFetch(() => fetchMyDocumentAcks(), "documents")
      : SKIPPED_READ;
  const acknowledgedAt = new Map<string, string | null>();
  for (const ack of receipts.data?.acks ?? []) {
    if (!acknowledgedAt.has(ack.targetDocumentId)) {
      acknowledgedAt.set(ack.targetDocumentId, ack.acknowledgedAt ?? null);
    }
  }
  const failed = docsFailed || receipts.failed;

  const grouped = new Map<string, Document[]>();
  for (const d of docs) {
    const cat = d.category ?? "other";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(d);
  }

  return (
    <div className="space-y-8">
      <PageHeader title={t("title")} description={t("description")} />

      {failed && <FetchErrorBanner />}

      {docs.length === 0 ? (
        <EmptyState icon={FileText} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        Array.from(grouped.entries()).map(([category, items]) => (
          <section key={category} className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <FileText className="h-3.5 w-3.5" />
              {isDocumentCategory(category) ? t(category) : category}
            </div>
            <div className="stagger space-y-2">
              {items.map((doc) => {
                // An /uploads/… path stays relative: it goes through the
                // web's session-gated proxy, never straight to the cms
                // host (WD10, batch 16 plan S21).
                const fileUrl = mediaUrl(doc.file?.url);
                return (
                  <Card key={doc.id}>
                    <CardContent className="flex items-center gap-4 p-4">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <File className="h-5 w-5" aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{doc.title}</div>
                        {doc.description && (
                          <div className="mt-0.5 truncate text-sm text-muted-foreground">
                            {doc.description}
                          </div>
                        )}
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          {canAck && doc.requiresAck && (
                            <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400">
                              <ClipboardCheck className="h-3.5 w-3.5" aria-hidden="true" />
                              {t("ackRequired")}
                            </span>
                          )}
                          {doc.file?.name && <span>{doc.file.name}</span>}
                          {doc.file?.size ? <span>{formatKilobytes(doc.file.size)}</span> : null}
                          {updatedLabel(doc.updatedAt) && (
                            <span>
                              {tCommon("updated")} {updatedLabel(doc.updatedAt)}
                            </span>
                          )}
                        </div>
                        {canAck && doc.requiresAck && doc.documentId && (
                          <div className="mt-3">
                            <AckButton
                              targetType="document"
                              targetDocumentId={doc.documentId}
                              acknowledgedAtLabel={
                                acknowledgedAt.has(doc.documentId)
                                  ? (formatInstant(
                                      format,
                                      acknowledgedAt.get(doc.documentId),
                                      LONG_DAY,
                                    ) ?? "")
                                  : null
                              }
                              deadlineLabel={null}
                            />
                          </div>
                        )}
                      </div>
                      {fileUrl && (
                        <a
                          href={fileUrl}
                          download
                          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors hover:bg-muted outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                          title={tCommon("download")}
                          aria-label={tCommon("download")}
                        >
                          <Download className="h-4 w-4" aria-hidden="true" />
                        </a>
                      )}
                      {!fileUrl && (
                        // Make the file-less state explicit: without this hint a
                        // card is silently inert and reads as broken.
                        <span className="shrink-0 text-xs italic text-muted-foreground">
                          {t("noFile")}
                        </span>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>
        ))
      )}

      {pageCount > 1 && (
        <nav
          aria-label={tList("pagination")}
          className="flex flex-wrap items-center justify-end gap-2 text-sm text-muted-foreground"
        >
          {page > 1 && (
            <Link href={documentsHref(page - 1)} className={pagerLink} rel="prev">
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">{tList("previous")}</span>
            </Link>
          )}
          <span aria-current="page">{tList("page", { page, pageCount })}</span>
          {page < pageCount && (
            <Link href={documentsHref(page + 1)} className={pagerLink} rel="next">
              <span className="sr-only sm:not-sr-only">{tList("next")}</span>
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
