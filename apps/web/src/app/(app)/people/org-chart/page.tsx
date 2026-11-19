import { AlertTriangle, Building2, Contact, Network } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { ORG_CHART_QUERY, toOrgPeople } from "@/lib/people-dto";
import { buildDepartmentChart } from "@/lib/org-tree";
import { canRead } from "@/lib/roles";
import { api } from "@/lib/strapi";
import { fetchAllUsers } from "@/lib/users";
import { tryFetch } from "@/lib/safe-fetch";
import type { UserLite } from "@/lib/types";
import { getViewer } from "@/lib/viewer";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { DepartmentChart } from "@/components/people/department-chart";
import { OrgTree } from "@/components/people/org-tree";
import { SectionUnavailablePage } from "@/components/section-unavailable";
import { ViewSwitch } from "@/components/view-switch";

export async function generateMetadata() {
  const t = await getTranslations("people");
  return { title: t("orgChart") };
}

type Translate = Awaited<ReturnType<typeof getTranslations<"people">>>;

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
  // The department view reads departments and teams (one grant set, ORG_READER_ROLES).
  // Fail-closed: a role that is missing or unknown (a failed /api/me) gets no
  // request and no switch either, not even a read the CMS would then refuse.
  // The reporting-line chart has no such gate and stays as it was.
  const mayReadOrg = canRead(viewer.role, "departments");
  const departmentsView = query.view === "departments";
  if (departmentsView && !mayReadOrg) {
    return <SectionUnavailablePage title={t("orgChart")} />;
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t("orgChart")}>
        {mayReadOrg && (
          <ViewSwitch
            label={t("viewLabel")}
            items={[
              {
                href: "/people/org-chart",
                active: !departmentsView,
                icon: Network,
                text: t("viewReporting"),
              },
              {
                href: "/people/org-chart?view=departments",
                active: departmentsView,
                icon: Building2,
                text: t("viewDepartments"),
              },
            ]}
          />
        )}
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
