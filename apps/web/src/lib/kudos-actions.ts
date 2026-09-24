"use server";

import { refresh } from "next/cache";
import { strapi } from "@/lib/strapi";
import type { KudosValue } from "@/lib/types";

export async function sendKudos(toUserId: number, message: string, value: KudosValue) {
  await strapi("/api/kudos-entries", {
    method: "POST",
    body: JSON.stringify({
      data: { to: toUserId, message, value },
    }),
  });
  // The kudos feed is read uncached (D-DC01) — re-render it in the action response
  // so the new entry appears without a manual reload.
  refresh();
}
