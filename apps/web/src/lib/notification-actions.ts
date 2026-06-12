"use server";

import { refresh } from "next/cache";
import { strapi } from "@/lib/strapi";

// The topbar fetches notifications with noCache — refresh() re-renders it in
// the action response so the unread badge updates without a manual reload.

export async function markNotificationsRead(ids: number[]) {
  await strapi("/api/notifications/mark-read", {
    method: "POST",
    body: JSON.stringify({ ids }),
    noCache: true,
  });
  refresh();
}

export async function markAllNotificationsRead() {
  await strapi("/api/notifications/mark-all-read", {
    method: "POST",
    body: JSON.stringify({}),
    noCache: true,
  });
  refresh();
}
