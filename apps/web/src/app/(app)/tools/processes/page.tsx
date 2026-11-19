import Link from "next/link";
import type { Route } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { Workflow } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { SectionUnavailablePage } from "@/components/section-unavailable";
import { Card, CardContent } from "@/components/ui/card";
import { loadProcesses, type ProcessView } from "@/lib/loaders/processes";
import { isReadDenied } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";

export async function generateMetadata() {
  const t = await getTranslations("processes");
  return { title: t("title") };
}

/**
 * The published processes (v1.1 "Tools"), company-wide first, then by
 * department name, like the KPIs. The list reads the metadata only; the
 * diagram comes with a process's own page. Every staff role reads; guests
 * get the explanation instead.
 */
export default async function ProcessesPage() {
  const t = await getTranslations("processes");
  const viewer = await getViewer();
  if (isReadDenied(viewer.role, "processes")) {
    return <SectionUnavailablePage title={t("title")} description={t("description")} />;
  }
  const [view, format] = await Promise.all([loadProcesses(), getFormatter()]);
  const groups = new Map<string, { name: string; processes: ProcessView[] }>();
  for (const process of view.processes) {
    const key = process.department?.slug ?? "";
    const group = groups.get(key) ?? {
      name: process.department?.name ?? t("companyWide"),
      processes: [],
    };
    group.processes.push(process);
    groups.set(key, group);
  }
  const ordered = [...groups.entries()].sort(([a, left], [b, right]) =>
    a === "" ? -1 : b === "" ? 1 : left.name.localeCompare(right.name),
  );

  return (
    <div className="space-y-8">
      <PageHeader title={t("title")} description={t("description")} />
      {view.failed && <FetchErrorBanner />}
      {!view.failed && view.processes.length === 0 ? (
        <EmptyState icon={Workflow} title={t("empty")} />
      ) : (
        ordered.map(([key, group]) => (
          <section key={key} className="space-y-3">
            <h2 className="text-lg font-semibold tracking-tight">{group.name}</h2>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {group.processes.map((process) => (
                <li key={process.documentId}>
                  <Link
                    href={`/tools/processes/${encodeURIComponent(process.documentId)}` as Route}
                    className="block h-full rounded-2xl outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    <Card className="h-full transition-colors hover:bg-accent/40">
                      <CardContent className="space-y-2 py-4">
                        <h3 className="font-medium">{process.title}</h3>
                        <p className="line-clamp-3 text-sm text-muted-foreground">
                          {process.summary}
                        </p>
                        {process.updatedAt ? (
                          <p className="text-xs text-muted-foreground">
                            {t("updated", {
                              date: format.dateTime(new Date(process.updatedAt), {
                                dateStyle: "medium",
                              }),
                            })}
                          </p>
                        ) : null}
                      </CardContent>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
