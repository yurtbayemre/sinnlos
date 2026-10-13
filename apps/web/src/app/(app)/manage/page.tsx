import Link from "next/link";
import {
  BarChart3,
  BookOpen,
  Building2,
  CalendarDays,
  ClipboardCheck,
  ExternalLink,
  FileText,
  GraduationCap,
  Link2,
  Lock,
  Megaphone,
  Shield,
  Users,
  Vote,
  type LucideIcon,
} from "lucide-react";
import type { Messages } from "next-intl";
import { getTranslations } from "next-intl/server";
// Browser-facing URL — inside Docker the internal STRAPI_URL
// (http://cms:1337) is not reachable from the user's browser.
import { STRAPI_PUBLIC_URL as STRAPI_URL } from "@/lib/config";
import { lacksDepartment, manageAreasFor, areaAccess } from "@/lib/manage/access";
import { AREA_PATH, type ManageArea } from "@/lib/manage/areas";
import { manageGate } from "@/lib/manage/page-gate";
import { countedFilters, loadManageLanding } from "@/lib/loaders/manage/landing";
import { isAdmin } from "@/lib/roles";
import { FetchErrorBanner } from "@/components/fetch-error";
import { NoDepartmentExplanation } from "@/components/manage/page-parts";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCount, StatTile } from "@/components/ui/stat-tile";

export async function generateMetadata() {
  const t = await getTranslations("manage.common");
  return { title: t("title") };
}

const AREA_ICONS: Readonly<Record<ManageArea, LucideIcon>> = {
  announcements: Megaphone,
  events: CalendarDays,
  polls: Vote,
  quickLinks: Link2,
  documents: FileText,
  wiki: BookOpen,
};

const ROLE_COLORS = [
  "bg-red-500/10 text-red-600 dark:text-red-400",
  "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  "bg-muted text-muted-foreground",
];

/** The Strapi admin shortcuts; label and description keys of the `admin` namespace. */
const QUICK_LINK_META = [
  {
    href: "/admin/content-manager",
    labelKey: "contentManager",
    descKey: "contentManagerDesc",
    icon: BookOpen,
  },
  {
    href: "/admin/settings/users-permissions/roles",
    labelKey: "rolesPermissions",
    descKey: "rolesPermissionsDesc",
    icon: Shield,
  },
  {
    href: "/admin/content-manager/collection-types/plugin::users-permissions.user",
    labelKey: "users",
    descKey: "usersDesc",
    icon: Users,
  },
  {
    href: "/admin/content-manager/collection-types/api::department.department",
    labelKey: "departmentsLink",
    descKey: "departmentsLinkDesc",
    icon: Building2,
  },
] as const satisfies readonly {
  href: string;
  labelKey: keyof Messages["admin"];
  descKey: keyof Messages["admin"];
  icon: LucideIcon;
}[];

/**
 * The /manage landing (deep-dive decision 06 §L1; batch 15 plan, lane 15C
 * item 1): one tile per area the viewer authors in, with what needs
 * attention (drafts, scheduled, failed schedules; lib/loaders/manage/
 * landing.ts). The reports (analytics, read confirmations, training) and
 * the Strapi admin links and roles stay admin-only. A department author
 * sees announcements, events and documents (§L1, §N7: their three areas;
 * the wiki tile needs `author.wikiSpaces`, moderators only), and without a
 * department the explanation instead (§N1).
 */
