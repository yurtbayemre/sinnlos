/**
 * User administration transport (v0.23, admin_role only): the fixed DTOs of
 * /api/user-management (@sinnlos/domain user-admin.ts). The cms checks the
 * caller, every field and every rule again.
 */
import {
  USER_ADMIN_PATH,
  type UserAdminDetailResponse,
  type UserAdminInvite,
  type UserAdminListQuery,
  type UserAdminMailResponse,
  type UserAdminListResponse,
  type UserAdminUpdate,
} from "@sinnlos/domain";
import { strapi } from "@/lib/strapi/client";
import { strapiQuery, withQuery } from "@/lib/strapi/query";

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
  });
}

/** v0.27: a new invitation (no password yet) or reset link by mail. */
export function sendUserLink(id: number): Promise<UserAdminMailResponse> {
  return strapi(`/api/${USER_ADMIN_PATH}/${id}/send-link`, { method: "POST" });
}

/** v0.27: clears the user's second factor; they set it up again at the next sign-in. */
export function sendUserMfaReset(id: number): Promise<UserAdminDetailResponse> {
  return strapi(`/api/${USER_ADMIN_PATH}/${id}/reset-mfa`, { method: "POST" });
}

/** Hands the role back to Entra: the next sign-in applies Entra's role. */
export function sendRoleToEntra(id: number): Promise<UserAdminDetailResponse> {
  return strapi(`/api/${USER_ADMIN_PATH}/${id}/role-to-entra`, { method: "POST" });
}
