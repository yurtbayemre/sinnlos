import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowRight, Megaphone, Pin } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { initials } from "@/lib/utils";

type Announcement = {
  id: number;
  title?: string;
  body?: string;
  pinned?: boolean;
  createdAt?: string;
  author?: {
    displayName?: string;
    username?: string;
    email?: string;
    jobTitle?: string;
  } | null;
};

function normalise(a: Announcement) {
  const author = a.author ?? null;
  return {
    id: a.id,
    title: a.title as string,
    body: (a.body as string) ?? "",
    pinned: Boolean(a.pinned),
    createdAt: a.createdAt ? new Date(a.createdAt) : null,
    authorName: author?.displayName ?? author?.username ?? author?.email ?? "Unknown",
    authorJob: author?.jobTitle ?? null,
  };
}

function formatDate(d: Date | null) {
  if (!d) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function relative(d: Date | null) {
  if (!d) return "";
  const diff = Date.now() - d.getTime();
  const day = 86400000;
  if (diff < day) return "today";
  if (diff < 2 * day) return "yesterday";
  if (diff < 7 * day) return `${Math.floor(diff / day)} days ago`;
  return formatDate(d);
}

export async function LatestNews({ items }: { items: Announcement[] }) {
  const tDashboard = await getTranslations("dashboard");
  const tCommon = await getTranslations("common");
  const normalised = items.map(normalise);
  const featured = normalised.find((n) => n.pinned) ?? normalised[0];
  const rest = normalised.filter((n) => n.id !== featured?.id).slice(0, 4);

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Megaphone className="h-3.5 w-3.5" />
            {tDashboard("whatsNew")}
          </div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">{tDashboard("latestNews")}</h2>
        </div>
        <Link
          href="/announcements"
          className="group inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          {tCommon("viewAll")}
          <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
        </Link>
      </div>

      {normalised.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Megaphone className="h-5 w-5" />
            </div>
            <p className="font-medium">{tDashboard("noAnnouncementsYet")}</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {tDashboard("noAnnouncementsHint")}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-5">
          {featured && (
            <Link
              href="/announcements"
              className="focus-card block lg:col-span-3"
            >
              <Card className="group h-full overflow-hidden border-primary/20 bg-gradient-to-br from-primary/[0.06] via-background to-background transition hover:border-primary/40 hover:shadow-md">
                <CardContent className="flex h-full flex-col gap-4 p-6">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-primary">
                    {featured.pinned ? (
                      <>
                        <Pin className="h-3 w-3" /> {tDashboard("pinned")}
                      </>
                    ) : (
                      <>
                        <Megaphone className="h-3 w-3" /> {tDashboard("featured")}
                      </>
                    )}
                    <span className="text-muted-foreground">· {relative(featured.createdAt)}</span>
                  </div>
                  <h3 className="text-2xl font-semibold leading-tight tracking-tight transition group-hover:text-primary">
                    {featured.title}
                  </h3>
                  <p className="line-clamp-3 text-sm leading-relaxed text-muted-foreground">
                    {featured.body}
                  </p>
                  <div className="mt-auto flex items-center gap-3 pt-2">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="text-xs">
                        {initials(featured.authorName)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="text-xs">
                      <div className="font-medium">{featured.authorName}</div>
                      {featured.authorJob && (
                        <div className="text-muted-foreground">{featured.authorJob}</div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          )}

          <div className="flex flex-col gap-3 lg:col-span-2">
            {rest.map((n) => (
              <Link key={n.id} href="/announcements" className="focus-card block">
                <Card className="group transition hover:border-primary/30 hover:shadow-sm">
                  <CardContent className="flex items-start gap-3 p-4">
                    {n.pinned && (
                      <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <Pin className="h-3 w-3" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium transition group-hover:text-primary">
                        {n.title}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {n.body}
                      </p>
                      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{n.authorName}</span>
                        <span>·</span>
                        <span>{relative(n.createdAt)}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
