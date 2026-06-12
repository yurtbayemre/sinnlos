import { redirect } from "next/navigation";
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
} from "lucide-react";
import { auth } from "@/auth";
import { isAdmin } from "@/lib/roles";
import { strapi, type StrapiListResponse } from "@/lib/strapi";
import { Card, CardContent } from "@/components/ui/card";

export const metadata = { title: "Analytics" };

async function count(path: string): Promise<number> {
  try {
    const res = await strapi<StrapiListResponse<any>>(
      `${path}&pagination[pageSize]=1`,
      { noCache: true },
    );
    return (res as any).meta?.pagination?.total ?? (res as any).data?.length ?? 0;
  } catch {
    return 0;
  }
}

async function countUsers(): Promise<number> {
  try {
    const users = await strapi<any[]>(
      "/api/users?fields[0]=id&pagination[pageSize]=1",
      { noCache: true },
    );
    return Array.isArray(users) ? users.length : 0;
  } catch {
    return 0;
  }
}

async function recentActivity() {
  try {
    const [comments, reactions, notifications] = await Promise.all([
      strapi<StrapiListResponse<any>>(
        "/api/comments?sort=createdAt:desc&pagination[pageSize]=5&populate[author]=true",
        { noCache: true },
      ),
      strapi<StrapiListResponse<any>>(
        "/api/reactions?sort=createdAt:desc&pagination[pageSize]=1",
        { noCache: true },
      ),
      strapi<StrapiListResponse<any>>(
        "/api/notifications?sort=createdAt:desc&pagination[pageSize]=1&filters[readAt][$null]=true",
        { noCache: true },
      ),
    ]);
    return {
      recentComments: (comments as any).data ?? [],
      totalReactions: (reactions as any).meta?.pagination?.total ?? 0,
      unreadNotifications: (notifications as any).meta?.pagination?.total ?? 0,
    };
  } catch {
    return { recentComments: [], totalReactions: 0, unreadNotifications: 0 };
  }
}

export default async function AnalyticsPage() {
  const session = await auth();
  if (!isAdmin((session?.user as any)?.role)) {
    redirect("/");
  }

  const [
    announcementCount,
    eventCount,
    wikiPageCount,
    wikiSpaceCount,
    documentCount,
    pollCount,
    commentCount,
    userCount,
    activity,
  ] = await Promise.all([
    count("/api/announcements?"),
    count("/api/events?"),
    count("/api/wiki-pages?"),
    count("/api/wiki-spaces?"),
    count("/api/documents?"),
    count("/api/polls?"),
    count("/api/comments?"),
    countUsers(),
    recentActivity(),
  ]);

  const stats = [
    { label: "Users", value: userCount, icon: Users, color: "text-blue-500" },
    { label: "Announcements", value: announcementCount, icon: Megaphone, color: "text-amber-500" },
    { label: "Events", value: eventCount, icon: Calendar, color: "text-emerald-500" },
    { label: "Wiki pages", value: wikiPageCount, icon: BookOpen, color: "text-indigo-500" },
    { label: "Wiki spaces", value: wikiSpaceCount, icon: BookOpen, color: "text-violet-500" },
    { label: "Documents", value: documentCount, icon: FileText, color: "text-rose-500" },
    { label: "Polls", value: pollCount, icon: BarChart3, color: "text-cyan-500" },
    { label: "Comments", value: commentCount, icon: MessageCircle, color: "text-orange-500" },
    { label: "Reactions", value: activity.totalReactions, icon: ThumbsUp, color: "text-pink-500" },
    { label: "Unread notifications", value: activity.unreadNotifications, icon: Bell, color: "text-red-500" },
  ];

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/manage"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Admin
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Analytics</h1>
        <p className="mt-1 text-muted-foreground">
          Content and engagement overview across the intranet.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Content overview</h2>
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
          {stats.map((s) => (
            <Card key={s.label}>
              <CardContent className="flex items-center gap-4 p-4">
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted ${s.color}`}>
                  <s.icon className="h-5 w-5" aria-hidden="true" />
                </div>
                <div>
                  <div className="text-2xl font-semibold tracking-tight">{s.value}</div>
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {activity.recentComments.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Recent comments</h2>
          <Card>
            <CardContent className="divide-y p-0">
              {activity.recentComments.map((c: any) => (
                <div key={c.id} className="flex items-start gap-3 px-4 py-3">
                  <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">
                      <span className="font-medium">
                        {c.author?.displayName ?? c.author?.username ?? "Someone"}
                      </span>
                      {" commented"}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {c.body}
                    </p>
                    {c.createdAt && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {new Date(c.createdAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
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
