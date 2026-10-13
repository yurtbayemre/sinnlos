"use server";

import { transitionItem, type AuthoringActionResult } from "./authoring-action";
import { buildQuickLinkPayload } from "./payload";
import { saveItem, type SaveInput } from "./save";
import { coerceQuickLinkValues } from "./values";

/**
 * The quick-link actions of /manage (deep-dive decision 06 §L3, §L4; batch
 * 15 plan, lane 15C item 3): see announcement-actions.ts. Moderators only
 * (§A); the schedule has both ends (publishAt, unpublishAt).
 */

export async function saveQuickLink(input: SaveInput): Promise<AuthoringActionResult> {
  return saveItem("quickLinks", input, {
    coerce: coerceQuickLinkValues,
    build: buildQuickLinkPayload,
  });
}

export async function publishQuickLink(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("quickLinks", "publish", documentId, version);
}

export async function unpublishQuickLink(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("quickLinks", "unpublish", documentId, version);
}

export async function discardQuickLink(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("quickLinks", "discardDraft", documentId, version);
}

export async function deleteQuickLink(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("quickLinks", "delete", documentId, version);
}
