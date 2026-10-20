import { Suspense } from "react";
import { CheckCircle2, Megaphone, Pin } from "lucide-react";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { formatDateOnly, formatInstant, LONG_DAY } from "@/lib/date-format";
import { loadAnnouncements, type AnnouncementEntry } from "@/lib/loaders/announcements";
import { isReadDenied } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";
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

/**
 * The announcement feed. The data and its rules (the open confirmations
 * pinned on top, the receipts per card) come from lib/loaders/announcements.ts
 * (WD03); the page renders.
 */
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
  const view = await loadAnnouncements(viewer.role);

  // Instants in APP_TIME_ZONE (next-intl's formatter); ackDeadline is a
  // calendar date and is shown as that day (datetime contract, phase 2).
  const formatDay = (iso: string | null | undefined) => formatInstant(format, iso, LONG_DAY);

  const renderAck = ({ item, ackRequired, acknowledgedAt }: AnnouncementEntry) =>
    ackRequired && item.documentId ? (
      <AckButton
        targetDocumentId={item.documentId}
        acknowledgedAtLabel={formatDay(acknowledgedAt)}
        deadlineLabel={formatDateOnly(locale, item.ackDeadline, LONG_DAY)}
      />
    ) : null;

  // Comment sections (WD04): every card's comments and reactions in ONE
  // batched load (one reactions request per 50 cards plus each card's
  // comment window, instead of two requests per card), started now and
  // awaited by each section inside its own Suspense boundary, so the cards
  // render first. On the client, CommentSectionsProvider keeps them fresh
  // with one poll interval and one live subscription set for the page.
  const sectionTarget = ({ item }: AnnouncementEntry) => ({
    type: "announcement" as const,
    documentId: item.documentId,
  });
  const shown = [...view.openAcks, ...view.pinned, ...view.recent];
  const sections = shown.length > 0 ? loadCommentSections(shown.map(sectionTarget)) : undefined;

  const card = (entry: AnnouncementEntry, highlighted: boolean, key: string | number) => (
    <AnnouncementCard
      key={key}
      variant="full"
      item={entry.item}
      highlighted={highlighted}
      dateLabel={formatDay(entry.item.createdAt)}
      unknownLabel={tCommon("unknown")}
      ack={renderAck(entry)}
    >
      <Suspense fallback={<CommentSectionFallback />}>
        <CommentSection target={sectionTarget(entry)} sections={sections} />
      </Suspense>
    </AnnouncementCard>
  );

  return (
    <div className="space-y-8">
      <PageHeader eyebrow={t("eyebrow")} title={t("title")} description={t("description")} />

      <AnnouncementsLiveHint initialIds={view.feedDocumentIds} />

      {view.failed && <FetchErrorBanner />}

      {view.empty ? (
        <EmptyState icon={Megaphone} title={t("emptyTitle")} hint={t("emptyHint")} />
      ) : (
        <CommentSectionsProvider>
          {view.openAcks.length > 0 && (
            <section className="space-y-3">
              <SectionLabel icon={CheckCircle2}>{t("openAcks")}</SectionLabel>
              <div className="stagger grid gap-4 md:grid-cols-2">
                {view.openAcks.map((e) => card(e, true, e.item.documentId ?? e.item.id))}
              </div>
            </section>
          )}

          {view.pinned.length > 0 && (
            <section className="space-y-3">
              <SectionLabel icon={Pin}>{t("pinned")}</SectionLabel>
              <div
                className={
                  view.pinned.length > 1
                    ? "stagger grid gap-4 md:grid-cols-2"
                    : "stagger grid gap-4"
                }
              >
                {view.pinned.map((e) => card(e, true, e.item.id))}
              </div>
            </section>
          )}

          {view.recent.length > 0 && (
            <section className="space-y-3">
              <SectionLabel>{t("recent")}</SectionLabel>
              <div className="stagger space-y-4">
                {view.recent.map((e) => card(e, false, e.item.id))}
              </div>
            </section>
          )}
        </CommentSectionsProvider>
      )}
    </div>
  );
}
