import Link from "next/link";
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { Download } from "lucide-react";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import type { CourseValidityStatus } from "@sinnlos/domain";
import { courseTrainingReport } from "@/lib/api/training";
import { formatDateOnly, formatInstant, SHORT_DAY } from "@/lib/date-format";
import { isDocumentId } from "@/lib/entry-id";
import { capabilitiesFor, isAdmin } from "@/lib/roles";
import { tryFetch } from "@/lib/safe-fetch";
import { StrapiError } from "@/lib/strapi-error";
import { cn } from "@/lib/utils";
import { getViewer } from "@/lib/viewer";
import { FetchErrorBanner } from "@/components/fetch-error";
import { ManagePageHeader, NoDepartmentExplanation } from "@/components/manage/page-parts";
import {
  REPORT_STATUSES,
  ReportCounts,
  ReportStatusBadge,
} from "@/components/manage/training-report";
import { Card, CardContent } from "@/components/ui/card";

export async function generateMetadata() {
  const t = await getTranslations("trainingReport");
  return { title: t("title") };
}

const FILTER_LABEL = {
  expired: "statusExpired",
  open: "statusOpen",
  dueSoon: "statusDueSoon",
  done: "statusDone",
} as const;

const isStatus = (value: unknown): value is CourseValidityStatus =>
  typeof value === "string" && (REPORT_STATUSES as readonly string[]).includes(value);

/**
 * One course of the named training report (v0.20): every person it is for in
 * the caller's scope (GET /api/courses/:id/report; the cms scopes it to the
 * department of a head or lead and answers 404 outside it), filtered by
 * status (?status=), with the two CSV downloads (./export). An admin can
 * add the people who left (?leavers=1, v0.28): blocked and anonymised
 * people with receipts for the course, named from their receipts, in their
 * own table; they never count in the numbers above.
 */
