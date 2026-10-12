"use server";

import { unstable_rethrow } from "next/navigation";
import {
  actionFailure,
  runCmsAction,
  type ActionResult,
  type CmsErrorInfo,
  type CommonCode,
} from "@/lib/action-result";
import { getSession } from "@/lib/session";
import { strapi, type StrapiListResponse } from "@/lib/strapi";
import {
  anchorOf,
  matchesTarget,
  targetFilterQuery,
  type CommentTarget,
} from "@/lib/comment-target";
import { LIVE_TARGET_TYPES } from "@/lib/live-contract";
import { summarize, withOwnReactions, type CommentSectionData } from "@/lib/reaction-summary";
import type { Comment, EmojiType, Reaction } from "@/lib/types";

// No refresh()/revalidate here: the comment sections own this data on the
// client and refetch just themselves — after their own mutations, on live
// pings and on the page's poll interval, so other sessions' comments show
// up without a page reload.

/** Rows of one target the comment window reads, newest first. */
const COMMENT_WINDOW = 100;
/** Rows of one target the reaction summary reads, newest first. */
const REACTION_WINDOW = 500;
/**
 * Page size of the caller's own-reaction lookup: one row per emoji, with
 * room for duplicates from the create race (check-then-insert, §7b P2).
 */
const OWN_REACTIONS_PAGE = 25;
/**
 * Most targets one getCommentSections call takes: a page's sections (the
 * live bus holds at most 200 channels per connection). A Server Action's
 * arguments come from the client, so a longer list is refused.
 */
const MAX_SECTIONS = 200;
/**
 * Most targets per batched reactions request: 50 documentIds keep the
 * query string far below the 16 KB request-header limit of the cms.
 */
const REACTION_BATCH = 50;
/**
 * Comment windows read at the same time: a page's cards in one round (as
 * many as the sections used to read in parallel), a long list in a bounded
 * stream instead of up to 200 requests at once.
 */
const COMMENT_READS_IN_PARALLEL = 25;

/** A target that can be queried: a comment target type and a usable documentId. */
type AnchoredTarget = CommentTarget & { documentId: string };

/** A list answer, or the empty fallback of a failed read. */
type ListPage<T> = {
  data?: T[] | null;
  meta?: { pagination?: { total?: number } };
};

/**
 * GET a list; a failed read gives an empty page. The fallback rethrows
 * Next.js control-flow errors (redirect on 401), so an expired session
 * navigates to sign-in instead of polling forever.
 */
function readList<T>(path: string): Promise<ListPage<T>> {
  return strapi<StrapiListResponse<T>>(path).catch((e: unknown): ListPage<T> => {
    unstable_rethrow(e);
    return { data: [] };
  });
}

const readReactions = (query: string) => readList<Reaction>(`/api/reactions?${query}`);

/** The anchored form of `target`, or null (unknown type, no usable documentId). */
function anchored(target: unknown): AnchoredTarget | null {
  if (typeof target !== "object" || target === null) return null;
  const { type, documentId } = target as { type?: unknown; documentId?: unknown };
  if (!(LIVE_TARGET_TYPES as readonly unknown[]).includes(type)) return null;
  const anchor = anchorOf(documentId);
  return anchor ? { type: type as CommentTarget["type"], documentId: anchor } : null;
}

const keyOf = (target: AnchoredTarget) => `${target.type}:${target.documentId}`;

/** `fn` over `items`, at most `limit` at a time, results in input order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The newest-100 comment window of one target, displayed oldest first.
 * Deliberately a NEWEST-first window, not a page walk (issue #26): sections
 * are refetched on a poll interval, so a full walk would multiply requests
 * per open tab, and the old `sort=createdAt:asc` cut off the NEWEST comments
 * once a thread passed 100 rows. Secondary sort on id disambiguates equal
 * createdAt (same pattern as announcements.requiringAck).
 */
async function readCommentWindow(target: AnchoredTarget): Promise<Comment[]> {
  const page = await readList<Comment>(
    `/api/comments?${targetFilterQuery(target)}&populate[author]=true&sort[0]=createdAt:desc&sort[1]=id:desc&pagination[pageSize]=${COMMENT_WINDOW}`,
  );
  // Re-check the anchor per row (matchesTarget = permanent defense-in-depth):
  // a mis-built filter must never leak a foreign discussion into a section.
  // .reverse() restores the display order (oldest first) after the
  // descending fetch.
  return (page.data ?? []).filter((comment) => matchesTarget(comment, target)).reverse();
}

/**
 * The caller's own reactions of one target: `reacted` is not display only.
 * The reaction bar sends its negation as the desired state (FX28), and the
 * CMS answers `reacted: true` on an existing row with a no-op, so an own
 * row older than the window could never be removed if it showed as not
 * pressed. A failed lookup keeps the window's answer.
 */
