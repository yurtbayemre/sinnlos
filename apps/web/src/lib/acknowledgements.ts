import { indexAcks, type AckIndex } from "@/lib/ack-report";
import { strapi, type StrapiListResponse } from "@/lib/strapi";
import { walkAllPages } from "@/lib/paginate";
import type { Acknowledgement } from "@/lib/types";

/**
 * Server-side helpers around /api/acknowledgements.
 *
 * The acknowledgement-visibility policy scopes reads to the caller's own
 * rows (admin_role bypasses): every response here is per-user. strapi()
 * never caches (D-DC01), so no user's acknowledgement state can be served
 * to anyone else.
 *
 * A single request is bounded by its `pageSize`, so both helpers walk the
 * pagination until exhausted and report back whether the walk actually
 * finished — a truncated ack list makes the compliance report undercount
 * confirmations, so it must NOT be mistaken for a complete one (issue #14).
 * Each walk has its own cap.
 */
const PAGE_SIZE = 100;

/** The caller's own acks: 20 pages x 100 = 2000 confirmations. */
const MY_ACKS_MAX_PAGES = 20;

/**
 * The admin report fetches the acks of the listed mandatory announcements
 * in chunks of this many documentIds per request (FX32): the filter list
 * stays well inside any URL limit.
 */
export const REPORT_ACK_CHUNK = 20;

/**
 * Cap per chunk walk: one ack per user and announcement, for up to 2000
 * users (the directory cap in lib/users.ts, which fails the report closed
 * on its own). Only duplicate rows could push a chunk past it.
 */
export const REPORT_ACK_MAX_PAGES = (REPORT_ACK_CHUNK * 2000) / PAGE_SIZE;

/** All matching announcement acks, plus whether the page walk finished. */
export interface AnnouncementAcksResult {
  acks: Acknowledgement[];
  /** true when the walk stopped at its cap with pages left over. */
  truncated: boolean;
}

/** The caller's own announcement acknowledgements (policy-scoped to self). */
export function fetchMyAnnouncementAcks(): Promise<AnnouncementAcksResult> {
  return walkAllPages<Acknowledgement>(
    (page) =>
      strapi<StrapiListResponse<Acknowledgement>>(
        `/api/acknowledgements?filters[targetType][$eq]=announcement&sort=id:asc&pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}`,
      ),
    { maxPages: MY_ACKS_MAX_PAGES, label: "announcement acknowledgements" },
  ).then(({ data, truncated }) => ({ acks: data, truncated }));
}

/** Who confirmed which of the listed announcements, plus whether every walk finished. */
export interface AnnouncementAckIndexResult {
  /** documentId → ids of the users who acknowledged it (every listed id has an entry). */
  index: AckIndex;
  /** true when any chunk's walk stopped at REPORT_ACK_MAX_PAGES. */
  truncated: boolean;
}

/**
 * The acknowledgements of exactly the given announcements, across ALL users
 * — only useful for admin_role, for the /manage/acknowledgements report
 * (FX32). It used to walk every announcement ack of the whole intranet
 * (capped at 2000 rows, then permanently "incomplete"); now it asks per
 * chunk of REPORT_ACK_CHUNK listed documentIds
 * (`filters[targetDocumentId][$in]`), each chunk walk with its own cap, and
 * transfers only the target and the user's id. Sorted by id so the pages
 * of a walk stay stable. Any failure rejects (the page's tryFetch turns it
 * into its CMS-down banner); a cut-short chunk sets `truncated`, which the
 * report treats as incomplete (reportCompleteness).
 */
export async function fetchAnnouncementAckIndex(
  documentIds: string[],
): Promise<AnnouncementAckIndexResult> {
  const ids = [...new Set(documentIds.filter((id) => typeof id === "string" && id !== ""))];
  const index: AckIndex = new Map(ids.map((id) => [id, new Set<number>()]));
  let truncated = false;
  for (let start = 0; start < ids.length; start += REPORT_ACK_CHUNK) {
    const chunk = ids.slice(start, start + REPORT_ACK_CHUNK);
    const filter = chunk
      .map((id, i) => `filters[targetDocumentId][$in][${i}]=${encodeURIComponent(id)}`)
      .join("&");
    const walk = await walkAllPages<Acknowledgement>(
      (page) =>
        strapi<StrapiListResponse<Acknowledgement>>(
          `/api/acknowledgements?filters[targetType][$eq]=announcement&${filter}&fields[0]=targetDocumentId&populate[user][fields][0]=id&sort[0]=id:asc&pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}`,
        ),
      {
        maxPages: REPORT_ACK_MAX_PAGES,
        label: `ack-report acknowledgements ${start / REPORT_ACK_CHUNK + 1}`,
      },
    );
    indexAcks(walk.data, index);
    truncated ||= walk.truncated;
  }
  return { index, truncated };
}

/**
 * The mandatory announcements the caller has not confirmed yet, in list
 * order (WD02: one rule for the dashboard banner and the pinned "open
 * confirmations" section on /announcements). Re-checks requiresAck:
 * DEMO_MODE's fixture answers announcement paths unfiltered, and it keeps
 * the count honest if the query ever changes. Matching runs on documentId,
 * stable across re-publishes (the numeric id changes on every publish
 * cycle); duplicate ack rows (the accepted check-then-insert race in the
 * CMS) collapse in the Set.
 */
export function computeOpenAcks<A extends { requiresAck?: boolean; documentId?: string }>(
  announcements: A[],
  acks: { targetDocumentId: string }[],
): (A & { documentId: string })[] {
  const acked = new Set(acks.map((ack) => ack.targetDocumentId));
  return announcements.filter(
    (a): a is A & { documentId: string } =>
      !!a.requiresAck && !!a.documentId && !acked.has(a.documentId),
  );
}
