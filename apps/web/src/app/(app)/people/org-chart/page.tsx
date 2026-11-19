import Link from "next/link";
import { AlertTriangle, Building2, Contact, Network } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { ORG_CHART_QUERY, toOrgPeople } from "@/lib/people-dto";
import { buildDepartmentChart } from "@/lib/org-tree";
import { isReadDenied } from "@/lib/roles";
import { api } from "@/lib/strapi";
import { fetchAllUsers } from "@/lib/users";
import { tryFetch } from "@/lib/safe-fetch";
import type { UserLite } from "@/lib/types";
import { getViewer } from "@/lib/viewer";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { DepartmentChart } from "@/components/people/department-chart";
import { OrgTree } from "@/components/people/org-tree";
import { SectionUnavailablePage } from "@/components/section-unavailable";

export async function generateMetadata() {
  const t = await getTranslations("people");
  return { title: t("orgChart") };
}

type Translate = Awaited<ReturnType<typeof getTranslations<"people">>>;

/** Same switch as the events page: links, so it works without JavaScript and is linkable. */
function ViewSwitch({ departments, t }: { departments: boolean; t: Translate }) {
  const linkClass = (active: boolean) =>
    cn(
      "inline-flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-sm font-medium transition-colors",
      "outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      active
        ? "bg-primary text-primary-foreground ring-1 ring-primary-text"
        : "text-muted-foreground hover:bg-muted",
    );
  return (
    <div role="group" aria-label={t("viewLabel")} className="inline-flex rounded-xl border p-0.5">
      <Link
        href="/people/org-chart"
        aria-current={!departments ? "page" : undefined}
        className={linkClass(!departments)}
      >
        <Network className="h-4 w-4" aria-hidden="true" />
        {t("viewReporting")}
      </Link>
      <Link
        href="/people/org-chart?view=departments"
        aria-current={departments ? "page" : undefined}
        className={linkClass(departments)}
      >
        <Building2 className="h-4 w-4" aria-hidden="true" />
        {t("viewDepartments")}
      </Link>
    </div>
  );
}

export default async function OrgChartPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const [t, query, viewer] = await Promise.all([
    getTranslations("people"),
    searchParams,
    getViewer(),
  ]);
  // The department view reads departments and teams (one grant set, ORG_READER_ROLES):
  // a role without it gets no request and no switch (SH02). The reporting-line
  // chart has no such gate and stays as it was.
  const mayReadOrg = !isReadDenied(viewer.role, "departments");
  const departmentsView = query.view === "departments";
  if (departmentsView && !mayReadOrg) {
    return <SectionUnavailablePage title={t("orgChart")} />;
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t("orgChart")}>
        {mayReadOrg && <ViewSwitch departments={departmentsView} t={t} />}
      </PageHeader>
      {departmentsView ? await departmentBody(t) : await reportingBody(t)}
    </div>
  );
}

async function departmentBody(t: Translate) {
  const [departments, teams] = await Promise.all([
    tryFetch(() => api.departments.list(), "org-chart-departments"),
    tryFetch(() => api.teams.list(), "org-chart-teams"),
  ]);
  // Half a chart (departments without their teams) would read as "no teams":
  // on any failure the banner stands alone.
  if (departments.failed || teams.failed) return <FetchErrorBanner />;

  const chart = buildDepartmentChart(departments.data?.data ?? [], teams.data?.data ?? []);
  const truncated = departments.data?.truncated || teams.data?.truncated;
  return (
    <>
      {truncated && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t("deptTruncated")}</span>
        </div>
      )}
      {chart.departments.length === 0 && chart.unassigned.length === 0 ? (
        <EmptyState icon={Building2} title={t("deptEmptyTitle")} hint={t("deptEmptyHint")} />
      ) : (
        <DepartmentChart chart={chart} />
      )}
    </>
  );
}

async function reportingBody(t: Translate) {
  // Field-limited fetch and a lean node DTO before the client boundary
  // (WD05): name, job title, department, avatar thumbnail and the manager's
  // id per person — the manager is no longer a full user row.
  const { data, failed } = await tryFetch(
    () => fetchAllUsers<UserLite>(ORG_CHART_QUERY),
    "org-chart",
  );
  const people = toOrgPeople(data?.users ?? []);

  return (
    <>
      {failed && <FetchErrorBanner />}

      {people.length === 0 ? (
        <EmptyState icon={Contact} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        <OrgTree people={people} />
      )}
    </>
  );
}
