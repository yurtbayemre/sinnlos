import { unstable_rethrow } from "next/navigation";
import {
  ROLE_PRIVILEGE_ORDER,
  type RoleType,
  type UserAdminDetail,
  type UserAdminListQuery,
  type UserAdminListResponse,
} from "@sinnlos/domain";
import { fetchUserAdminDetail, fetchUserAdminList } from "@/lib/api/manage/users";
import { tryFetch } from "@/lib/safe-fetch";
import { isNotFoundError } from "./editor";

/** The longest search text the list forwards. */
export const USER_SEARCH_MAX_LENGTH = 100;

type SearchParams = Record<string, string | string[] | undefined>;

const single = (value: string | string[] | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

/** /manage/users' search params as the cms takes them; anything else is dropped. */
export function parseUserListQuery(params: SearchParams): UserAdminListQuery {
  const query: UserAdminListQuery = {};
  const q = single(params.q)?.trim();
  if (q) query.q = q.slice(0, USER_SEARCH_MAX_LENGTH);
  const role = single(params.role);
  if (role && (ROLE_PRIVILEGE_ORDER as readonly string[]).includes(role))
    query.role = role as RoleType;
  const blocked = single(params.blocked);
  if (blocked === "true" || blocked === "false") query.blocked = blocked;
  const page = Number(single(params.page));
  if (Number.isSafeInteger(page) && page > 1 && page <= 10_000) query.page = page;
  return query;
}

/** One list page; `failed` on any error (the page shows the banner, never an empty list). */
export async function loadUserList(
  query: UserAdminListQuery,
): Promise<{ list: UserAdminListResponse | null; failed: boolean }> {
  const res = await tryFetch(() => fetchUserAdminList(query), "manage-users");
  return { list: res.data, failed: res.failed };
}

export type UserLoad =
  { state: "ok"; user: UserAdminDetail } | { state: "notFound" } | { state: "failed" };

/** One user by the route's id: a malformed id, a 404 or a 403 is notFound. */
export async function loadUserDetail(rawId: string): Promise<UserLoad> {
  const id = Number(rawId);
  if (!/^[1-9]\d{0,9}$/.test(rawId) || !Number.isSafeInteger(id)) return { state: "notFound" };
  try {
    const user = (await fetchUserAdminDetail(id))?.data;
    if (!user || user.id !== id) {
      console.error("[manage-users] detail answered an unexpected shape");
      return { state: "failed" };
    }
    return { state: "ok", user };
  } catch (error) {
    unstable_rethrow(error);
    if (isNotFoundError(error)) return { state: "notFound" };
    console.error("[manage-users] detail failed", error);
    return { state: "failed" };
  }
}