async function withOwnLookup(
  summary: CommentSectionData["reactions"],
  target: AnchoredTarget,
  userId: number,
): Promise<CommentSectionData["reactions"]> {
  const own = await readReactions(
    `${targetFilterQuery(target)}&filters[author][id][$eq]=${userId}&populate[author]=true&pagination[pageSize]=${OWN_REACTIONS_PAGE}`,
  );
  return withOwnReactions(summary, own.data ?? [], userId, target);
}

/**
 * One target's reactions on their own: the newest-500 window (the explicit
 * sort makes it deterministic; unsorted, Postgres returns rows in arbitrary
 * order), plus the own lookup when the window overflowed. Past 500 rows the
 * counters can undercount (accepted, display only).
 */
async function readTargetReactions(
  target: AnchoredTarget,
  userId: number | undefined,
): Promise<CommentSectionData["reactions"]> {
  const page = await readReactions(
    `${targetFilterQuery(target)}&populate[author]=true&sort[0]=createdAt:desc&sort[1]=id:desc&pagination[pageSize]=${REACTION_WINDOW}`,
  );
  const rows = page.data ?? [];
  const summary = summarize(rows, userId, target);
  const total = page.meta?.pagination?.total;
  return userId != null && typeof total === "number" && total > rows.length
    ? withOwnLookup(summary, target, userId)
    : summary;
}

/**
 * The summary of one target from ALL its rows (newest first): counts over
 * the newest-500 window, like readTargetReactions, and the caller's own
 * rows past the window marked as pressed (no extra request: they are here).
 */
function summarizeTarget(
  rows: Reaction[],
  userId: number | undefined,
  target: AnchoredTarget,
): CommentSectionData["reactions"] {
  const summary = summarize(rows.slice(0, REACTION_WINDOW), userId, target);
  if (userId == null || rows.length <= REACTION_WINDOW) return summary;
  return withOwnReactions(summary, rows.slice(REACTION_WINDOW), userId, target);
}

/**
 * The reactions of up to REACTION_BATCH targets in ONE request (WD04):
 * `filters[targetDocumentId][$in]` (a single target keeps the `$eq` pair,
 * the shape the cms comment-target-visibility policy answers on its fast
 * path), newest first, room for REACTION_WINDOW rows per target. Every row
 * is re-checked with matchesTarget per target.
 *
 * When the page held every row (the usual case), each target gets exactly
 * what readTargetReactions gives it. When it did not, the page holds every
 * row newer than its last one, so a target with REACTION_WINDOW rows in it
 * has its whole window there and only needs the own lookup; any other
 * target is read on its own (readTargetReactions).
 */
async function readReactionBatch(
  targets: AnchoredTarget[],
  userId: number | undefined,
): Promise<CommentSectionData["reactions"][]> {
  const filters =
    targets.length === 1
      ? targetFilterQuery(targets[0]!)
      : [
          ...[...new Set(targets.map((t) => t.type))].map(
            (type, i) => `filters[targetType][$in][${i}]=${encodeURIComponent(type)}`,
          ),
          ...targets.map(
            (t, i) => `filters[targetDocumentId][$in][${i}]=${encodeURIComponent(t.documentId)}`,
          ),
        ].join("&");
  const page = await readReactions(
    `${filters}&populate[author]=true&sort[0]=createdAt:desc&sort[1]=id:desc&pagination[pageSize]=${REACTION_WINDOW * targets.length}`,
  );
  const rows = page.data ?? [];
  const total = page.meta?.pagination?.total;
  const complete = typeof total !== "number" || total <= rows.length;
  return Promise.all(
    targets.map(async (target) => {
      const mine = rows.filter((row) => matchesTarget(row, target));
      if (complete) return summarizeTarget(mine, userId, target);
      if (mine.length >= REACTION_WINDOW) {
        const summary = summarize(mine.slice(0, REACTION_WINDOW), userId, target);
        return userId == null ? summary : withOwnLookup(summary, target, userId);
      }
      return readTargetReactions(target, userId);
    }),
  );
}

/**
 * The comment and reaction sections of a page's targets, in the order
 * given (WD04): one reactions request per REACTION_BATCH targets instead of
 * one per section, plus each target's newest-100 comment window. A target
 * without a usable anchor gets an empty section rather than a query
 * without a target filter (which would return every comment there is).
 *
 * Comments and reactions are addressed by the target's documentId (issue
 * #11): announcements and wiki pages are draftAndPublish, and Strapi 5
 * publishes by delete+recreate, so the numeric row id they used to be
 * anchored to changes with every publish. The documentId anchor is the ONLY
 * target key — the legacy targetId bridge was removed with #25.
 */
