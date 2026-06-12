import { Megaphone, Pin } from "lucide-react";
import { auth } from "@/auth";
import { api } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import type { Announcement } from "@/lib/types";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CommentSection } from "@/components/comments/comment-section";
import { initials } from "@/lib/utils";

export const metadata = { title: "Announcements" };

export default async function AnnouncementsPage() {
  const session = await auth();
  const deptId = (session?.user as any)?.department?.id as number | undefined;
  const { data, failed } = await tryFetch(() => api.announcements.list(deptId), "announcements");
  const items = (data?.data ?? []) as Announcement[];

  const pinned = items.filter((a) => a.pinned);
  const rest = items.filter((a) => !a.pinned);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Company news & updates"
        title="Announcements"
        description="The latest news, operational updates and memos from across the company. Pinned posts stay at the top until they're unpinned by an editor."
      />

      {failed && <FetchErrorBanner />}

      {items.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No announcements yet"
          hint="Editors and admins can post company news from the Strapi admin panel. New posts will appear here and in the dashboard feed."
        />
      ) : (
        <>
          {pinned.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Pin className="h-3.5 w-3.5" />
                Pinned
              </div>
              <div className="stagger grid gap-4 md:grid-cols-2">
                {pinned.map((a) => (
                  <AnnouncementCard key={a.id} item={a} pinned>
                    <CommentSection targetType="announcement" targetId={a.id} />
                  </AnnouncementCard>
                ))}
              </div>
            </section>
          )}

          {rest.length > 0 && (
            <section className="space-y-3">
              <div className="text-sm font-medium text-muted-foreground">Recent</div>
              <div className="stagger space-y-4">
                {rest.map((a) => (
                  <AnnouncementCard key={a.id} item={a}>
                    <CommentSection targetType="announcement" targetId={a.id} />
                  </AnnouncementCard>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function AnnouncementCard({ item, pinned = false, children }: { item: Announcement; pinned?: boolean; children?: React.ReactNode }) {
  const author = item.author ?? null;
  const authorName = author?.displayName ?? author?.username ?? author?.email ?? "Unknown";
  const createdAt = item.createdAt ? new Date(item.createdAt) : null;

  return (
    <Card className={pinned ? "border-primary/30 bg-primary/[0.02]" : undefined}>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-lg">
              {pinned && <Pin className="h-4 w-4 text-primary" />}
              {item.title}
            </CardTitle>
            <CardDescription>
              {createdAt ? createdAt.toLocaleDateString(undefined, {
                year: "numeric",
                month: "long",
                day: "numeric",
              }) : null}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden text-right text-xs text-muted-foreground sm:block">
              <div className="font-medium text-foreground">{authorName}</div>
              {author?.jobTitle && <div>{author.jobTitle}</div>}
            </div>
            <Avatar className="h-9 w-9">
              <AvatarFallback>{initials(authorName)}</AvatarFallback>
            </Avatar>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
          {item.body}
        </p>
        {children && (
          <div className="mt-4 border-t pt-4">
            {children}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
