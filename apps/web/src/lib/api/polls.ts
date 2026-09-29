/**
 * Polls (WD01). Uncached (D-DC01).
 *
 * Per-user: the CMS poll-visibility policy filters the list to the polls
 * the caller may see (department targeting and guest access, decision 02),
 * so a department change applies on the next request. The cards are built
 * from the per-user results, which also say whether the caller may vote
 * and which departments a poll targets, so the list populates no
 * departments.
 */
import { isDocumentId } from "@/lib/entry-id";
import { strapi, type StrapiListResponse } from "@/lib/strapi/client";
import { strapiQuery, withQuery } from "@/lib/strapi/query";
import type { Poll, PollResults } from "@/lib/types";

/** A poll of the list: own fields, no author, no departments. */
export type PollListItem = Omit<Poll, "author" | "departments">;

/**
 * A poll's address in POST /api/polls/:id/vote and GET /api/polls/:id/results
 * (DA01): its documentId, which stays the same across publishes, or, for a
 * row without one in Strapi's shape (never from Strapi 5 itself), the
 * published row's numeric id, the address the routes took before.
 */
export type PollRef = string | number;

export function pollRef(poll: Pick<Poll, "id" | "documentId">): PollRef {
  return isDocumentId(poll.documentId) ? poll.documentId : poll.id;
}

/**
 * No `author` populate (WD05): no poll consumer renders the author.
 * pageSize=20 is a deliberate feed/render cap (issue #26) — counts must
 * come from `meta.pagination.total`, never `data.length`.
 */
export function listPolls(): Promise<StrapiListResponse<PollListItem>> {
  return strapi<StrapiListResponse<PollListItem>>(
    withQuery("/api/polls", strapiQuery().sortBy("createdAt:desc").pageSize(20)),
  );
}

/**
 * Per poll and per user: the cms decides canSeePoll (404 otherwise),
 * canVote, the audience and the guest flags for this poll and caller
 * (decision 02). Addressed by documentId (pollRef, DA01).
 */
export function pollResults(ref: PollRef): Promise<PollResults> {
  return strapi<PollResults>(`/api/polls/${encodeURIComponent(String(ref))}/results`);
}

/** Most polls per GET /api/poll-results request (the cms caps it at 50). */
const POLL_RESULTS_CHUNK = 50;

/**
 * The results of several polls in one request (WD04): GET
 * /api/poll-results?ids=<refs>, each body exactly what pollResults gives
 * for that poll and caller. The cms decides canSeePoll per poll and leaves
 * out every poll the caller may not see, a draft and a missing one alike
 * (no 404 per poll): a poll absent from the answer is simply not shown.
 * The polls page lists at most 20, so this is one request, chunked by the
 * cms's cap only as a safeguard. Order: the order of `refs`.
 */
export async function pollResultsMany(refs: readonly PollRef[]): Promise<PollResults[]> {
  const chunks: PollRef[][] = [];
  for (let i = 0; i < refs.length; i += POLL_RESULTS_CHUNK) {
    chunks.push(refs.slice(i, i + POLL_RESULTS_CHUNK));
  }
  const pages = await Promise.all(
    chunks.map((chunk) =>
      strapi<{ data?: unknown }>(withQuery("/api/poll-results", strapiQuery().list("ids", chunk))),
    ),
  );
  return pages.flatMap((page) => (Array.isArray(page?.data) ? (page.data as PollResults[]) : []));
}

/**
 * The results of `ref` among a pollResultsMany answer: by documentId (the
 * address, which a republish keeps) or, for a numeric address, by row id.
 */
export function findPollResults(
  results: readonly PollResults[],
  ref: PollRef,
): PollResults | undefined {
  return results.find((entry) =>
    typeof ref === "string" ? entry.poll.documentId === ref : entry.poll.id === ref,
  );
}
