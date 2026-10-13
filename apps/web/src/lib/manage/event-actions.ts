"use server";

import { transitionItem, type AuthoringActionResult } from "./authoring-action";
import { buildEventPayload } from "./payload";
import { saveItem, type SaveInput } from "./save";
import { coerceEventValues } from "./values";

/**
 * The event actions of /manage (deep-dive decision 06 §L3, §L4; batch 15
 * plan, lane 15C item 3): see announcement-actions.ts. Not to be confused
 * with lib/event-actions.ts, the readers' RSVP.
 */

export async function saveEvent(input: SaveInput): Promise<AuthoringActionResult> {
  return saveItem("events", input, { coerce: coerceEventValues, build: buildEventPayload });
}

export async function publishEvent(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("events", "publish", documentId, version);
}

export async function unpublishEvent(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("events", "unpublish", documentId, version);
}

export async function discardEvent(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("events", "discardDraft", documentId, version);
}

export async function deleteEvent(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("events", "delete", documentId, version);
}