export default async function ManagePage() {
  const { viewer, capabilities } = await manageGate();
  const areas = manageAreasFor(capabilities);
  const admin = isAdmin(viewer.role);
  const departmentAuthor = areas.some(
    (area) => areaAccess(capabilities, area)?.scope === "ownDepartment",
  );
  const noDepartment = areas.some((area) =>
    lacksDepartment(areaAccess(capabilities, area), viewer.department),
  );

  const [t, tAdmin, tCommon, view] = await Promise.all([
    getTranslations("manage.common"),
    getTranslations("admin"),
    getTranslations("common"),
    noDepartment ? null : loadManageLanding(areas),
  ]);

  const roles = [
    { name: "Admin", description: tAdmin("roleAdmin"), color: ROLE_COLORS[0] },
    { name: "Editor", description: tAdmin("roleEditor"), color: ROLE_COLORS[1] },
    { name: "Department Head", description: tAdmin("roleDeptManager"), color: ROLE_COLORS[2] },
    { name: "Team Lead", description: tAdmin("roleTeamLead"), color: ROLE_COLORS[3] },
    { name: "Member", description: tAdmin("roleMember"), color: ROLE_COLORS[4] },
    { name: "Guest", description: tAdmin("roleGuest"), color: ROLE_COLORS[5] },
  ];
  const reports = [
    capabilities.reports.analytics && {
      icon: BarChart3,
      label: tAdmin("analyticsDashboard"),
      description: tAdmin("analyticsDesc"),
      href: "/manage/analytics" as const,
    },
    capabilities.reports.acknowledgements && {
      icon: ClipboardCheck,
      label: tAdmin("ackReportLink"),
      description: tAdmin("ackReportLinkDesc"),
      href: "/manage/acknowledgements" as const,
    },
    capabilities.reports.training && {
      icon: GraduationCap,
      label: tAdmin("trainingReportLink"),
      description: tAdmin("trainingReportLinkDesc"),
      href: "/manage/training" as const,
    },
  ].filter((report) => !!report);

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("title")}
        description={
          departmentAuthor && viewer.department
            ? t("descriptionDepartmentAuthor", { department: viewer.department.name })
            : t("description")
        }
      >
        {admin && (
          <Button asChild variant="outline">
            <a href={`${STRAPI_URL}/admin`} target="_blank" rel="noreferrer">
              {tAdmin("openStrapi")}
              <ExternalLink className="ml-2 h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
        )}
      </PageHeader>

      {view?.failed && <FetchErrorBanner />}

      {areas.length > 0 && (
        <section aria-labelledby="manage-content" className="space-y-3">
          <h2 id="manage-content" className="text-lg font-semibold">
            {t("landing.contentSection")}
          </h2>
          {noDepartment ? (
            <NoDepartmentExplanation />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {areas.map((area) => {
                const Icon = AREA_ICONS[area];
                const counts = view?.tiles.find((tile) => tile.area === area)?.counts ?? {};
                return (
                  <Card key={area} className="relative h-full transition hover:shadow-md">
                    <CardHeader className="pb-3">
                      <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <Icon className="h-5 w-5" aria-hidden="true" />
                      </div>
                      <CardTitle className="text-base">
                        {/* The whole card is the link's target (stretched link). */}
                        <Link
                          href={AREA_PATH[area]}
                          className="outline-none after:absolute after:inset-0 after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
                        >
                          {t(`areas.${area}.title`)}
                        </Link>
                      </CardTitle>
                      <CardDescription>{t(`areas.${area}.description`)}</CardDescription>
                    </CardHeader>
                    {countedFilters(area).length > 0 && (
                      <CardContent>
                        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
                          {countedFilters(area).map((status) => {
                            const count = counts[status];
                            return (
                              <div key={status} className="flex items-baseline gap-1.5">
                                <dt className="text-muted-foreground">{t(`counts.${status}`)}</dt>
                                <dd className="font-semibold tabular-nums">
                                  {count ? (
                                    <StatCount count={count} unknownLabel={tCommon("unknown")} />
                                  ) : (
                                    "–"
                                  )}
                                </dd>
                              </div>
                            );
                          })}
                        </dl>
                      </CardContent>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      )}

      {reports.length > 0 && (
        <section aria-labelledby="manage-reports" className="space-y-3">
          <h2 id="manage-reports" className="text-lg font-semibold">
            {t("landing.reportsSection")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {reports.map((report) => (
              <StatTile
                key={report.href}
                icon={report.icon}
                label={report.label}
                description={report.description}
                href={report.href}
              />
            ))}
          </div>
        </section>
      )}

      {admin && (
        <>
          <section aria-labelledby="manage-admin" className="space-y-3">
            <h2 id="manage-admin" className="text-lg font-semibold">
              {t("landing.adminSection")}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {QUICK_LINK_META.map((link) => {
                const Icon = link.icon;
                return (
                  <a
                    key={link.href}
                    href={`${STRAPI_URL}${link.href}`}
                    target="_blank"
                    rel="noreferrer"
                    className="focus-card block"
                  >
                    <Card interactive className="h-full transition hover:border-primary/40">
                      <CardHeader>
                        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                          <Icon className="h-5 w-5" aria-hidden="true" />
                        </div>
                        <CardTitle className="flex items-center gap-2 text-base">
                          {tAdmin(link.labelKey)}
                          <ExternalLink
                            className="h-3.5 w-3.5 text-muted-foreground"
                            aria-hidden="true"
                          />
                        </CardTitle>
                        <CardDescription>{tAdmin(link.descKey)}</CardDescription>
                      </CardHeader>
                    </Card>
                  </a>
                );
              })}
            </div>
          </section>

          <section aria-labelledby="manage-roles" className="space-y-3">
            <h2 id="manage-roles" className="text-lg font-semibold">
              {tAdmin("rolesSection")}
            </h2>
            <p className="text-sm text-muted-foreground">{tAdmin("rolesDesc")}</p>
            <div className="grid gap-4 md:grid-cols-2">
              {roles.map((r) => (
                <Card key={r.name}>
                  <CardHeader>
                    <div className="flex items-center gap-3">
                      <div
                        className={`flex h-9 w-9 items-center justify-center rounded-xl ${r.color}`}
                      >
                        <Lock className="h-4 w-4" aria-hidden="true" />
                      </div>
                      <CardTitle className="text-base">{r.name}</CardTitle>
                    </div>
                    <CardDescription className="pt-1">{r.description}</CardDescription>
                  </CardHeader>
                </Card>
              ))}
            </div>
          </section>

          <Card className="border-dashed">
            <CardContent className="flex flex-col gap-2 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="font-medium text-foreground">{tAdmin("roleChangeHint")}</div>
                <div>{tAdmin("roleChangeInstruction")}</div>
              </div>
              <Button variant="outline" asChild className="text-foreground">
                <Link href="/wiki/handbook/welcome">{tAdmin("readHandbook")}</Link>
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
