import type { ComponentProps } from "react";
import Link from "next/link";
import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

/**
 * What a page shows instead of a section the viewer's role cannot read
 * (SH02, lib/roles.ts isReadDenied). The page sends no request the CMS
 * would refuse with a 403, and the viewer learns why the section is empty
 * instead of seeing the CMS error banner or the error page. It says nothing
 * about what the section holds (no existence oracle).
 */
export function SectionUnavailable() {
  const t = useTranslations("errors");
  return (
    <EmptyState icon={Lock} title={t("sectionUnavailableTitle")} hint={t("sectionUnavailableHint")}>
      <Link
        href="/"
        className="rounded-lg text-sm font-medium text-primary outline-hidden hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {t("backToDashboard")}
      </Link>
    </EmptyState>
  );
}

/**
 * The whole page for a section the viewer's role cannot read: the page's
 * own header, then SectionUnavailable. One place for what the section
 * pages used to repeat (SH02); the page still returns it BEFORE any read.
 */
export function SectionUnavailablePage(
  header: Omit<ComponentProps<typeof PageHeader>, "children">,
) {
  return (
    <div className="space-y-8">
      <PageHeader {...header} />
      <SectionUnavailable />
    </div>
  );
}
