"use server";

import { unstable_rethrow } from "next/navigation";
import { auth } from "@/auth";
import { strapi, type StrapiListResponse } from "@/lib/strapi";
import {
  anchorOf,
  matchesTarget,
  targetFilterQuery,
  type CommentTarget,
} from "@/lib/comment-target";
import { summarize, type CommentSectionData } from "@/lib/reaction-summary";
import type { Comment, EmojiType, Reaction } from "@/lib/types";

// No refresh()/revalidate here: the LiveCommentSection owns this data on the
// client and refetches just itself — after its own mutations and on a poll
// interval, so other sessions' comments show up without a page reload.

/**
 * Comments and reactions are addressed by the target's documentId (issue
 * #11): announcements and wiki pages are draftAndPublish, and Strapi 5
 * publishes by delete+recreate, so the numeric row id they used to be
 * anchored to changes with every publish. The documentId anchor is the ONLY
 * target key — the legacy targetId bridge was removed with #25.
 */
export async function getCommentSection(target: CommentTarget): Promise<CommentSectionData> {
  const session = await auth();
  const userId = session?.user?.id;

  const filters = targetFilterQuery(target);
  // Neither anchor usable: render an empty section rather than querying
  // without a target filter (which would return every comment there is).
  if (!filters) return { comments: [], reactions: summarize([], userId) };

  // The fallbacks rethrow Next.js control-flow errors (redirect on 401)
  // so an expired session navigates to sign-in instead of polling forever.
  //
  // Both fetches are deliberate NEWEST-first windows, not page walks (issue
  // #26): getCommentSection is re-fetched by LiveCommentSection on a poll
  // interval, so a full walk would multiply requests per open tab. The old
  // `sort=createdAt:asc` cut off the NEWEST comments once a thread passed
  // 100 rows — fetching descending flips that: past 100 only the oldest
  // history falls off. Secondary sort on id disambiguates equal createdAt
  // (same pattern as announcements.requiringAck).
  const [commentsRes, reactionsRes] = await Promise.all([
    strapi<StrapiListResponse<Comment>>(
      `/api/comments?${filters}&populate[author]=true&sort[0]=createdAt:desc&sort[1]=id:desc&pagination[pageSize]=100`,
      { noCache: true },
    ).catch((e) => {
      unstable_rethrow(e);
      return { data: [] as Comment[] };
    }),
    // Newest-500 reaction window. The explicit sort makes the window
    // deterministic (unsorted, Postgres returns rows in arbitrary order).
    // The cap is accepted: past 500 rows the summary counters can
    // undercount, and summarize() may miss the caller's own OLD reaction —
    // display only; toggleReaction writes server-side and stays correct.
    strapi<StrapiListResponse<Reaction>>(
      `/api/reactions?${filters}&populate[author]=true&sort[0]=createdAt:desc&sort[1]=id:desc&pagination[pageSize]=500`,
      { noCache: true },
    ).catch((e) => {
      unstable_rethrow(e);
      return { data: [] as Reaction[] };
    }),
  ]);

  return {
    // Re-check the anchor per row (matchesTarget = permanent
    // defense-in-depth): a mis-built filter must never leak a foreign
    // discussion into a section.
    // .reverse() restores the display order (oldest first, as before) after
    // the descending fetch above.
    comments: (((commentsRes as any).data ?? []) as Comment[])
      .filter((c) => matchesTarget(c, target))
      .reverse(),
    reactions: summarize((reactionsRes as any).data ?? [], userId, target),
  };
}

/**
 * Writes send the documentId anchor ONLY — since #25 it is the only key the
 * CMS accepts (a targetId-only payload answers 400 "targetDocumentId
 * required").
 */
function requireAnchor(target: CommentTarget): string {
  const anchor = anchorOf(target.documentId);
  if (!anchor) {
    // Unreachable in practice: every Strapi 5 row carries a documentId. Fail
    // instead of writing an unanchored row that would orphan on publish.
    throw new Error("comment target has no documentId");
  }
  return anchor;
}

export async function addComment(target: CommentTarget, body: string) {
  const targetDocumentId = requireAnchor(target);
  await strapi("/api/comments", {
    method: "POST",
    body: JSON.stringify({
      data: { body, targetType: target.type, targetDocumentId },
    }),
    noCache: true,
  });
}

export async function deleteComment(commentId: number) {
  await strapi(`/api/comments/${commentId}`, {
    method: "DELETE",
    noCache: true,
  });
}

export async function toggleReaction(target: CommentTarget, emoji: EmojiType) {
  const targetDocumentId = requireAnchor(target);
  await strapi("/api/reactions", {
    method: "POST",
    body: JSON.stringify({
      data: { emoji, targetType: target.type, targetDocumentId },
    }),
    noCache: true,
  });
}
