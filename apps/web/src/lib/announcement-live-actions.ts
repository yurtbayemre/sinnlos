"use server";

import { unstable_rethrow } from "next/navigation";
import { api } from "@/lib/strapi";

/**
 * Lightweight probe for the announcements live hint: the documentIds this
 * caller may currently see. Runs through api.announcements.list(), i.e.
 * the CMS `announcement-visibility` policy — an out-of-audience user gets
 * the same ids as before a restricted publish, so the hint never leaks
 * existence or timing of posts that aren't for them (plan WP6).
 */
export async function getVisibleAnnouncementDocumentIds(): Promise<string[]> {
  try {
    const res = await api.announcements.list();
    return ((res?.data ?? []) as Array<{ documentId?: string }>)
      .map((a) => a.documentId)
      .filter((id): id is string => typeof id === "string");
  } catch (err) {
    unstable_rethrow(err);
    // Transient CMS hiccup: report "nothing new" — the poll/refresh paths
    // cover it.
    return [];
  }
}
