import { Suspense } from "react";
import { CheckCircle2, Megaphone, Pin } from "lucide-react";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { formatDateOnly, formatInstant, LONG_DAY } from "@/lib/date-format";
import { api } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import { isReadDenied } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";
import { computeOpenAcks, fetchMyAnnouncementAcks } from "@/lib/acknowledgements";
import type { Acknowledgement, Announcement } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { SectionUnavailablePage } from "@/components/section-unavailable";
import { SectionLabel } from "@/components/ui/section-label";
import {
  CommentSection,
  CommentSectionFallback,
  loadCommentSections,
} from "@/components/comments/comment-section";
import { CommentSectionsProvider } from "@/components/comments/live-comment-section";
import { AckButton } from "@/components/announcements/ack-button";
import { AnnouncementCard } from "@/components/announcements/announcement-card";
import { AnnouncementsLiveHint } from "@/components/announcements/announcements-live-hint";

export async function generateMetadata() {
  const t = await getTranslations("announcements");
  return { title: t("title") };
}

export default async function AnnouncementsPage() {
  const t = await getTranslations("announcements");
  const tCommon = await getTranslations("common");
  const [locale, format, viewer] = await Promise.all([getLocale(), getFormatter(), getViewer()]);
  // A role without announcement.find (guest) gets no request and an
  // explanation instead of the CMS's 403 as an error banner (SH02).
  if (isReadDenied(viewer.role, "announcements")) {
    return (
      <SectionUnavailablePage
        eyebrow={t("eyebrow")}
        title={t("title")}
        description={t("description")}
      />
    );
  }
  const readsAcks = !isReadDenied(viewer.role, "acknowledgements");
  // No audience argument: the CMS `announcement-visibility` policy filters
  // both queries down to what this user may see.
  const [{ data, failed }, requiringAckResult, acksResult] = await Promise.all([
    tryFetch(() => api.announcements.list(), "announcements"),
    tryFetch(() => api.announcements.requiringAck(), "announcements"),
    readsAcks
      ? tryFetch(() => fetchMyAnnouncementAcks(), "acknowledgements")
      : { data: null, failed: false },
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
              <SectionLabel icon={CheckCircle2}>{t("openAcks")}</SectionLabel>
              <div className="stagger grid gap-4 md:grid-cols-2">
                {openAck.map((a) => (
                  <AnnouncementCard
                    key={a.documentId ?? a.id}
                    variant="full"
                    item={a}
                    highlighted
                    dateLabel={formatDay(a.createdAt)}
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
              <SectionLabel icon={Pin}>{t("pinned")}</SectionLabel>
              <div
                className={
                  pinned.length > 1 ? "stagger grid gap-4 md:grid-cols-2" : "stagger grid gap-4"
                }
              >
                {pinned.map((a) => (
                  <AnnouncementCard
                    key={a.id}
                    variant="full"
                    item={a}
                    highlighted
                    dateLabel={formatDay(a.createdAt)}
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
              <SectionLabel>{t("recent")}</SectionLabel>
              <div className="stagger space-y-4">
                {rest.map((a) => (
                  <AnnouncementCard
                    key={a.id}
                    variant="full"
                    item={a}
                    dateLabel={formatDay(a.createdAt)}
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
