"use server";

import { refresh } from "next/cache";
import {
  actionFailure,
  runCmsAction,
  type ActionResult,
  type CmsErrorInfo,
  type CommonCode,
} from "@/lib/action-result";
import { strapi } from "@/lib/strapi";
import type { Acknowledgement } from "@/lib/types";

/**
 * The cms's one refusal for an announcement the caller cannot acknowledge:
 * unknown, unpublished, not mandatory, outside their audience or expired
 * (byte-identical in every case, no existence oracle). The button only
 * shows for a mandatory announcement the caller saw, so the answer means it
 * is gone for them: "notFound" ("reload the page"), as for a comment on a
 * vanished target (comment-actions.ts). A bare ctx.badRequest carries no
 * machine code, so the parsed envelope message is compared exactly;
 * acknowledgement-actions.test.ts pins the text against the cms.
 */
const TARGET_GONE = "Target not available for acknowledgement";

const targetGone = (cms: CmsErrorInfo): CommonCode | undefined =>
  cms.status === 400 && cms.message === TARGET_GONE ? "notFound" : undefined;

/**
 * Confirms the caller read a mandatory announcement. Answers an
 * ActionResult (AC01): an announcement that is gone for the caller is
 * "notFound"; any other 400, a repeated acknowledgement included, is
 * "invalid". The ack button shows the text and reloads either way.
 */
export async function acknowledgeAnnouncement(
  announcementDocumentId: string,
): Promise<ActionResult> {
  return acknowledge("announcement", announcementDocumentId);
}

/** Confirms the caller read a document that requires it (v0.20); same answers. */
export async function acknowledgeDocument(documentDocumentId: string): Promise<ActionResult> {
  return acknowledge("document", documentDocumentId);
}

async function acknowledge(
  targetType: Acknowledgement["targetType"],
  targetDocumentId: string,
): Promise<ActionResult> {
  // A Server Action's argument comes from the client.
  if (typeof targetDocumentId !== "string" || targetDocumentId === "") {
    return actionFailure("invalid");
  }
  // The CMS controller takes the acknowledging user from the JWT
  // (ctx.state.user) — the payload only names the target, by documentId
  // (stable across re-publishes, unlike the numeric id).
  return runCmsAction<never>(
    () =>
      strapi("/api/acknowledgements", {
        method: "POST",
        body: JSON.stringify({ data: { targetType, targetDocumentId } }),
      }),
    {
      label: `[${targetType}s] acknowledge`,
      mapError: targetGone,
      // Acknowledgement state is read uncached (D-DC01) — refresh so the
      // page and the dashboard banner reflect the new ack without a manual
      // reload.
      after: () => refresh(),
    },
  );
}
