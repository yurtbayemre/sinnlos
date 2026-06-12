"use server";

import { refresh } from "next/cache";
import { strapi } from "@/lib/strapi";
import type { EmojiType } from "@/lib/types";

// Comments and reactions are fetched with noCache (they vary per user), so
// there is no cache tag to expire — refresh() re-renders the current route's
// uncached data in the action response, which is what makes the new state
// show up without a manual reload.

export async function addComment(targetType: string, targetId: number, body: string) {
  await strapi("/api/comments", {
    method: "POST",
    body: JSON.stringify({
      data: { body, targetType, targetId },
    }),
    noCache: true,
  });
  refresh();
}

export async function deleteComment(commentId: number) {
  await strapi(`/api/comments/${commentId}`, {
    method: "DELETE",
    noCache: true,
  });
  refresh();
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
  refresh();
}
