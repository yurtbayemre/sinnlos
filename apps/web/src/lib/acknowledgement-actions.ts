"use server";

import { refresh } from "next/cache";
import { strapi } from "@/lib/strapi";

export async function acknowledgeAnnouncement(announcementDocumentId: string) {
  // The CMS controller takes the acknowledging user from the JWT
  // (ctx.state.user) — the payload only names the target, by documentId
  // (stable across re-publishes, unlike the numeric id).
  await strapi("/api/acknowledgements", {
    method: "POST",
    body: JSON.stringify({
      data: { targetType: "announcement", targetDocumentId: announcementDocumentId },
    }),
    noCache: true,
  });
  // Acknowledgement state is fetched with noCache — refresh so the
  // announcements page and the dashboard banner reflect the new ack
  // without a manual reload.
  refresh();
}
