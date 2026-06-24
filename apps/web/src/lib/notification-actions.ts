"use server";

import { auth } from "@/auth";
import { strapi, type StrapiListResponse } from "@/lib/strapi";
import type { Notification } from "@/lib/types";

export async function getNotifications(): Promise<Notification[]> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return [];
  try {
    const res = await strapi<StrapiListResponse<Notification>>(
      `/api/notifications?filters[recipient][id][$eq]=${userId}&populate[actor]=true&sort=createdAt:desc&pagination[pageSize]=20`,
      { noCache: true },
    );
    return (res as any).data ?? [];
  } catch {
    return [];
  }
}

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
