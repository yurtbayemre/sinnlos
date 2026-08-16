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
 * anchored to changes with every publish. `targetFilterQuery` still matches
 * rows the CMS bootstrap backfill has not anchored yet — see the TEMPORARY
 * note there.
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
  const [commentsRes, reactionsRes] = await Promise.all([
    strapi<StrapiListResponse<Comment>>(
      `/api/comments?${filters}&populate[author]=true&sort=createdAt:asc&pagination[pageSize]=100`,
      { noCache: true },
    ).catch((e) => {
      unstable_rethrow(e);
      return { data: [] as Comment[] };
    }),
    strapi<StrapiListResponse<Reaction>>(
      `/api/reactions?${filters}&populate[author]=true&pagination[pageSize]=500`,
      { noCache: true },
    ).catch((e) => {
      unstable_rethrow(e);
      return { data: [] as Reaction[] };
    }),
  ]);

  return {
    // Re-check the anchor per row: the filter carries the temporary legacy
    // branch, and a foreign discussion must never leak into a section.
    comments: (((commentsRes as any).data ?? []) as Comment[]).filter((c) =>
      matchesTarget(c, target),
    ),
    reactions: summarize((reactionsRes as any).data ?? [], userId, target),
  };
}

/**
 * Writes send the documentId anchor ONLY. The CMS resolves the target and
 * additionally stores its current row id (dual-write, TEMPORARY — issue #11),
 * so a rollback to the id-only code still finds rows written in the meantime.
 * That does not affect the temporary legacy read branch here: it is clamped
 * to `targetDocumentId IS NULL`, i.e. rows written before the anchor existed.
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
