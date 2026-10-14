"use server";

import { transitionItem, type AuthoringActionResult } from "./authoring-action";
import { buildDocumentPayload } from "./payload";
import { saveItem, type SaveInput } from "./save";
import { coerceDocumentValues } from "./values";

/**
 * The document actions of /manage (deep-dive decision 06 §L3, §L4, §L6,
 * §N2; batch 16 plan, lane 16C items 1-3): see announcement-actions.ts.
 * Moderators and department authors; a department author's departments
 * are pinned to their own (payload.ts), and they hold neither schedule nor
 * delete (the capabilities refuse both before any request). The file is
 * uploaded first (lib/manage/upload.ts); a save sends its row id.
 */

/** Create or update, as a draft or published, optionally with a schedule. */
export async function saveDocument(input: SaveInput): Promise<AuthoringActionResult> {
  return saveItem("documents", input, {
    coerce: coerceDocumentValues,
    build: buildDocumentPayload,
  });
}

export async function publishDocument(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("documents", "publish", documentId, version);
}

export async function unpublishDocument(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("documents", "unpublish", documentId, version);
}

/** Revert the draft to the published version (a department author: only with one). */
export async function discardDocument(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("documents", "discardDraft", documentId, version);
}

export async function deleteDocument(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("documents", "delete", documentId, version);
}
