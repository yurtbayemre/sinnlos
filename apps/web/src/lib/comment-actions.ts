"use server";

import { auth } from "@/auth";
import { strapi, type StrapiListResponse } from "@/lib/strapi";
import { summarize, type CommentSectionData } from "@/lib/reaction-summary";
import type { Comment, EmojiType, Reaction } from "@/lib/types";

// No refresh()/revalidate here: the LiveCommentSection owns this data on the
// client and refetches just itself — after its own mutations and on a poll
// interval, so other sessions' comments show up without a page reload.

export async function getCommentSection(
  targetType: string,
  targetId: number,
): Promise<CommentSectionData> {
  const session = await auth();
  const userId = (session?.user as any)?.id as number | undefined;

  const [commentsRes, reactionsRes] = await Promise.all([
    strapi<StrapiListResponse<Comment>>(
      `/api/comments?filters[targetType][$eq]=${targetType}&filters[targetId][$eq]=${targetId}&populate[author]=true&sort=createdAt:asc&pagination[pageSize]=100`,
      { noCache: true },
    ).catch(() => ({ data: [] as Comment[] })),
    strapi<StrapiListResponse<Reaction>>(
      `/api/reactions?filters[targetType][$eq]=${targetType}&filters[targetId][$eq]=${targetId}&populate[author]=true&pagination[pageSize]=500`,
      { noCache: true },
    ).catch(() => ({ data: [] as Reaction[] })),
  ]);

  return {
    comments: (commentsRes as any).data ?? [],
    reactions: summarize((reactionsRes as any).data ?? [], userId),
  };
}

export async function addComment(targetType: string, targetId: number, body: string) {
  await strapi("/api/comments", {
    method: "POST",
    body: JSON.stringify({
      data: { body, targetType, targetId },
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

export async function toggleReaction(
  targetType: string,
  targetId: number,
  emoji: EmojiType,
) {
  await strapi("/api/reactions", {
    method: "POST",
    body: JSON.stringify({
      data: { emoji, targetType, targetId },
    }),
    noCache: true,
  });
}
