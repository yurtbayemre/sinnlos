"use server";

import { refresh } from "next/cache";
import {
  ANONYMISE_CODES,
  isDocumentId,
  ROLE_PRIVILEGE_ORDER,
  type AnonymisePreviewResponse,
  type AnonymiseResponse,
  type RoleType,
  type UserAdminInvite,
} from "@sinnlos/domain";
import {
  actionFailure,
  runCmsAction,
  type ActionFailure,
  type ActionResult,
} from "@/lib/action-result";
import {
  fetchAnonymisePreview,
  sendAnonymise,
  sendRoleToEntra,
  sendUserAdminUpdate,
  sendUserInvite,
  sendUserLink,
  sendUserMfaReset,
} from "@/lib/api/manage/users";
import { capabilitiesFor } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";
import { buildUserPayload, coerceUserValues } from "./user-values";

export type UserActionResult = ActionResult<never, null>;

const isUserId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

async function adminGate(id: unknown): Promise<ActionFailure | null> {
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

/**
 * How one invitation ended (v0.27): sent, or the account exists but its
 * mail failed (send the link again from its page), or why the cms refused
 * it. The cms checks the caller and every field again.
 */
export type InviteOutcome =
  | "sent"
  | "mailFailed"
  | "taken"
  | "invalid"
  | "localSignInOff"
  | "mailNotConfigured"
  | "emailDuplicates"
  | "failed";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

/** The invite body from untrusted input, or null. */
function coerceInvite(raw: unknown): UserAdminInvite | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { email, displayName, role, department } = raw as Record<string, unknown>;
  if (typeof email !== "string" || !EMAIL.test(email.trim())) return null;
  if (displayName !== undefined && (typeof displayName !== "string" || displayName.length > 255)) {
    return null;
  }
  if (typeof role !== "string" || !ROLE_PRIVILEGE_ORDER.includes(role as RoleType)) return null;
  if (department !== null && !isDocumentId(department)) {
    return null;
  }
  return {
    email: email.trim(),
    ...(displayName?.trim() ? { displayName: displayName.trim() } : {}),
    role: role as RoleType,
    department,
  };
}

/** admin_role only (v0.27): one invitation; the bulk form calls it per line. */
export async function inviteUser(raw: unknown): Promise<InviteOutcome> {
  const refused = await adminGate(1);
  if (refused) return "failed";
  const data = coerceInvite(raw);
  if (!data) return "invalid";
  const result = await runCmsAction<"emailDuplicates", { data?: { mail?: unknown } }, unknown>(
    () => sendUserInvite(data),
    {
      label: "[manage-users] invite",
      mapError: (cms) =>
        cms.details?.code === "email_duplicates_exist" ? "emailDuplicates" : undefined,
      data: (answer) => answer.data?.mail,
    },
  );
  if (result.ok) return result.data === "sent" ? "sent" : "mailFailed";
  if (result.code === "emailDuplicates") return "emailDuplicates";
  if (result.code === "invalid") {
    if (result.fields?.email === "taken") return "taken";
    const form = result.fields?._form;
    if (form === "localSignInOff" || form === "mailNotConfigured") return form;
    return "invalid";
  }
  return "failed";
}

export type LinkResult = ActionResult<
  "notLocal" | "blocked" | "localSignInOff" | "mailNotConfigured" | "mailFailed",
  null
>;

/** admin_role only (v0.27): a new invitation or reset link by mail. */
export async function sendLink(id: unknown): Promise<LinkResult> {
  const refused = await adminGate(id);
  if (refused) return refused;
  const result = await runCmsAction<never, { data?: { mail?: unknown } }, unknown>(
    () => sendUserLink(id as number),
    { label: "[manage-users] send-link", data: (answer) => answer.data?.mail },
  );
  if (result.ok)
    return result.data === "sent" ? { ok: true, data: null } : actionFailure("mailFailed");
  const form = result.code === "invalid" ? result.fields?._form : undefined;
  if (
    form === "notLocal" ||
    form === "blocked" ||
    form === "localSignInOff" ||
    form === "mailNotConfigured"
  ) {
    return actionFailure(form);
  }
  return result;
}

/** admin_role only (v0.27): clears the user's second factor (their sessions end). */
export async function resetUserMfa(id: unknown): Promise<UserActionResult> {
  const refused = await adminGate(id);
  if (refused) return refused;
  return runCmsAction(() => sendUserMfaReset(id as number), {
    label: "[manage-users] reset-mfa",
    after: () => refresh(),
    data: () => null,
  });
}

export type AnonymisePreview = AnonymisePreviewResponse["data"];

/** admin_role only (v0.28): the anonymisation's advisory counts for the confirm dialog. */
export async function previewAnonymisation(
  id: unknown,
): Promise<ActionResult<never, AnonymisePreview>> {
  const refused = await adminGate(id);
  if (refused) return refused;
  return runCmsAction(() => fetchAnonymisePreview(id as number), {
    label: "[manage-users] anonymise-preview",
    data: (answer) => answer.data,
  });
}

export type AnonymiseError = (typeof ANONYMISE_CODES)[keyof typeof ANONYMISE_CODES];
export type AnonymiseOutcome = AnonymiseResponse["data"];

/**
 * admin_role only (v0.28, Art. 17): anonymises a blocked person for good.
 * `confirm` is their current username as the admin typed it; the cms
 * checks it against the locked row ("confirm"), refuses a person who is not
 * blocked ("notBlocked") or already anonymised ("anonymised").
 */
export async function anonymiseUser(
  id: unknown,
  confirm: unknown,
): Promise<ActionResult<AnonymiseError, AnonymiseOutcome>> {
  const refused = await adminGate(id);
  if (refused) return refused;
  if (typeof confirm !== "string" || confirm.trim() === "" || confirm.length > 255) {
    return actionFailure(ANONYMISE_CODES.confirm);
  }
  return runCmsAction(() => sendAnonymise(id as number, confirm.trim()), {
    label: "[manage-users] anonymise",
    mapError: (cms) => {
      const code = cms.details?.code;
      if (cms.status === 409 && (code === "notBlocked" || code === "anonymised")) return code;
      if (cms.status === 400 && code === "confirm") return "confirm";
      return undefined;
    },
    after: () => refresh(),
    data: (answer) => answer.data,
  });
}
