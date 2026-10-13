import { computeOpenAcks, fetchMyAnnouncementAcks } from "@/lib/acknowledgements";
import type { AnnouncementListItem } from "@/lib/api/announcements";
import { isReadDenied } from "@/lib/roles";
import { SKIPPED_READ, tryFetch } from "@/lib/safe-fetch";
import { api } from "@/lib/strapi";
import type { Acknowledgement } from "@/lib/types";

/**
 * The /announcements page and the dashboard's open-confirmation banner
 * (WD03). No audience argument anywhere: the CMS announcement-visibility
 * policy filters every read down to what the caller may see, and the
 * acknowledgement-visibility policy scopes the receipts to the caller's own.
 */

type Role = string | null | undefined;

/** One card of /announcements: the announcement and the caller's confirmation. */
export interface AnnouncementEntry {
  item: AnnouncementListItem;
  /** Mandatory (requiresAck) with a documentId: the card carries the confirm button. */
  ackRequired: boolean;
  /**
   * When the caller confirmed it (the receipt's acknowledgedAt, else its
   * createdAt); null: not confirmed, or the receipts could not be read.
   */
  acknowledgedAt: string | null;
}

export interface AnnouncementsView {
  /**
   * The mandatory announcements the caller has not confirmed, pinned on top.
   * The feed shows the newest 20 only, while the dashboard banner counts
   * every open one, so they come from the requiresAck walk; one that is
   * also in the feed is taken from there (fuller populate) and not repeated.
   */
  openAcks: AnnouncementEntry[];
  /** The rest of the feed: pinned first, then the recent ones. */
  pinned: AnnouncementEntry[];
  recent: AnnouncementEntry[];
  /** documentIds of the feed: the live hint tells new posts apart from these. */
  feedDocumentIds: string[];
  /**
   * The feed read answered and there is nothing to show: the empty state.
   * Never set when the feed read failed: the banner says so instead of a
   * "no announcements yet".
   */
  empty: boolean;
  /** A read failed: the page shows the CMS-down banner above what it has. */
  failed: boolean;
  /** The requiresAck walk or the receipts walk stopped at its cap: the open set may be off. */
  truncated: boolean;
}

/** The caller's receipts by announcement documentId (a later duplicate row wins, as before). */
function receiptsByDocumentId(acks: Acknowledgement[]): Map<string, Acknowledgement> {
  const byDocId = new Map<string, Acknowledgement>();
  for (const ack of acks) byDocId.set(ack.targetDocumentId, ack);
  return byDocId;
}

/**
 * Everything /announcements renders. A role without the acknowledgement
 * read (SH02) skips the receipts walk: every mandatory post then counts as
 * open, which is what the CMS would answer too.
 */
export async function loadAnnouncements(role: Role): Promise<AnnouncementsView> {
  const readsAcks = !isReadDenied(role, "acknowledgements");
  const [feed, mandatory, receipts] = await Promise.all([
    tryFetch(() => api.announcements.list(), "announcements"),
    tryFetch(() => api.announcements.requiringAck(), "announcements"),
    readsAcks ? tryFetch(() => fetchMyAnnouncementAcks(), "acknowledgements") : SKIPPED_READ,
  ]);
  const items = feed.data?.data ?? [];
  const acks = receipts.data?.acks ?? [];
  const myAcks = receiptsByDocumentId(acks);

  const entry = (item: AnnouncementListItem): AnnouncementEntry => {
    const ack = item.documentId ? myAcks.get(item.documentId) : undefined;
    return {
      item,
      ackRequired: !!item.requiresAck && !!item.documentId,
      acknowledgedAt: ack?.acknowledgedAt ?? ack?.createdAt ?? null,
    };
  };

  const byDocId = new Map(
    items.filter((a) => a.documentId).map((a) => [a.documentId as string, a] as const),
  );
  const openAck = computeOpenAcks(mandatory.data?.data ?? [], acks).map(
    (a) => byDocId.get(a.documentId) ?? a,
  );
  const openDocIds = new Set(openAck.map((a) => a.documentId));
  const remaining = items.filter((a) => !a.documentId || !openDocIds.has(a.documentId));

  return {
    openAcks: openAck.map(entry),
    pinned: remaining.filter((a) => a.pinned).map(entry),
    recent: remaining.filter((a) => !a.pinned).map(entry),
    feedDocumentIds: items.map((a) => a.documentId).filter((id): id is string => !!id),
    empty: !feed.failed && items.length === 0 && openAck.length === 0,
    failed: feed.failed || mandatory.failed || receipts.failed,
    truncated: !!mandatory.data?.truncated || !!receipts.data?.truncated,
  };
}

/** The dashboard banner's number (AckBanner). */
export interface OpenAckCount {
  /** Mandatory announcements the caller has not confirmed; null: a read failed. */
  count: number | null;
  /** A walk stopped at its cap: the count may be off. */
  truncated: boolean;
}

/**
 * How many mandatory announcements the caller has not confirmed: the same
 * rule as the open section on /announcements (computeOpenAcks). A failed
 * read gives null and the banner stays away (the dashboard shows its own
 * CMS-down banner).
 */
export async function loadOpenAckCount(): Promise<OpenAckCount> {
  const [mandatory, receipts] = await Promise.all([
    tryFetch(() => api.announcements.requiringAck(), "ack-banner"),
    tryFetch(() => fetchMyAnnouncementAcks(), "ack-banner"),
  ]);
  if (mandatory.failed || receipts.failed) return { count: null, truncated: false };
  return {
    count: computeOpenAcks(mandatory.data?.data ?? [], receipts.data?.acks ?? []).length,
    truncated: !!mandatory.data?.truncated || !!receipts.data?.truncated,
  };
}

/** The dashboard's news widget. */
export interface LatestNewsView {
  /** The first pinned announcement of the feed, else the newest; null: no news. */
  featured: AnnouncementListItem | null;
  /** Up to four more, in feed order. */
  rest: AnnouncementListItem[];
  /**
   * The feed read failed: the widget keeps its heading and the link to
   * /announcements but shows neither cards nor "no announcements yet".
   */
  failed: boolean;
}

/** The LatestNews selection over the feed (newest first, pinned first). */
export function pickLatestNews(
  items: readonly AnnouncementListItem[],
  failed = false,
): LatestNewsView {
  const featured = items.find((n) => n.pinned) ?? items[0] ?? null;
  return { featured, rest: items.filter((n) => n.id !== featured?.id).slice(0, 4), failed };
}
