import { isPollClosed } from "@/lib/poll-close";
import { SKIPPED_READ, tryFetch } from "@/lib/safe-fetch";
import { api, findPollResults, pollRef, type PollRef } from "@/lib/strapi";
import type { PollResults } from "@/lib/types";
import { listTotal } from "./count";

/** One poll card: its address and the caller's results. */
export interface PollEntry {
  /** The poll's documentId (DA01), which a republish keeps: the card's key. */
  ref: PollRef;
  results: PollResults;
}

export interface PollsView {
  active: PollEntry[];
  closed: PollEntry[];
  /**
   * There is no poll to show and nothing failed: the empty state. A failed
   * read shows the banner instead.
   */
  empty: boolean;
  /** A read failed: the CMS-down banner. */
  failed: boolean;
  /** The list holds the newest 20 only and more exist. */
  truncated: boolean;
}

/**
 * The /polls page (WD03). The list is per user (the poll-visibility
 * policy), and all cards' results come in ONE request (WD04: GET
 * /api/poll-results, by documentId, DA01): the cms decides visibility,
 * canVote, the audience and the guest flags per poll and caller, and
 * leaves out a poll the caller may no longer see (deleted, unpublished or
 * retargeted after the list read, decision 02): that poll gets no card. A
 * failed results read shows the banner and no card (the counts unknown).
 * Closed iff now >= closesAt, the rule of the cms vote handler.
 */
export async function loadPolls(now: Date): Promise<PollsView> {
  const list = await tryFetch(() => api.polls.list(), "polls");
  const polls = list.data?.data ?? [];
  const refs = polls.map(pollRef);
  const results =
    refs.length > 0 ? await tryFetch(() => api.polls.resultsMany(refs), "polls") : SKIPPED_READ;

  const cards = polls.flatMap((poll) => {
    const ref = pollRef(poll);
    const found = findPollResults(results.data ?? [], ref);
    return found
      ? [{ entry: { ref, results: found }, closed: isPollClosed(poll.closesAt, now) }]
      : [];
  });
  const active = cards.filter((c) => !c.closed).map((c) => c.entry);
  const closed = cards.filter((c) => c.closed).map((c) => c.entry);

  return {
    active,
    closed,
    empty: !list.failed && !results.failed && cards.length === 0,
    failed: list.failed || results.failed,
    truncated: !!list.data && listTotal(list.data) > polls.length,
  };
}
