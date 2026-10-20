"use server";

import { transitionItem, type AuthoringActionResult } from "./authoring-action";
import { buildKpiPayload } from "./payload";
import { saveItem, type SaveInput } from "./save";
import { coerceKpiValues } from "./values";

/**
 * The KPI actions of /manage (v0.19): see announcement-actions.ts.
 * Moderators and the department's heads (their own department); no
 * schedule, delete for moderators only.
 */

export async function saveKpi(input: SaveInput): Promise<AuthoringActionResult> {
  return saveItem("kpis", input, { coerce: coerceKpiValues, build: buildKpiPayload });
}

export async function publishKpi(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("kpis", "publish", documentId, version);
}

export async function unpublishKpi(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("kpis", "unpublish", documentId, version);
}

export async function discardKpi(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("kpis", "discardDraft", documentId, version);
}

export async function deleteKpi(
  documentId: unknown,
  version: unknown,
): Promise<AuthoringActionResult> {
  return transitionItem("kpis", "delete", documentId, version);
}
