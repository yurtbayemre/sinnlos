import { Suspense } from "react";
import { redirect } from "next/navigation";
import {
  BarChart3,
  Bell,
  BookOpen,
  Calendar,
  FileText,
  Megaphone,
  MessageCircle,
  Search as SearchIcon,
  SearchX,
  ThumbsUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Messages } from "next-intl";
import { getFormatter, getTranslations } from "next-intl/server";
import { formatInstant, type DateTimeFields } from "@/lib/date-format";
import { ANALYTICS_STATS, loadAnalytics, type AnalyticsStat } from "@/lib/loaders/analytics";
import { loadPeopleCount } from "@/lib/loaders/people-count";
import { isAdmin } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";
import { AdminPageHeader } from "@/components/admin-page-header";
import { FetchErrorBanner } from "@/components/fetch-error";
import { Card, CardContent } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCount, StatTile } from "@/components/ui/stat-tile";

export async function generateMetadata() {
  const t = await getTranslations("analytics");
  return { title: t("title") };
}

/** A recent comment's time, "Sep 30, 14:05", in APP_TIME_ZONE. */
const COMMENT_TIME: DateTimeFields = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

/** Label key (namespace `analytics`), icon and icon colour of each content tile. */
const STAT_META = {
  announcements: { labelKey: "announcements", icon: Megaphone, color: "text-amber-500" },
  events: { labelKey: "events", icon: Calendar, color: "text-emerald-500" },
  "wiki-pages": { labelKey: "wikiPages", icon: BookOpen, color: "text-indigo-500" },
  "wiki-spaces": { labelKey: "wikiSpaces", icon: BookOpen, color: "text-violet-500" },
  documents: { labelKey: "documents", icon: FileText, color: "text-rose-500" },
  polls: { labelKey: "polls", icon: BarChart3, color: "text-cyan-500" },
  comments: { labelKey: "comments", icon: MessageCircle, color: "text-orange-500" },
  reactions: { labelKey: "reactions", icon: ThumbsUp, color: "text-pink-500" },
  unreadNotifications: { labelKey: "unreadNotifications", icon: Bell, color: "text-red-500" },
} as const satisfies Record<
  AnalyticsStat,
  { labelKey: keyof Messages["analytics"]; icon: LucideIcon; color: string }
>;

/**
 * The admin analytics. The reads are lib/loaders/analytics.ts (WD03): a
 * count that cannot be read shows "–" and the CMS-down banner, never 0.
 */
export default async function AnalyticsPage() {
  if (!isAdmin((await getViewer()).role)) {
    redirect("/");
  }

  // `format` renders instants in APP_TIME_ZONE (i18n/request.ts).
  const [t, tCommon, tErrors, format, view] = await Promise.all([
    getTranslations("analytics"),
    getTranslations("common"),
    getTranslations("errors"),
    getFormatter(),
    loadAnalytics(),
  ]);
  const unknown = tCommon("unknown");
  const { search } = view;

  return (
    <div className="space-y-8">
      <AdminPageHeader title={t("title")} description={t("description")} />

      {view.failed && (
        <FetchErrorBanner message={view.countsFailed ? tErrors("countsUnavailable") : undefined} />
      )}

      <section className="space-y-3">
        <SectionLabel>{t("contentOverview")}</SectionLabel>
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
          {/* The user count walks the whole directory (no total on
              /api/users), so it streams in its own Suspense boundary
              instead of holding back the page (WD10). */}
          <Suspense
            fallback={
              <UsersTile
                label={t("users")}
                value={<Skeleton aria-hidden="true" className="mt-1 h-7 w-12 rounded-md" />}
              />
            }
          >
            <UsersStatTile label={t("users")} unknownLabel={unknown} />
          </Suspense>
          {ANALYTICS_STATS.map((stat) => {
            const meta = STAT_META[stat];
            return (
              <StatTile
                key={stat}
                size="sm"
                icon={meta.icon}
                iconClassName={meta.color}
                label={t(meta.labelKey)}
                value={<StatCount count={view.counts[stat]} unknownLabel={unknown} />}
              />
            );
          })}
        </div>
      </section>

      {search && (
        <section className="space-y-3">
          <SectionLabel>{t("searchSection", { days: search.windowDays })}</SectionLabel>
          <div className="grid gap-4 sm:grid-cols-2">
            <StatTile
              size="sm"
              icon={SearchIcon}
              iconClassName="text-sky-500"
              label={t("searchTotal")}
              value={search.total}
            />
            <StatTile
              size="sm"
              icon={SearchX}
              iconClassName="text-red-500"
              label={t("searchZeroResults")}
              value={
                <>
                  {search.zeroResultCount}
                  {search.total > 0 && (
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      ({search.zeroRate}%)
                    </span>
                  )}
                </>
              }
            />
          </div>
          {(search.topTerms.length > 0 || search.topZeroTerms.length > 0) && (
            <div className="grid gap-4 md:grid-cols-2">
              {search.topTerms.length > 0 && (
                <Card>
                  <CardContent className="p-4">
                    <div className="mb-2 text-xs font-medium text-muted-foreground">
                      {t("searchTopTerms")}
                    </div>
                    <div className="divide-y">
                      {search.topTerms.map((row) => (
                        <div
                          key={row.term}
                          className="flex items-center justify-between gap-3 py-1.5 text-sm"
                        >
                          <span className="truncate">{row.term}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {t("searchTermMeta", { count: row.count, avg: row.avgResults })}
                          </span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
              {search.topZeroTerms.length > 0 && (
                <Card>
                  <CardContent className="p-4">
                    <div className="mb-2 text-xs font-medium text-muted-foreground">
                      {t("searchTopZeroTerms")}
                    </div>
                    <div className="divide-y">
                      {search.topZeroTerms.map((row) => (
                        <div
                          key={row.term}
                          className="flex items-center justify-between gap-3 py-1.5 text-sm"
                        >
                          <span className="truncate">{row.term}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {row.count}×
                          </span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </section>
      )}

      {view.recentComments.length > 0 && (
        <section className="space-y-3">
          <SectionLabel>{t("recentComments")}</SectionLabel>
          <Card>
            <CardContent className="divide-y p-0">
              {view.recentComments.map((c) => (
                <div key={c.id} className="flex items-start gap-3 px-4 py-3">
                  <MessageCircle
                    className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">
                      <span className="font-medium">{c.authorName ?? unknown}</span>{" "}
                      {t("commented")}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{c.body}</p>
                    {c.createdAt && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {formatInstant(format, c.createdAt, COMMENT_TIME)}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  );
}

/** The streamed user count (WD10): "–" when the directory walk failed. */
async function UsersStatTile({ label, unknownLabel }: { label: string; unknownLabel: string }) {
  const count = await loadPeopleCount("analytics-users");
  return (
    <UsersTile label={label} value={<StatCount count={count} unknownLabel={unknownLabel} />} />
  );
}

function UsersTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <StatTile size="sm" icon={Users} iconClassName="text-blue-500" label={label} value={value} />
  );
}
