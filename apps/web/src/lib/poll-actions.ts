"use server";

import { refresh } from "next/cache";
import { strapi } from "@/lib/strapi";

export async function votePoll(pollId: number, optionIndex: number) {
  const result = await strapi<any>(`/api/polls/${pollId}/vote`, {
    method: "POST",
    body: JSON.stringify({ optionIndex }),
    noCache: true,
  });
  // Poll results are fetched with noCache — refresh so a revisit and the
  // other polls on the page show current counts without a manual reload.
  refresh();
  return result;
}
