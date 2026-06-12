"use server";

import { strapi } from "@/lib/strapi";

export async function markNotificationsRead(ids: number[]) {
  await strapi("/api/notifications/mark-read", {
    method: "POST",
    body: JSON.stringify({ ids }),
    noCache: true,
  });
}

export async function markAllNotificationsRead() {
  await strapi("/api/notifications/mark-all-read", {
    method: "POST",
    body: JSON.stringify({}),
    noCache: true,
  });
}
