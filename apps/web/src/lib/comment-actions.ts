"use server";

import { revalidateTag } from "next/cache";
import { strapi } from "@/lib/strapi";
import type { EmojiType } from "@/lib/types";

export async function addComment(targetType: string, targetId: number, body: string) {
  await strapi("/api/comments", {
    method: "POST",
    body: JSON.stringify({
      data: { body, targetType, targetId },
    }),
    noCache: true,
  });
  revalidateTag("comments");
}

export async function deleteComment(commentId: number) {
  await strapi(`/api/comments/${commentId}`, {
    method: "DELETE",
    noCache: true,
  });
  revalidateTag("comments");
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
  revalidateTag("reactions");
}
