"use server";

import { transitionItem, type AuthoringActionResult } from "./authoring-action";
import { buildProcessPayload } from "./payload";
import { saveItem, type SaveInput } from "./save";
import { coerceProcessValues } from "./values";

/**
 * The process actions of /manage (v1.1 "Tools"): see announcement-actions.ts.
 * Moderators and the department's heads and team leads (their own
 * department); no schedule, delete for moderators only.
 */

export async function saveProcess(input: SaveInput): Promise<AuthoringActionResult> {
  return saveItem("processes", input, {
    coerce: coerceProcessValues,
    build: buildProcessPayload,
  });
}

export async function publishProcess(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("processes", "publish", documentId, version);
}

export async function unpublishProcess(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("processes", "unpublish", documentId, version);
}

export async function discardProcess(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("processes", "discardDraft", documentId, version);
}

export async function deleteProcess(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("processes", "delete", documentId, version);
}
