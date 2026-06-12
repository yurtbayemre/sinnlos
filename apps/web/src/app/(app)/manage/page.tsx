import Link from "next/link";
import { redirect } from "next/navigation";
import { ExternalLink, Shield, Users, BookOpen, Building2, Megaphone, Lock, BarChart3 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
// Browser-facing URL — inside Docker the internal STRAPI_URL
// (http://cms:1337) is not reachable from the user's browser.
import { STRAPI_PUBLIC_URL as STRAPI_URL } from "@/lib/config";
import { isAdmin } from "@/lib/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export async function generateMetadata() {
  const t = await getTranslations("admin");
  return { title: t("title") };
}

const ROLE_COLORS = [
  "bg-red-500/10 text-red-600 dark:text-red-400",
  "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  "bg-slate-500/10 text-slate-600 dark:text-slate-400",
];

const QUICK_LINK_META = [
  { href: "/admin/content-manager", labelKey: "contentManager", descKey: "contentManagerDesc", icon: BookOpen },
  { href: "/admin/settings/users-permissions/roles", labelKey: "rolesPermissions", descKey: "rolesPermissionsDesc", icon: Shield },
  { href: "/admin/content-manager/collection-types/plugin::users-permissions.user", labelKey: "users", descKey: "usersDesc", icon: Users },
  { href: "/admin/content-manager/collection-types/api::department.department", labelKey: "departmentsLink", descKey: "departmentsLinkDesc", icon: Building2 },
  { href: "/admin/content-manager/collection-types/api::announcement.announcement", labelKey: "announcementsLink", descKey: "announcementsLinkDesc", icon: Megaphone },
];

export default async function AdminPage() {
  const session = await auth();
  if (!isAdmin((session?.user as any)?.role)) {
    redirect("/");
  }

  const t = await getTranslations("admin");

  const roles = [
    { name: "Admin", description: t("roleAdmin"), color: ROLE_COLORS[0] },
    { name: "Editor", description: t("roleEditor"), color: ROLE_COLORS[1] },
    { name: "Department Head", description: t("roleDeptManager"), color: ROLE_COLORS[2] },
    { name: "Team Lead", description: t("roleTeamLead"), color: ROLE_COLORS[3] },
    { name: "Member", description: t("roleMember"), color: ROLE_COLORS[4] },
    { name: "Guest", description: t("roleGuest"), color: ROLE_COLORS[5] },
  ];

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{t("eyebrow")}</p>
          <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <Button asChild>
          <a href={`${STRAPI_URL}/admin`} target="_blank" rel="noreferrer">
            {t("openStrapi")}
            <ExternalLink className="ml-2 h-4 w-4" />
          </a>
        </Button>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("analyticsSection")}</h2>
        <Link href="/manage/analytics" className="focus-card block">
          <Card className="card-lift transition hover:border-primary/40">
            <CardContent className="flex items-center gap-4 p-6">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <BarChart3 className="h-5 w-5" />
              </div>
              <div>
                <div className="font-medium">{t("analyticsDashboard")}</div>
                <div className="text-sm text-muted-foreground">
                  {t("analyticsDesc")}
                </div>
              </div>
            </CardContent>
          </Card>
        </Link>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("quickLinks")}</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {QUICK_LINK_META.map((link) => {
            const Icon = link.icon;
            return (
              <a
                key={link.href}
                href={`${STRAPI_URL}${link.href}`}
                target="_blank"
                rel="noreferrer"
                className="block"
              >
                <Card className="h-full transition hover:border-primary/40 hover:shadow-md">
                  <CardHeader>
                    <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Icon className="h-5 w-5" />
                    </div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      {t(link.labelKey as any)}
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                    </CardTitle>
                    <CardDescription>{t(link.descKey as any)}</CardDescription>
                  </CardHeader>
                </Card>
              </a>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("rolesSection")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("rolesDesc", { file: "config/ms-role-map.ts" })}
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          {roles.map((r) => (
            <Card key={r.name}>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${r.color}`}>
                    <Lock className="h-4 w-4" />
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
            <div className="font-medium text-foreground">{t("roleChangeHint")}</div>
            <div>
              {t("roleChangeInstruction", { file: "apps/cms/config/ms-role-map.ts" })}
            </div>
          </div>
          <Button variant="outline" asChild>
            <Link href="/wiki/handbook/welcome">{t("readHandbook")}</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
