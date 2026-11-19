import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Building2, Workflow } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { SectionUnavailablePage } from "@/components/section-unavailable";
import { Card, CardContent } from "@/components/ui/card";
import { canRead, isReadDenied } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";

export async function generateMetadata() {
  const t = await getTranslations("tools");
  return { title: t("title") };
}

/**
 * The Tools hub (v1.1): one tile per tool. The first is Processes (BPMN);
 * the PDF tools and the QR page add their tiles here when they ship (no
 * placeholder tiles before that). Every staff role reads; guests get the
 * explanation instead. The org chart's department view is not a tool of its
 * own (it lives under /people): its tile only links there, and only for a
 * viewer who may read departments.
 */
export default async function ToolsPage() {
  const t = await getTranslations("tools");
  const viewer = await getViewer();
  if (isReadDenied(viewer.role, "processes")) {
    return <SectionUnavailablePage title={t("title")} description={t("description")} />;
  }
  // Fail-closed, unlike the hub's own gate: no tile for a role that is missing or unknown.
  const mayReadOrg = canRead(viewer.role, "departments");
  return (
    <div className="space-y-8">
      <PageHeader title={t("title")} description={t("description")} />
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <li>
          <Link
            href="/tools/processes"
            className="block h-full rounded-2xl outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Card className="h-full transition-colors hover:bg-accent/40">
              <CardContent className="flex h-full items-start gap-3 py-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Workflow className="h-5 w-5" aria-hidden="true" />
                </span>
                <span>
                  <span className="block font-medium">{t("processes.title")}</span>
                  <span className="block text-sm text-muted-foreground">
                    {t("processes.description")}
                  </span>
                </span>
              </CardContent>
            </Card>
          </Link>
        </li>
        {mayReadOrg && (
          <li>
            <Link
              href="/people/org-chart?view=departments"
              className="block h-full rounded-2xl outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Card className="h-full transition-colors hover:bg-accent/40">
                <CardContent className="flex h-full items-start gap-3 py-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Building2 className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span>
                    <span className="block font-medium">{t("orgChart.title")}</span>
                    <span className="block text-sm text-muted-foreground">
                      {t("orgChart.description")}
                    </span>
                  </span>
                </CardContent>
              </Card>
            </Link>
          </li>
        )}
      </ul>
    </div>
  );
}
