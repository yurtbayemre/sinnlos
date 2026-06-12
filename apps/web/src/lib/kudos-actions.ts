"use server";

import { strapi } from "@/lib/strapi";
import type { KudosValue } from "@/lib/types";

export async function sendKudos(toUserId: number, message: string, value: KudosValue) {
  await strapi("/api/kudos-entries", {
    method: "POST",
    body: JSON.stringify({
      data: { to: toUserId, message, value },
    }),
    noCache: true,
  });
}
