import { Suspense } from "react";
import { CheckCircle2, Megaphone, Pin } from "lucide-react";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { formatDateOnly, formatInstant, LONG_DAY } from "@/lib/date-format";
import { api } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import { computeOpenAcks, fetchMyAnnouncementAcks } from "@/lib/acknowledgements";
import type { Acknowledgement, Announcement } from "@/lib/types";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { Markdown } from "@/components/markdown";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CommentSection,
  CommentSectionFallback,
  loadCommentSections,
} from "@/components/comments/comment-section";
import { CommentSectionsProvider } from "@/components/comments/live-comment-section";
import { AckButton } from "@/components/announcements/ack-button";
import { AnnouncementsLiveHint } from "@/components/announcements/announcements-live-hint";
import { initials } from "@/lib/utils";

export async function generateMetadata() {
  const t = await getTranslations("announcements");
  return { title: t("title") };
}

export default async function AnnouncementsPage() {
  const t = await getTranslations("announcements");
  const tCommon = await getTranslations("common");
  const [locale, format] = await Promise.all([getLocale(), getFormatter()]);
  // No audience argument: the CMS `announcement-visibility` policy filters
  // both queries down to what this user may see.
  const [{ data, failed }, requiringAckResult, acksResult] = await Promise.all([
    tryFetch(() => api.announcements.list(), "announcements"),
    tryFetch(() => api.announcements.requiringAck(), "announcements"),
    tryFetch(() => fetchMyAnnouncementAcks(), "acknowledgements"),
  ]);
  const items = (data?.data ?? []) as Announcement[];

  // My own acks (the visibility policy scopes the endpoint to the caller),
  // keyed by the target's stable documentId — the numeric id changes on
  // every re-publish. Map keying also dedupes accidental duplicate ack
  // rows (accepted check-then-insert race in the CMS).
  const myAcks = new Map<string, Acknowledgement>();
  for (const ack of acksResult.data?.acks ?? []) {
    myAcks.set(ack.targetDocumentId, ack);
  }

  // Instants in APP_TIME_ZONE (next-intl's formatter); ackDeadline is a
  // calendar date and is shown as that day (datetime contract, phase 2).
  const formatDay = (iso: string | null | undefined) => formatInstant(format, iso, LONG_DAY);

  const renderAck = (a: Announcement) => {
    if (!a.requiresAck || !a.documentId) return null;
    const ack = myAcks.get(a.documentId);
    const ackedAt = ack?.acknowledgedAt ?? ack?.createdAt ?? null;
    return (
      <AckButton
        announcementDocumentId={a.documentId}
        acknowledgedAtLabel={formatDay(ackedAt)}
        deadlineLabel={formatDateOnly(locale, a.ackDeadline, LONG_DAY)}
      />
    );
  };

  // The dashboard banner counts open confirmations across up to 100
  // requiresAck announcements, but this list only shows the newest 20 —
  // an older mandatory announcement could be counted as open yet never be
  // visible here. Load the open ones explicitly and pin them on top,
  // deduplicated against the top 20 by documentId (the top-20 copy wins,
  // it carries the fuller populate).
  const byDocId = new Map(items.filter((a) => a.documentId).map((a) => [a.documentId!, a]));
  const openAck = computeOpenAcks(
    (requiringAckResult.data?.data ?? []) as Announcement[],
    acksResult.data?.acks ?? [],
  ).map((a) => byDocId.get(a.documentId) ?? a);
  const openDocIds = new Set(openAck.map((a) => a.documentId));
  const remaining = items.filter((a) => !a.documentId || !openDocIds.has(a.documentId));

  const pinned = remaining.filter((a) => a.pinned);
  const rest = remaining.filter((a) => !a.pinned);

  // Comment sections (WD04): every card's comments and reactions in ONE
  // batched load (one reactions request per 50 cards plus each card's
  // comment window, instead of two requests per card), started now and
  // awaited by each section inside its own Suspense boundary, so the cards
  // render first. On the client, CommentSectionsProvider keeps them fresh
  // with one poll interval and one live subscription set for the page.
  const sectionTarget = (a: Announcement) => ({
    type: "announcement" as const,
    documentId: a.documentId,
  });
  const shown = [...openAck, ...pinned, ...rest];
  const sections = shown.length > 0 ? loadCommentSections(shown.map(sectionTarget)) : undefined;
  const commentSection = (a: Announcement) => (
    <Suspense fallback={<CommentSectionFallback />}>
      <CommentSection target={sectionTarget(a)} sections={sections} />
    </Suspense>
  );

  return (
    <div className="space-y-8">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")} description={t("description")} />

      <AnnouncementsLiveHint
        initialIds={items.map((a) => a.documentId).filter((id): id is string => !!id)}
      />

      {(failed || requiringAckResult.failed || acksResult.failed) && <FetchErrorBanner />}

      {items.length === 0 && openAck.length === 0 ? (
        <EmptyState icon={Megaphone} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        <CommentSectionsProvider>
          {openAck.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {t("openAcks")}
              </div>
              <div className="stagger grid gap-4 md:grid-cols-2">
                {openAck.map((a) => (
                  <AnnouncementCard
                    key={a.documentId ?? a.id}
                    item={a}
                    pinned
                    createdAtLabel={formatDay(a.createdAt)}
                    unknownLabel={tCommon("unknown")}
                    ack={renderAck(a)}
                  >
                    {commentSection(a)}
                  </AnnouncementCard>
                ))}
              </div>
            </section>
          )}

          {pinned.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Pin className="h-3.5 w-3.5" />
                {t("pinned")}
              </div>
              <div
                className={
                  pinned.length > 1 ? "stagger grid gap-4 md:grid-cols-2" : "stagger grid gap-4"
                }
              >
                {pinned.map((a) => (
                  <AnnouncementCard
                    key={a.id}
                    item={a}
                    pinned
                    createdAtLabel={formatDay(a.createdAt)}
                    unknownLabel={tCommon("unknown")}
                    ack={renderAck(a)}
                  >
                    {commentSection(a)}
                  </AnnouncementCard>
                ))}
              </div>
            </section>
          )}

          {rest.length > 0 && (
            <section className="space-y-3">
              <div className="text-sm font-medium text-muted-foreground">{t("recent")}</div>
              <div className="stagger space-y-4">
                {rest.map((a) => (
                  <AnnouncementCard
                    key={a.id}
                    item={a}
                    createdAtLabel={formatDay(a.createdAt)}
                    unknownLabel={tCommon("unknown")}
                    ack={renderAck(a)}
                  >
                    {commentSection(a)}
                  </AnnouncementCard>
                ))}
              </div>
            </section>
          )}
        </CommentSectionsProvider>
      )}
    </div>
  );
}

function AnnouncementCard({
  item,
  pinned = false,
  createdAtLabel,
  unknownLabel,
  ack,
  children,
}: {
  item: Announcement;
  pinned?: boolean;
  /** createdAt, formatted in APP_TIME_ZONE by the page (null: none). */
  createdAtLabel: string | null;
  unknownLabel: string;
  ack?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const author = item.author ?? null;
  const authorName = author?.displayName ?? author?.username ?? author?.email ?? unknownLabel;

  return (
    <Card className={pinned ? "border-primary/30 bg-primary/[0.02]" : undefined}>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-lg">
              {pinned && <Pin className="h-4 w-4 text-primary" />}
              {item.title}
            </CardTitle>
            <CardDescription>{createdAtLabel}</CardDescription>
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
        {/* The body is a Strapi richtext field, i.e. Markdown (UI03): the
            shared renderer, without heading ids (several cards per page). */}
        <Markdown className="prose prose-sm prose-slate max-w-none text-muted-foreground dark:prose-invert">
          {item.body}
        </Markdown>
        {ack && <div className="mt-4">{ack}</div>}
        {children && <div className="mt-4 border-t pt-4">{children}</div>}
      </CardContent>
    </Card>
  );
}
