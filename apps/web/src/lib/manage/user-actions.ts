"use server";

import { refresh } from "next/cache";
import { actionFailure, runCmsAction, type ActionResult } from "@/lib/action-result";
import { sendRoleToEntra, sendUserAdminUpdate } from "@/lib/api/manage/users";
import { capabilitiesFor } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";
import { buildUserPayload, coerceUserValues } from "./user-values";

export type UserActionResult = ActionResult<never, null>;

const isUserId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

async function adminGate(id: unknown): Promise<UserActionResult | null> {
  const viewer = await getViewer();
  if (viewer.id === null) return actionFailure("unavailable");
  if (!capabilitiesFor(viewer.role).users.manage) return actionFailure("forbidden");
  if (!isUserId(id)) return actionFailure("invalid");
  return null;
}

/** admin_role only (v0.23); the cms decides every field and rule again. */
export async function saveUser(
  id: unknown,
  rawValues: unknown,
  rawInitial: unknown,
): Promise<UserActionResult> {
  const refused = await adminGate(id);
  if (refused) return refused;
  const values = coerceUserValues(rawValues);
  const initial = coerceUserValues(rawInitial);
  if (!values || !initial) return actionFailure("invalid");
  const data = buildUserPayload(values, initial);
  if (Object.keys(data).length === 0) return { ok: true, data: null };
  return runCmsAction(() => sendUserAdminUpdate(id as number, data), {
    label: "[manage-users] save",
    after: () => refresh(),
    data: () => null,
  });
}

/** admin_role only: the next sign-in applies Entra's role again. */
export async function handRoleToEntra(id: unknown): Promise<UserActionResult> {
  const refused = await adminGate(id);
  if (refused) return refused;
  return runCmsAction(() => sendRoleToEntra(id as number), {
    label: "[manage-users] role-to-entra",
    after: () => refresh(),
    data: () => null,
  });
}