export default async function CourseReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ course: string }>;
  searchParams: Promise<{ status?: string | string[]; leavers?: string | string[] }>;
}) {
  const viewer = await getViewer();
  if (!capabilitiesFor(viewer.role).reports.training) redirect("/");
  const [{ course: documentId }, { status: rawStatus, leavers: rawLeavers }] = await Promise.all([
    params,
    searchParams,
  ]);
  if (!isDocumentId(documentId)) notFound();
  const status = isStatus(rawStatus) ? rawStatus : undefined;
  const admin = isAdmin(viewer.role);
  const withLeavers = admin && rawLeavers === "1";

  const [t, format, locale] = await Promise.all([
    getTranslations("trainingReport"),
    getFormatter(),
    getLocale(),
  ]);
  const back = "/manage/training/report" as Route;
  if (!admin && !viewer.department) {
    return (
      <div className="space-y-8">
        <ManagePageHeader title={t("title")} back={back} backLabel={t("backToCourses")} />
        <NoDepartmentExplanation />
      </div>
    );
  }

  const result = await tryFetch(async () => {
    try {
      return (await courseTrainingReport(documentId, { leavers: withLeavers })).data;
    } catch (error) {
      if (error instanceof StrapiError && error.status === 404) return null;
      throw error;
    }
  }, "training-report");
  if (result.failed) {
    return (
      <div className="space-y-8">
        <ManagePageHeader title={t("title")} back={back} backLabel={t("backToCourses")} />
        <FetchErrorBanner />
      </div>
    );
  }
  const report = result.data;
  if (!report) notFound();

  const base = `/manage/training/report/${documentId}`;
  const people = status ? report.people.filter((p) => p.status === status) : report.people;
  const leavers = withLeavers ? (report.leavers ?? []) : [];
  // The filter tabs keep the leavers toggle, the toggle keeps the filter.
  const query = (next: { status?: string; leavers?: boolean }) => {
    const search = new URLSearchParams();
    if (next.status) search.set("status", next.status);
    if (next.leavers) search.set("leavers", "1");
    const text = search.toString();
    return (text ? `${base}?${text}` : base) as Route;
  };

  return (
    <div className="space-y-6">
      <ManagePageHeader
        title={report.course.title}
        description={
          report.scope === "all"
            ? t("scopeAll")
            : t("scopeDepartment", { department: report.department ?? "" })
        }
        back={back}
        backLabel={t("backToCourses")}
      />

      <div className="flex flex-wrap items-center justify-between gap-4">
        <ReportCounts counts={report.course.counts} />
        <div className="flex flex-wrap gap-2">
          {(["status", "receipts"] as const).map((kind) => (
            <a
              key={kind}
              href={`${base}/export?kind=${kind}`}
              download
              className="inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm font-medium outline-hidden transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              {t(kind === "status" ? "downloadStatus" : "downloadReceipts")}
            </a>
          ))}
        </div>
      </div>

      <nav aria-label={t("filterLabel")} className="flex flex-wrap gap-2">
        <FilterTab href={query({ leavers: withLeavers })} active={!status} label={t("filterAll")} />
        {REPORT_STATUSES.map((value) => (
          <FilterTab
            key={value}
            href={query({ status: value, leavers: withLeavers })}
            active={status === value}
            label={`${t(FILTER_LABEL[value])} (${report.course.counts[value]})`}
          />
        ))}
      </nav>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          {people.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">{t("noPeople")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t("columnName")}
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t("columnDepartment")}
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t("columnStatus")}
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t("columnLessons")}
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t("columnCompletedAt")}
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    {t("columnDueOn")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {people.map((person) => (
                  <tr key={person.userId} className="border-b last:border-0">
                    <td className="px-4 py-2">
                      <div className="font-medium">{person.name}</div>
                      {person.email && (
                        <div className="text-xs text-muted-foreground">{person.email}</div>
                      )}
                    </td>
                    <td className="px-4 py-2">{person.department ?? "–"}</td>
                    <td className="px-4 py-2">
                      <ReportStatusBadge status={person.status} />
                    </td>
                    <td className="px-4 py-2 tabular-nums">
                      {t("lessonsOf", { done: person.completed, total: person.total })}
                    </td>
                    <td className="px-4 py-2">
                      {formatInstant(format, person.completedAt, SHORT_DAY) ?? "–"}
                    </td>
                    <td className="px-4 py-2">
                      {formatDateOnly(locale, person.dueKey, SHORT_DAY) ?? "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {admin && (
        <section aria-labelledby="report-leavers" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="report-leavers" className="text-lg font-semibold">
              {t("leaversTitle")}
            </h2>
            <Link
              href={query({ status, leavers: !withLeavers })}
              className="text-sm font-medium text-primary hover:underline"
            >
              {withLeavers ? t("leaversHide") : t("leaversShow")}
            </Link>
          </div>
          <p className="text-sm text-muted-foreground">{t("leaversHint")}</p>
          {withLeavers && (
            <Card>
              <CardContent className="overflow-x-auto p-0">
                {leavers.length === 0 ? (
                  <p className="p-6 text-sm text-muted-foreground">{t("leaversNone")}</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="border-b text-left text-xs text-muted-foreground">
                      <tr>
                        <th scope="col" className="px-4 py-2 font-medium">
                          {t("columnName")}
                        </th>
                        <th scope="col" className="px-4 py-2 font-medium">
                          {t("columnLeft")}
                        </th>
                        <th scope="col" className="px-4 py-2 font-medium">
                          {t("columnStatus")}
                        </th>
                        <th scope="col" className="px-4 py-2 font-medium">
                          {t("columnLessons")}
                        </th>
                        <th scope="col" className="px-4 py-2 font-medium">
                          {t("columnCompletedAt")}
                        </th>
                        <th scope="col" className="px-4 py-2 font-medium">
                          {t("columnDueOn")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {leavers.map((person) => (
                        <tr key={person.userId} className="border-b last:border-0">
                          <td className="px-4 py-2">
                            <div className="font-medium">{person.name}</div>
                            {person.email && (
                              <div className="text-xs text-muted-foreground">{person.email}</div>
                            )}
                          </td>
                          <td className="px-4 py-2">
                            {t(person.left === "anonymised" ? "leftAnonymised" : "leftBlocked")}
                          </td>
                          <td className="px-4 py-2">
                            <ReportStatusBadge status={person.status} />
                          </td>
                          <td className="px-4 py-2 tabular-nums">
                            {t("lessonsOf", { done: person.completed, total: person.total })}
                          </td>
                          <td className="px-4 py-2">
                            {formatInstant(format, person.completedAt, SHORT_DAY) ?? "–"}
                          </td>
                          <td className="px-4 py-2">
                            {formatDateOnly(locale, person.dueKey, SHORT_DAY) ?? "–"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          )}
        </section>
      )}
    </div>
  );
}

function FilterTab({ href, active, label }: { href: Route; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-full border px-3 py-1.5 text-xs font-medium outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );
}
