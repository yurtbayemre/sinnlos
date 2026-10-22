import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  ROLE_PRIVILEGE_ORDER,
  USER_ADMIN_PAGE_SIZE,
  type UserAdminListQuery,
} from "@sinnlos/domain";
import { FetchErrorBanner } from "@/components/fetch-error";
import { ManagePageHeader } from "@/components/manage/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { inputClass } from "@/components/manage/form-controls";
import {
  loadUserList,
  parseUserListQuery,
  USER_SEARCH_MAX_LENGTH,
} from "@/lib/loaders/manage/users";
import { manageGate } from "@/lib/manage/page-gate";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  const t = await getTranslations("manage.users");
  return { title: t("title") };
}

/** The list's URL with `query` (the search form submits the same parameters by GET). */
function listHref(query: UserAdminListQuery): Route {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, String(value));
  const search = params.toString();
  return (search ? `/manage/users?${search}` : "/manage/users") as Route;
}

/** Every user for admin_role (v0.23): search, role and status filters, one page at a time. */
export default async function ManageUsersPage({ searchParams }: Props) {
  const { capabilities } = await manageGate();
  if (!capabilities.users.manage) redirect("/manage");
  const query = parseUserListQuery(await searchParams);
  const [t, tl, { list, failed }] = await Promise.all([
    getTranslations("manage.users"),
    getTranslations("manage.common.list"),
    loadUserList(query),
  ]);
  const total = list?.meta.total ?? 0;
  const page = list?.meta.page ?? 1;
  const pageCount = Math.max(1, Math.ceil(total / (list?.meta.pageSize ?? USER_ADMIN_PAGE_SIZE)));
  const selectClass = `${inputClass} sm:w-48`;

  return (
    <div className="space-y-6">
      <ManagePageHeader title={t("title")} description={t("description")} back="/manage" />
      <form method="get" action="/manage/users" className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <label htmlFor="users-q" className="block text-sm font-medium">
            {t("search.label")}
          </label>
          <input
            id="users-q"
            name="q"
            type="search"
            defaultValue={query.q ?? ""}
            maxLength={USER_SEARCH_MAX_LENGTH}
            placeholder={t("search.placeholder")}
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="users-role" className="block text-sm font-medium">
            {t("search.role")}
          </label>
          <select
            id="users-role"
            name="role"
            defaultValue={query.role ?? ""}
            className={selectClass}
          >
            <option value="">{t("search.anyRole")}</option>
            {ROLE_PRIVILEGE_ORDER.map((role) => (
              <option key={role} value={role}>
                {t(`roles.${role}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="users-blocked" className="block text-sm font-medium">
            {t("search.status")}
          </label>
          <select
            id="users-blocked"
            name="blocked"
            defaultValue={query.blocked ?? ""}
            className={selectClass}
          >
            <option value="">{t("search.anyStatus")}</option>
            <option value="false">{t("search.active")}</option>
            <option value="true">{t("search.blocked")}</option>
          </select>
        </div>
        <button type="submit" className={buttonVariants({ variant: "outline" })}>
          {t("search.submit")}
        </button>
      </form>

      {failed ? (
        <FetchErrorBanner />
      ) : list && list.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("list.empty")}</p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {(list?.data ?? []).map((user) => (
            <li key={user.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
              <div className="min-w-0 flex-1">
                <Link
                  href={`/manage/users/${user.id}` as Route}
                  className="font-medium hover:underline"
                >
                  {user.displayName}
                </Link>
                <p className="min-w-0 wrap-break-word text-sm text-muted-foreground">
                  {user.email}
                </p>
              </div>
              <span className="text-sm">
                {user.role ? t(`roles.${user.role}`) : t("roles.none")}
                {user.idp && (
                  <span className="text-muted-foreground">
                    {" · "}
                    {user.roleSource === "manual"
                      ? t("list.manual")
                      : user.idp === "oidc"
                        ? t("oidc.list")
                        : t("list.entra")}
                  </span>
                )}
              </span>
              <span className="text-sm text-muted-foreground">
                {user.department?.name ?? t("list.noDepartment")}
              </span>
              {user.blocked && (
                <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                  {t("list.blocked")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {!failed && list && (
        <nav
          aria-label={tl("pagination")}
          className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"
        >
          <span>{tl("total", { count: total })}</span>
          {pageCount > 1 && (
            <div className="flex items-center gap-2">
              {page > 1 && (
                <Link
                  href={listHref({ ...query, page: page - 1 })}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  rel="prev"
                >
                  {tl("previous")}
                </Link>
              )}
              <span aria-current="page">{tl("page", { page, pageCount })}</span>
              {page < pageCount && (
                <Link
                  href={listHref({ ...query, page: page + 1 })}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  rel="next"
                >
                  {tl("next")}
                </Link>
              )}
            </div>
          )}
        </nav>
      )}
    </div>
  );
}
