import type { EventRsvpSummary, RsvpStatus } from "@/lib/types";

/**
 * RSVP summaries for the events page. Since FX21 the CMS aggregates them
 * (GET /api/event-rsvps/summary, apps/cms/src/utils/rsvp.ts
 * summarizeRsvps): one answer per user (the newest), the names of the
 * "yes" answers only, and the caller's own answer. The web no longer sees
 * a single RSVP row; this module only maps the response.
 */

/** The summary of an event nobody has answered yet (shared: never mutate it). */
export const EMPTY_RSVP_SUMMARY: EventRsvpSummary = {
  yesNames: [],
  yesCount: 0,
  maybeCount: 0,
  noCount: 0,
  myStatus: null,
};

const STATUSES: readonly RsvpStatus[] = ["yes", "no", "maybe"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Event documentId → summary, from the summary endpoint's `data`. A row
 * that is not a well-formed summary is dropped (its event then shows the
 * empty summary), never half-read; an event the CMS left out (not
 * published) gets none either.
 */
export function rsvpSummaryMap(rows: unknown[]): Map<string, EventRsvpSummary> {
  const map = new Map<string, EventRsvpSummary>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.targetDocumentId !== "string") continue;
    const yesCount = count(row.yesCount);
    const maybeCount = count(row.maybeCount);
    const noCount = count(row.noCount);
    if (yesCount === null || maybeCount === null || noCount === null) continue;
    const yesNames = Array.isArray(row.yesNames)
      ? row.yesNames.filter((name): name is string => typeof name === "string")
      : [];
    const myStatus = STATUSES.find((status) => status === row.myStatus) ?? null;
    map.set(row.targetDocumentId, { yesNames, yesCount, maybeCount, noCount, myStatus });
  }
  return map;
}
