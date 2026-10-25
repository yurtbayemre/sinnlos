/**
 * User administration transport (v0.23, admin_role only): the fixed DTOs of
 * /api/user-management (@sinnlos/domain user-admin.ts). The cms checks the
 * caller, every field and every rule again.
 */
import {
  USER_ADMIN_PATH,
  type AnonymisePreviewResponse,
  type AnonymiseRequest,
  type AnonymiseResponse,
  type TrainingEvidenceResponse,
  type UserExport,
  type UserAdminDetailResponse,
  type UserAdminInvite,
  type UserAdminListQuery,
  type UserAdminMailResponse,
  type UserAdminListResponse,
  type UserAdminUpdate,
} from "@sinnlos/domain";
import { strapi } from "@/lib/strapi/client";
import { strapiQuery, withQuery } from "@/lib/strapi/query";

/** v0.30: the two long admin calls get their own bounds instead of strapi()'s default. */
export const USER_EXPORT_TIMEOUT_MS = 120_000;
export const ANONYMISE_TIMEOUT_MS = 300_000;
/** Above the cms's own 15 s mail budget (account-mail.ts), after its database work. */
export const ACCOUNT_MAIL_TIMEOUT_MS = 30_000;

export function fetchUserAdminList(query: UserAdminListQuery): Promise<UserAdminListResponse> {
  const params = strapiQuery();
  if (query.q) params.value("q", query.q);
  if (query.role) params.value("role", query.role);
  if (query.blocked) params.value("blocked", query.blocked);
  if (query.page && query.page > 1) params.value("page", query.page);
  return strapi(withQuery(`/api/${USER_ADMIN_PATH}`, params));
}

export function fetchUserAdminDetail(id: number): Promise<UserAdminDetailResponse> {
  return strapi(`/api/${USER_ADMIN_PATH}/${id}`);
}

export function sendUserAdminUpdate(
  id: number,
  data: UserAdminUpdate,
): Promise<UserAdminDetailResponse> {
  return strapi(`/api/${USER_ADMIN_PATH}/${id}`, {
    method: "PUT",
    body: JSON.stringify({ data }),
  });
}

/** v0.27: a new local account, invited by mail to set its password. */
export function sendUserInvite(data: UserAdminInvite): Promise<UserAdminMailResponse> {
  return strapi(`/api/${USER_ADMIN_PATH}/invite`, {
    method: "POST",
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(ACCOUNT_MAIL_TIMEOUT_MS),
  });
}

/** v0.27: a new invitation (no password yet) or reset link by mail. */
export function sendUserLink(id: number): Promise<UserAdminMailResponse> {
  return strapi(`/api/${USER_ADMIN_PATH}/${id}/send-link`, {
    method: "POST",
    signal: AbortSignal.timeout(ACCOUNT_MAIL_TIMEOUT_MS),
  });
}

/** v0.27: clears the user's second factor; they set it up again at the next sign-in. */
export function sendUserMfaReset(id: number): Promise<UserAdminDetailResponse> {
  return strapi(`/api/${USER_ADMIN_PATH}/${id}/reset-mfa`, { method: "POST" });
}

/** Hands the role back to Entra: the next sign-in applies Entra's role. */
export function sendRoleToEntra(id: number): Promise<UserAdminDetailResponse> {
  return strapi(`/api/${USER_ADMIN_PATH}/${id}/role-to-entra`, { method: "POST" });
}

/** v0.28: one person's training receipts with their snapshots (the evidence CSV). */
export function fetchUserTrainingEvidence(id: number): Promise<TrainingEvidenceResponse> {
  return strapi(`/api/${USER_ADMIN_PATH}/${id}/training-evidence`);
}

/** v0.28 (Art. 15): everything stored about the person; the cms records an `export` audit row. */
export function fetchUserExport(id: number): Promise<UserExport> {
  return strapi(`/api/${USER_ADMIN_PATH}/${id}/export`, {
    signal: AbortSignal.timeout(USER_EXPORT_TIMEOUT_MS),
  });
}

/** v0.28 (Art. 17): what the anonymisation would delete, rewrite and keep (advisory counts). */
export function fetchAnonymisePreview(id: number): Promise<AnonymisePreviewResponse> {
  return strapi(`/api/${USER_ADMIN_PATH}/${id}/anonymise`);
}

/** v0.28 (Art. 17): anonymises the blocked person; `confirm` is their current username. */
export function sendAnonymise(id: number, confirm: string): Promise<AnonymiseResponse> {
  const body: { data: AnonymiseRequest } = { data: { confirm } };
  return strapi(`/api/${USER_ADMIN_PATH}/${id}/anonymise`, {
    method: "POST",
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ANONYMISE_TIMEOUT_MS),
  });
}
