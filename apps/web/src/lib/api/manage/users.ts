/**
 * User administration transport (v0.23, admin_role only): the fixed DTOs of
 * /api/user-management (@sinnlos/domain user-admin.ts). The cms checks the
 * caller, every field and every rule again.
 */
import {
  USER_ADMIN_PATH,
  type UserAdminDetailResponse,
  type UserAdminListQuery,
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

/** Hands the role back to Entra: the next sign-in applies Entra's role. */
export function sendRoleToEntra(id: number): Promise<UserAdminDetailResponse> {
  return strapi(`/api/${USER_ADMIN_PATH}/${id}/role-to-entra`, { method: "POST" });
}
