import type { EventRsvp, EventRsvpSummary } from "@/lib/types";

/**
 * RSVP aggregation for the events page (WD02: moved out of
 * app/(app)/events/page.tsx unchanged, so it can be tested).
 */

/** The summary of an event nobody has answered yet (shared: never mutate it). */
export const EMPTY_RSVP_SUMMARY: EventRsvpSummary = {
  yesNames: [],
  yesCount: 0,
  maybeCount: 0,
  noCount: 0,
  myStatus: null,
};

/**
 * Collapse the raw RSVP rows into one summary per event documentId.
 * Dedupe per (event, user) keeping the LATEST respondedAt: the CMS accepts
 * a benign create race that can leave duplicate rows per user, so counting
 * rows directly would overstate the buckets. The rows arrive sorted by
 * respondedAt, then id, so on a tie the later row wins, like the CMS's own
 * healing order. A row whose user the CMS stripped (a maybe/no of someone
 * else) is its own bucket entry: it counts, but carries no name.
 */
export function buildRsvpSummaries(
  rows: EventRsvp[],
  myUserId: number | null,
): Map<string, EventRsvpSummary> {
  const latest = new Map<string, EventRsvp>();
  for (const row of rows) {
    if (!row.targetDocumentId) continue;
    const key = `${row.targetDocumentId}:${row.user?.id ?? `row-${row.id}`}`;
    const prev = latest.get(key);
    const rowTime = row.respondedAt ? new Date(row.respondedAt).getTime() : 0;
    const prevTime = prev?.respondedAt ? new Date(prev.respondedAt).getTime() : 0;
    if (!prev || rowTime >= prevTime) latest.set(key, row);
  }

  const map = new Map<string, EventRsvpSummary>();
  for (const row of latest.values()) {
    let summary = map.get(row.targetDocumentId);
    if (!summary) {
      summary = { yesNames: [], yesCount: 0, maybeCount: 0, noCount: 0, myStatus: null };
      map.set(row.targetDocumentId, summary);
    }
    if (row.status === "yes") {
      summary.yesCount += 1;
      if (row.user?.displayName) summary.yesNames.push(row.user.displayName);
    } else if (row.status === "maybe") summary.maybeCount += 1;
    else if (row.status === "no") summary.noCount += 1;
    if (myUserId != null && row.user?.id === myUserId) summary.myStatus = row.status;
  }
  return map;
}
