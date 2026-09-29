"use server";

import { refresh } from "next/cache";
import { actionFailure, runCmsAction, type ActionResult } from "@/lib/action-result";
import { strapi } from "@/lib/strapi";

/**
 * Confirms the caller read a mandatory announcement. Answers an
 * ActionResult (AC01): the cms's identical 400 for a missing, draft-only or
 * non-mandatory target and for a repeated acknowledgement is "invalid",
 * the ack button then shows its own text and reloads.
 */
export async function acknowledgeAnnouncement(
  announcementDocumentId: string,
): Promise<ActionResult> {
  // A Server Action's argument comes from the client.
  if (typeof announcementDocumentId !== "string" || announcementDocumentId === "") {
    return actionFailure("invalid");
  }
  // The CMS controller takes the acknowledging user from the JWT
  // (ctx.state.user) — the payload only names the target, by documentId
  // (stable across re-publishes, unlike the numeric id).
  return runCmsAction(
    () =>
      strapi("/api/acknowledgements", {
        method: "POST",
        body: JSON.stringify({
          data: { targetType: "announcement", targetDocumentId: announcementDocumentId },
        }),
      }),
    {
      label: "[announcements] acknowledge",
      // Acknowledgement state is read uncached (D-DC01) — refresh so the
      // announcements page and the dashboard banner reflect the new ack
      // without a manual reload.
      after: () => refresh(),
    },
  );
}
