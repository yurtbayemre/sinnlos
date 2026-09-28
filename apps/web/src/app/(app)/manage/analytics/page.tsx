import { Suspense } from "react";
import { redirect, unstable_rethrow } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  BarChart3,
  FileText,
  Megaphone,
  MessageCircle,
  Bell,
  Calendar,
  Users,
  ThumbsUp,
  BookOpen,
  Search as SearchIcon,
  SearchX,
} from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { formatInstant, type DateTimeFields } from "@/lib/date-format";
import { isAdmin } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";
import { strapi, type StrapiListResponse } from "@/lib/strapi";
import { fetchAllUsers } from "@/lib/users";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export async function generateMetadata() {
  const t = await getTranslations("analytics");
  return { title: t("title") };
}

async function count(path: string): Promise<number> {
  try {
    const res = await strapi<StrapiListResponse<any>>(`${path}&pagination[pageSize]=1`);
    return (res as any).meta?.pagination?.total ?? (res as any).data?.length ?? 0;
  } catch (e) {
    unstable_rethrow(e);
    return 0;
  }
}

/**
 * /api/users is a users-permissions route, not a content-type route: it
 * returns a bare array without `meta.pagination` and ignores the
 * `pagination[...]` params entirely — so there is no total to read.
 * Count by actually fetching the (id-only) directory. null = the walk
 * failed (the card shows "–", not a misleading 0).
 */
async function countUsers(): Promise<number | null> {
  try {
    const { users } = await fetchAllUsers("fields[0]=id");
    return users.length;
  } catch (e) {
    unstable_rethrow(e);
    return null;
  }
}

type SearchSummary = {
  windowDays: number;
  total: number;
  zeroResultCount: number;
  topTerms: { term: string; count: number; avgResults: number }[];
  topZeroTerms: { term: string; count: number }[];
};

/** Aggregated search telemetry (issue #19) — admin-only custom route. */
async function searchSummary(): Promise<SearchSummary | null> {
  try {
    return await strapi<SearchSummary>("/api/search-logs/summary?days=30");
  } catch (e) {
    unstable_rethrow(e);
    return null;
  }
}

async function recentActivity() {
  try {
    const [comments, reactions, notifications] = await Promise.all([
      strapi<StrapiListResponse<any>>(
        "/api/comments?sort=createdAt:desc&pagination[pageSize]=5&populate[author]=true",
      ),
      strapi<StrapiListResponse<any>>("/api/reactions?sort=createdAt:desc&pagination[pageSize]=1"),
      strapi<StrapiListResponse<any>>(
        "/api/notifications?sort=createdAt:desc&pagination[pageSize]=1&filters[readAt][$null]=true",
      ),
    ]);
    return {
      recentComments: (comments as any).data ?? [],
      totalReactions: (reactions as any).meta?.pagination?.total ?? 0,
      unreadNotifications: (notifications as any).meta?.pagination?.total ?? 0,
    };
  } catch (e) {
    unstable_rethrow(e);
    return { recentComments: [], totalReactions: 0, unreadNotifications: 0 };
  }
}

/** A recent comment's time, "Sep 30, 14:05", in APP_TIME_ZONE. */
const COMMENT_TIME: DateTimeFields = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };

export default async function AnalyticsPage() {
  if (!isAdmin((await getViewer()).role)) {
    redirect("/");
  }

  // `format` renders instants in APP_TIME_ZONE (i18n/request.ts).
  const [t, tAdmin, tCommon, format] = await Promise.all([
    getTranslations("analytics"),
    getTranslations("admin"),
    getTranslations("common"),
    getFormatter(),
  ]);

  const [
    announcementCount,
    eventCount,
    wikiPageCount,
    wikiSpaceCount,
    documentCount,
    pollCount,
    commentCount,
    activity,
    search,
  ] = await Promise.all([
    count("/api/announcements?"),
    count("/api/events?"),
    count("/api/wiki-pages?"),
    count("/api/wiki-spaces?"),
    count("/api/documents?"),
    count("/api/polls?"),
    count("/api/comments?"),
    recentActivity(),
    searchSummary(),
  ]);

  const zeroRate =
    search && search.total > 0 ? Math.round((search.zeroResultCount / search.total) * 100) : 0;

  const stats = [
    {
      label: t("announcements"),
      value: announcementCount,
      icon: Megaphone,
      color: "text-amber-500",
    },
    { label: t("events"), value: eventCount, icon: Calendar, color: "text-emerald-500" },
    { label: t("wikiPages"), value: wikiPageCount, icon: BookOpen, color: "text-indigo-500" },
    { label: t("wikiSpaces"), value: wikiSpaceCount, icon: BookOpen, color: "text-violet-500" },
    { label: t("documents"), value: documentCount, icon: FileText, color: "text-rose-500" },
    { label: t("polls"), value: pollCount, icon: BarChart3, color: "text-cyan-500" },
    { label: t("comments"), value: commentCount, icon: MessageCircle, color: "text-orange-500" },
    {
      label: t("reactions"),
      value: activity.totalReactions,
      icon: ThumbsUp,
      color: "text-pink-500",
    },
    {
      label: t("unreadNotifications"),
      value: activity.unreadNotifications,
      icon: Bell,
      color: "text-red-500",
    },
  ];

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/manage"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {tAdmin("title")}
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("description")}</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">{t("contentOverview")}</h2>
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
          {/* The user count walks the whole directory (no total on
              /api/users), so it streams in its own Suspense boundary
              instead of holding back the page (WD10). */}
          <Suspense
            fallback={
              <StatTile
                label={t("users")}
                value={<Skeleton aria-hidden="true" className="mt-1 h-7 w-12 rounded-md" />}
                icon={Users}
                color="text-blue-500"
              />
            }
          >
            <UsersStatTile label={t("users")} />
          </Suspense>
          {stats.map((s) => (
            <StatTile key={s.label} {...s} />
          ))}
        </div>
      </section>

      {search && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            {t("searchSection", { days: search.windowDays })}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardContent className="flex items-center gap-4 p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-sky-500">
                  <SearchIcon className="h-5 w-5" aria-hidden="true" />
                </div>
                <div>
                  <div className="text-2xl font-semibold tracking-tight">{search.total}</div>
                  <div className="text-xs text-muted-foreground">{t("searchTotal")}</div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex items-center gap-4 p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-red-500">
                  <SearchX className="h-5 w-5" aria-hidden="true" />
                </div>
                <div>
                  <div className="text-2xl font-semibold tracking-tight">
                    {search.zeroResultCount}
                    {search.total > 0 && (
                      <span className="ml-2 text-sm font-normal text-muted-foreground">
                        ({zeroRate}%)
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{t("searchZeroResults")}</div>
                </div>
              </CardContent>
            </Card>
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

      {activity.recentComments.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">{t("recentComments")}</h2>
          <Card>
            <CardContent className="divide-y p-0">
              {activity.recentComments.map((c: any) => (
                <div key={c.id} className="flex items-start gap-3 px-4 py-3">
                  <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">
                      <span className="font-medium">
                        {c.author?.displayName ?? c.author?.username ?? tCommon("unknown")}
                      </span>{" "}
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
async function UsersStatTile({ label }: { label: string }) {
  const userCount = await countUsers();
  return <StatTile label={label} value={userCount ?? "–"} icon={Users} color="text-blue-500" />;
}

function StatTile({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  value: React.ReactNode;
  icon: typeof Users;
  color: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-4">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted ${color}`}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <div className="text-2xl font-semibold tracking-tight">{value}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}