export async function getCommentSections(targets: CommentTarget[]): Promise<CommentSectionData[]> {
  if (!Array.isArray(targets) || targets.length > MAX_SECTIONS) {
    throw new Error("invalid comment section targets");
  }
  const session = await getSession();
  const userId = session?.user?.id;

  const keys = targets.map((target) => {
    const anchoredTarget = anchored(target);
    return anchoredTarget ? { key: keyOf(anchoredTarget), target: anchoredTarget } : null;
  });
  const unique = new Map<string, AnchoredTarget>();
  for (const entry of keys) if (entry) unique.set(entry.key, entry.target);
  const list = [...unique.values()];

  const batches: AnchoredTarget[][] = [];
  for (let i = 0; i < list.length; i += REACTION_BATCH) {
    batches.push(list.slice(i, i + REACTION_BATCH));
  }
  const [comments, reactions] = await Promise.all([
    mapLimited(list, COMMENT_READS_IN_PARALLEL, readCommentWindow),
    Promise.all(batches.map((batch) => readReactionBatch(batch, userId))).then((all) => all.flat()),
  ]);

  const sections = new Map<string, CommentSectionData>();
  list.forEach((target, i) => {
    sections.set(keyOf(target), { comments: comments[i] ?? [], reactions: reactions[i] ?? [] });
  });
  return keys.map(
    (entry) =>
      (entry && sections.get(entry.key)) ?? { comments: [], reactions: summarize([], userId) },
  );
}

/** One target's section: getCommentSections for a single target. */
export async function getCommentSection(target: CommentTarget): Promise<CommentSectionData> {
  const [section] = await getCommentSections([target]);
  return section ?? { comments: [], reactions: summarize([]) };
}

/**
 * Writes send the documentId anchor ONLY — since #25 it is the only key the
 * CMS accepts (a targetId-only payload answers 400 "targetDocumentId
 * required"). Null for a target without a usable anchor: unreachable in
 * practice (every Strapi 5 row carries a documentId), and the write is
 * refused ("invalid") instead of writing an unanchored row that would
 * orphan on publish.
 */
function writeAnchor(target: CommentTarget): string | null {
  return anchorOf(target?.documentId);
}

/**
 * The cms's refusal of a comment or reaction write whose target it cannot
 * resolve for the caller: unknown, not visible to them, or an announcement
 * that is unpublished (batch 12, lane 7C: its thread answers exactly like
 * a missing target) or expired. comment-target's WRITE_TARGET_ERRORS gives
 * "no key sent" and "the key names nothing" the same text on purpose (no
 * existence oracle); the web always sends a key (writeAnchor refuses
 * first), so from here the answer means the target is gone for this user:
 * "notFound" ("This item no longer exists — reload the page."), not a
 * retry prompt. A bare ctx.badRequest carries no machine code, so the
 * parsed envelope message is compared exactly;
 * comment-actions-writes.test.ts pins the text against the cms.
 */
const TARGET_GONE = "targetDocumentId required";

const targetGone = (cms: CmsErrorInfo): CommonCode | undefined =>
  cms.status === 400 && cms.message === TARGET_GONE ? "notFound" : undefined;

/**
 * Posts a comment. Answers an ActionResult (AC01): a target that is gone
 * for the caller (unknown, invisible, unpublished) is "notFound", any other
 * 400 "invalid".
 */
export async function addComment(target: CommentTarget, body: string): Promise<ActionResult> {
  const targetDocumentId = writeAnchor(target);
  if (!targetDocumentId) return actionFailure("invalid");
  return runCmsAction<never>(
    () =>
      strapi("/api/comments", {
        method: "POST",
        body: JSON.stringify({
          data: { body, targetType: target.type, targetDocumentId },
        }),
      }),
    { label: "[comments] add", mapError: targetGone },
  );
}

/**
 * Deletes a comment by its numeric id (the cms translates it). The author
 * and the moderators may; anyone else gets "forbidden", a comment that is
 * gone "notFound". The id comes from the client, so anything but a
 * positive integer is refused before it becomes part of the path.
 */
export async function deleteComment(commentId: number): Promise<ActionResult> {
  if (!Number.isInteger(commentId) || commentId <= 0) return actionFailure("invalid");
  return runCmsAction(
    () =>
      strapi(`/api/comments/${commentId}`, {
        method: "DELETE",
      }),
    { label: "[comments] delete" },
  );
}

/**
 * Sets the caller's reaction to `reacted` (FX28): the desired end state,
 * not a toggle, so a repeated request cannot undo the first one. The CMS
 * creates the row, deletes it or does nothing; one that predates the key
 * ignores it and toggles, which is what the button asked for anyway.
 * Answers an ActionResult (AC01): a target that is gone for the caller is
 * "notFound", as for a comment.
 */
export async function toggleReaction(
  target: CommentTarget,
  emoji: EmojiType,
  reacted: boolean,
): Promise<ActionResult> {
  const targetDocumentId = writeAnchor(target);
  if (!targetDocumentId) return actionFailure("invalid");
  return runCmsAction<never>(
    () =>
      strapi("/api/reactions", {
        method: "POST",
        body: JSON.stringify({
          // Strict boolean whatever a crafted action call passes.
          data: { emoji, targetType: target.type, targetDocumentId, reacted: reacted === true },
        }),
      }),
    { label: "[reactions] set", mapError: targetGone },
  );
}
