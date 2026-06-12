"use server";

import { strapi } from "@/lib/strapi";

export async function votePoll(pollId: number, optionIndex: number) {
  return strapi<any>(`/api/polls/${pollId}/vote`, {
    method: "POST",
    body: JSON.stringify({ optionIndex }),
    noCache: true,
  });
}
