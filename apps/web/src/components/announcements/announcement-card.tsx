import Link from "next/link";
import type { ReactNode } from "react";
import { Megaphone, Pin } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AnnouncementListItem } from "@/lib/api/announcements";
import { displayNameOf, initials, stripMarkdown } from "@/lib/utils";

interface CommonProps {
  /** The announcement as the list reads deliver it (lib/api/announcements.ts). */
  item: AnnouncementListItem;
  /** createdAt, formatted by the caller with next-intl (APP_TIME_ZONE); null: none. */
  dateLabel: string | null;
  /** The author's name when the announcement has none to show. */
  unknownLabel: string;
}

type AnnouncementCardProps =
  | (CommonProps & {
      /** /announcements: the whole post, Markdown body, confirm button, comments. */
      variant: "full";
      /** The tinted border of the pinned and the open-confirmation sections. */
      highlighted?: boolean;
      /** The confirm button (mandatory announcements). */
      ack?: ReactNode;
      /** The comment section. */
      children?: ReactNode;
    })
  | (CommonProps & {
      /** The dashboard's lead card (LatestNews): a link to /announcements. */
      variant: "featured";
      /** "Pinned" or "Featured". */
      badge: string;
    })
  | (CommonProps & {
      /** A dashboard side card (LatestNews): a link to /announcements. */
      variant: "compact";
    });

/**
 * One announcement card for /announcements and the dashboard's LatestNews
 * (UI08; LatestNews used to redefine the Announcement type and its own
 * cards). The author is named by displayNameOf; initials "?" when there is
 * none. The body is Markdown (UI03): rendered in full on /announcements,
 * a plain-text excerpt (stripMarkdown) on the dashboard.
 */
export function AnnouncementCard(props: AnnouncementCardProps) {
  const { item, dateLabel, unknownLabel } = props;
  const authorName = displayNameOf(item.author, null);
  const authorLabel = authorName ?? unknownLabel;

  if (props.variant === "full") {
    return (
      <Card className={props.highlighted ? "border-primary/30 bg-primary/2" : undefined}>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-lg">
                {props.highlighted && (
                  <Pin className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                )}
                {item.title}
              </CardTitle>
              <CardDescription>{dateLabel}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <div className="hidden text-right text-xs text-muted-foreground sm:block">
                <div className="font-medium text-foreground">{authorLabel}</div>
                {item.author?.jobTitle && <div>{item.author.jobTitle}</div>}
              </div>
              <Avatar className="h-9 w-9">
                <AvatarFallback>{initials(authorName)}</AvatarFallback>
              </Avatar>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* The body is a Strapi richtext field, i.e. Markdown (UI03): the
              shared renderer, without heading ids and with footnote ids of
              its own (several cards per page). */}
          <Markdown
            className="prose prose-sm prose-slate max-w-none text-muted-foreground dark:prose-invert"
            idPrefix={`announcement-${item.id}-`}
          >
            {item.body}
          </Markdown>
          {props.ack && <div className="mt-4">{props.ack}</div>}
          {props.children && <div className="mt-4 border-t pt-4">{props.children}</div>}
        </CardContent>
      </Card>
    );
  }

  // The dashboard excerpts: plain text, without "**", "#" or link targets.
  const excerpt = stripMarkdown(item.body);

  if (props.variant === "featured") {
    const BadgeIcon = item.pinned ? Pin : Megaphone;
    return (
      <Link href="/announcements" className="focus-card block lg:col-span-3">
        <Card
          interactive
          className="group h-full overflow-hidden border-primary/20 bg-linear-to-br from-primary/6 via-background to-background transition hover:border-primary/40 hover:shadow-md"
        >
          <CardContent className="flex flex-col gap-4 p-6">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-primary">
              <BadgeIcon className="h-3 w-3" aria-hidden="true" /> {props.badge}
              <span className="text-muted-foreground">· {dateLabel}</span>
            </div>
            <h3 className="text-2xl font-semibold leading-tight tracking-tight transition-colors group-hover:text-primary">
              {item.title}
            </h3>
            <p className="line-clamp-3 text-sm leading-relaxed text-muted-foreground">{excerpt}</p>
            <div className="flex items-center gap-3 pt-2">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="text-xs">{initials(authorName)}</AvatarFallback>
              </Avatar>
              <div className="text-xs">
                <div className="font-medium">{authorLabel}</div>
                {item.author?.jobTitle && (
                  <div className="text-muted-foreground">{item.author.jobTitle}</div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </Link>
    );
  }

  return (
    <Link href="/announcements" className="focus-card block">
      <Card interactive className="group transition hover:border-primary/30 hover:shadow-xs">
        <CardContent className="flex items-start gap-3 p-4">
          {item.pinned && (
            <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Pin className="h-3 w-3" aria-hidden="true" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium transition-colors group-hover:text-primary">
              {item.title}
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{excerpt}</p>
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span>{authorLabel}</span>
              <span aria-hidden="true">·</span>
              <span>{dateLabel}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
