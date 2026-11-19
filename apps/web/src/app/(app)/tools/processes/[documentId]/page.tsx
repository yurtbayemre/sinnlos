import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { ProcessViewerLazy } from "@/components/processes/process-viewer-lazy";
import { SectionUnavailablePage } from "@/components/section-unavailable";
import { buttonVariants } from "@/components/ui/button";
import { isDocumentId } from "@/lib/entry-id";
import { loadProcess } from "@/lib/loaders/processes";
import { tryFetch } from "@/lib/safe-fetch";
import { isReadDenied } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { getViewer } from "@/lib/viewer";

export async function generateMetadata({ params }: Params) {
  const { documentId } = await params;
  // A malformed id never reaches the CMS (WD07).
  if (!isDocumentId(documentId)) notFound();
  const t = await getTranslations("processes");
  // No read for a role that cannot read processes (SH02); a failed read gives the section title.
  if (isReadDenied((await getViewer()).role, "processes")) return { title: t("title") };
  const { data } = await tryFetch(() => loadProcess(documentId), "process-meta");
  return { title: data?.title ?? t("title") };
}

type Params = { params: Promise<{ documentId: string }> };

/**
 * One process (v1.1 "Tools"): its description above the diagram (the
 * description is the diagram's text alternative), the bpmn-js viewer loaded
 * in the browser only, and the downloads (.bpmn, .svg). Detail-page error
 * strategy (WD07): a malformed or unknown id is a 404 (the malformed one
 * sends no request); a failed read goes to (app)/error.tsx.
 */
export default async function ProcessPage({ params }: Params) {
  const { documentId } = await params;
  const [t, viewer] = await Promise.all([getTranslations("processes"), getViewer()]);
  if (isReadDenied(viewer.role, "processes")) {
    return <SectionUnavailablePage title={t("title")} description={t("description")} />;
  }
  if (!isDocumentId(documentId)) notFound();
  const [process, format] = await Promise.all([loadProcess(documentId), getFormatter()]);
  if (!process) notFound();
  const back = (
    <Link href="/tools/processes" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {t("back")}
    </Link>
  );
  return (
    <div className="space-y-6">
      {back}
      <PageHeader
        title={process.title}
        eyebrow={process.department?.name ?? t("companyWide")}
        description={
          process.updatedAt
            ? t("updated", {
                date: format.dateTime(new Date(process.updatedAt), { dateStyle: "medium" }),
              })
            : undefined
        }
      />
      <section aria-labelledby="process-summary" className="space-y-2">
        <h2 id="process-summary" className="text-lg font-semibold tracking-tight">
          {t("summaryHeading")}
        </h2>
        <p className="max-w-3xl whitespace-pre-line">{process.summary}</p>
      </section>
      <section aria-labelledby="process-diagram" className="space-y-2">
        <h2 id="process-diagram" className="text-lg font-semibold tracking-tight">
          {t("diagramHeading")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("diagramNote")}</p>
        <ProcessViewerLazy title={process.title} xml={process.diagram} />
      </section>
    </div>
  );
}
