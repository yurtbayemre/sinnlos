import { Megaphone, Pin } from "lucide-react";
import { api } from "@/lib/strapi";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { initials } from "@/lib/utils";

export const metadata = { title: "Announcements" };

export default async function AnnouncementsPage() {
  const data = await api.announcements.list().catch(() => null);
  const items = (data?.data ?? []) as any[];

  const pinned = items.filter((a) => a.pinned ?? a.attributes?.pinned);
  const rest = items.filter((a) => !(a.pinned ?? a.attributes?.pinned));

  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm text-muted-foreground">Company news &amp; updates</p>
        <h1 className="text-3xl font-semibold tracking-tight">Announcements</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          The latest news, operational updates and memos from across the company. Pinned
          posts stay at the top until they&apos;re unpinned by an editor.
        </p>
      </header>

      {items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Megaphone className="h-6 w-6" />
            </div>
            <p className="font-medium">No announcements yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Editors and admins can post company news from the Strapi admin panel. New
              posts will appear here and in the dashboard feed.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {pinned.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Pin className="h-3.5 w-3.5" />
                Pinned
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {pinned.map((a) => (
                  <AnnouncementCard key={a.id} item={a} pinned />
                ))}
              </div>
            </section>
          )}

          {rest.length > 0 && (
            <section className="space-y-3">
              <div className="text-sm font-medium text-muted-foreground">Recent</div>
              <div className="space-y-4">
                {rest.map((a) => (
                  <AnnouncementCard key={a.id} item={a} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function AnnouncementCard({ item, pinned = false }: { item: any; pinned?: boolean }) {
  const attrs = item.attributes ?? item;
  const author = attrs.author?.data?.attributes ?? attrs.author ?? null;
  const authorName = author?.displayName ?? author?.username ?? author?.email ?? "Unknown";
  const createdAt = attrs.createdAt ? new Date(attrs.createdAt) : null;

  return (
    <Card className={pinned ? "border-primary/30 bg-primary/[0.02]" : undefined}>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-lg">
              {pinned && <Pin className="h-4 w-4 text-primary" />}
              {attrs.title}
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
          {attrs.body}
        </p>
      </CardContent>
    </Card>
  );
}
