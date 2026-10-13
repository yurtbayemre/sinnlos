"use server";

import { transitionItem, type AuthoringActionResult } from "./authoring-action";
import { wallTimeInstant } from "./datetime";
import { buildAnnouncementPayload } from "./payload";
import { saveItem, type SaveInput } from "./save";
import { coerceAnnouncementValues } from "./values";

/**
 * The announcement actions of /manage (deep-dive decision 06 §L3, §L4;
 * batch 15 plan, lane 15C item 3). Thin Server Actions over lib/manage/
 * save.ts and authoring-action.ts: every argument is untrusted and checked
 * there, every answer is an AC01 ActionResult.
 */

/** Create or update, as a draft or published, optionally with a schedule. */
export async function saveAnnouncement(input: SaveInput): Promise<AuthoringActionResult> {
  return saveItem("announcements", input, {
    coerce: coerceAnnouncementValues,
    build: buildAnnouncementPayload,
    expiresAt: (values, ctx) => {
      const expires = wallTimeInstant(values.expiresDate, values.expiresTime, ctx.timeZone);
      return "value" in expires ? expires.value : null;
    },
  });
}

/** Publish the draft as it is. */
export async function publishAnnouncement(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("announcements", "publish", documentId, version);
}

export async function unpublishAnnouncement(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("announcements", "unpublish", documentId, version);
}

/** Revert the draft to the published version (a department author: only with one). */
export async function discardAnnouncement(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("announcements", "discardDraft", documentId, version);
}

export async function deleteAnnouncement(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("announcements", "delete", documentId, version);
}
