"use server";

import { transitionItem, type AuthoringActionResult } from "./authoring-action";
import { buildDutyPlanPayload } from "./payload";
import { saveItem, type SaveInput } from "./save";
import { coerceDutyPlanValues } from "./values";

/**
 * The duty-plan actions of /manage (v0.18): see announcement-actions.ts.
 * Moderators and the department's heads and team leads (their own
 * department); no schedule, delete for moderators only.
 */

export async function saveDutyPlan(input: SaveInput): Promise<AuthoringActionResult> {
  return saveItem("dutyPlans", input, {
    coerce: coerceDutyPlanValues,
    build: buildDutyPlanPayload,
  });
}

export async function publishDutyPlan(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("dutyPlans", "publish", documentId, version);
}

export async function unpublishDutyPlan(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("dutyPlans", "unpublish", documentId, version);
}

export async function discardDutyPlan(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("dutyPlans", "discardDraft", documentId, version);
}

export async function deleteDutyPlan(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("dutyPlans", "delete", documentId, version);
}
