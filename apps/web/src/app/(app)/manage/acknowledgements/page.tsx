import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, CheckCircle2, ClipboardCheck, Clock, UserX } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/roles";
import { strapi, type StrapiListResponse } from "@/lib/strapi";
import { fetchAllAnnouncementAcks } from "@/lib/acknowledgements";
import { fetchAllUsers } from "@/lib/users";
import { tryFetch } from "@/lib/safe-fetch";
import type { Acknowledgement, Announcement, UserLite } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export async function generateMetadata() {
  const t = await getTranslations("ackReport");
  return { title: t("title") };
}

type ReportUser = UserLite & {
  department?: { id: number; name: string } | null;
  role?: { id: number; type?: string } | null;
  blocked?: boolean;
};

/**
 * Role types holding `announcement.find` in the CMS permission matrix
 * (apps/cms/src/index.ts) — only they can ever see, and therefore be
 * expected to confirm, a mandatory announcement. `guest` deliberately has
 * NO announcement read and must not inflate the report's denominator.
 */
const ANNOUNCEMENT_READER_ROLES = new Set([
  "admin_role",
  "editor",
  "department_head",
  "team_lead",
  "member",
  "authenticated",
]);

export default async function AcknowledgementReportPage() {
  const session = await auth();
  if (!isAdmin(session?.user?.role)) {
    redirect("/");
  }

  const [t, tAdmin, locale] = await Promise.all([
    getTranslations("ackReport"),
    getTranslations("admin"),
    getLocale(),
  ]);

  // admin_role bypasses the acknowledgement-visibility policy, so this
  // returns EVERY user's acks; users come via the paginated directory
  // helper. All three are per-user/noCache fetches.
  const [announcementsResult, acksResult, usersResult] = await Promise.all([
    tryFetch(
      () =>
        // audienceRoles populate needs `plugin::users-permissions.role.find`,
        // which the CMS bootstrap grants to admin_role for exactly this page.
        strapi<StrapiListResponse<Announcement>>(
          "/api/announcements?filters[requiresAck][$eq]=true&populate[department]=true&populate[audienceRoles][fields][0]=type&sort=createdAt:desc&pagination[pageSize]=100",
          { noCache: true },
        ),
      "ack-report",
    ),
    tryFetch(() => fetchAllAnnouncementAcks(), "ack-report"),
    tryFetch(
      () =>
        // role is populated the same way people.list does it; blocked is a
        // plain (non-private) users-permissions field.
        fetchAllUsers<ReportUser>(
          "fields[0]=id&fields[1]=username&fields[2]=displayName&fields[3]=email&fields[4]=blocked&populate[department][fields][0]=name&populate[role]=true",
        ),
      "ack-report",
    ),
  ]);

  const anyFailed = announcementsResult.failed || acksResult.failed || usersResult.failed;
  // Re-check requiresAck: DEMO_MODE's fixture answers announcement paths
  // unfiltered, and it keeps the report honest if the query ever changes.
  const announcements = (
    (announcementsResult.data?.data ?? []) as (Announcement & {
      audience?: string;
      department?: { id: number; name: string } | null;
      audienceRoles?: { id: number; type?: string }[] | null;
    })[]
  ).filter((a) => a.requiresAck);
  const acks = (acksResult.data ?? []) as Acknowledgement[];
  const users = usersResult.data ?? [];

  // Only unblocked users whose role can actually read announcements count
  // toward the report — a blocked account or a guest can never confirm
  // anything, and would permanently drag every percentage down.
  const eligibleUsers = users.filter(
    (u) => u.blocked !== true && ANNOUNCEMENT_READER_ROLES.has(u.role?.type ?? ""),
  );

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  const userName = (u: ReportUser) => u.displayName ?? u.username ?? u.email ?? `#${u.id}`;

  const rows = announcements.map((a) => {
    // Same audience targeting the announcements list applies: "departments"
    // scopes to the linked department, everything else is company-wide.
    // When the announcement additionally names audienceRoles, the target
    // set narrows to users holding one of those roles.
    const audienceRoles = a.audienceRoles ?? [];
    const targetUsers = eligibleUsers.filter((u) => {
      if (a.audience === "departments" && a.department?.id && u.department?.id !== a.department.id) {
        return false;
      }
      if (audienceRoles.length > 0 && !audienceRoles.some((r) => r.id === u.role?.id)) {
        return false;
      }
      return true;
    });
    // Acks anchor on the stable documentId (numeric ids change on every
    // re-publish); the Set dedupes duplicate ack rows (accepted
    // check-then-insert race in the CMS).
    const ackedUserIds = new Set(
      acks
        .filter((k) => k.targetDocumentId === a.documentId)
        .map((k) => k.user?.id)
        .filter((id): id is number => id != null),
    );
    const openUsers = targetUsers.filter((u) => !ackedUserIds.has(u.id));
    const ackedCount = targetUsers.length - openUsers.length;
    const pct =
      targetUsers.length > 0 ? Math.round((ackedCount / targetUsers.length) * 100) : 0;
    return { announcement: a, targetUsers, openUsers, ackedCount, pct };
  });

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/manage"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {tAdmin("title")}
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 max-w-2xl text-muted-foreground">{t("description")}</p>
      </div>

      {anyFailed && <FetchErrorBanner />}

      {rows.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        <div className="space-y-4">
          {rows.map(({ announcement: a, targetUsers, openUsers, ackedCount, pct }) => (
            <Card key={a.id}>
              <CardHeader>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <CardTitle className="text-base">{a.title}</CardTitle>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span>
                        {a.audience === "departments" && a.department?.name
                          ? t("audienceDepartment", { name: a.department.name })
                          : t("audienceAll")}
                      </span>
                      {a.ackDeadline && (
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" aria-hidden="true" />
                          {t("deadline", { date: formatDate(a.ackDeadline) })}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-2xl font-semibold tracking-tight">{pct}%</div>
                    <div className="text-xs text-muted-foreground">
                      {t("ackedOf", { acked: ackedCount, total: targetUsers.length })}
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                {openUsers.length === 0 ? (
                  <div className="inline-flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    {t("allAcked")}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <div className="inline-flex items-center gap-1.5 text-sm font-medium">
                      <UserX className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      {t("openUsers", { count: openUsers.length })}
                    </div>
                    <ul className="flex flex-wrap gap-1.5">
                      {openUsers.map((u) => (
                        <li
                          key={u.id}
                          className="rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs text-muted-foreground"
                        >
                          {userName(u)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
