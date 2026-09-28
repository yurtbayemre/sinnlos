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
