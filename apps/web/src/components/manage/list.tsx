import Link from "next/link";
import type { Route } from "next";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type {
  AuthoringListRow,
  AuthoringListStatusFilter,
  AuthoringOwnerFilter,
  AuthoringPagination,
} from "@sinnlos/domain";
import { buttonVariants } from "@/components/ui/button";
import { formatInstant } from "@/lib/date-format";
import {
  AREA_PATH,
  areaItemPath,
  hasDrafts,
  type ManageArea,
  type TypedArea,
} from "@/lib/manage/areas";
import type { ListFilters } from "@/lib/loaders/manage/list";
import { cn } from "@/lib/utils";
import { inputClass } from "./form-controls";
import { StatusBadges } from "./status-badges";

/**
 * The /manage lists (deep-dive decision 06 §L1, §B3 authoringList): status
 * tabs, a title search, the owner filter for moderators, the rows with
 * their badges, and the pages (25 rows each, K7). Plain links and a GET
 * form, so every filter is a URL and works without JavaScript. Server
 * components (next-intl's hooks work in both).
 */

/** The list URL with `filters`; an unset filter is left out, page 1 has no page. */
export function listHref(area: ManageArea, filters: Partial<ListFilters>): Route {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.q) params.set("q", filters.q);
  if (filters.owner) params.set("owner", filters.owner);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const qs = params.toString();
  return (qs ? `${AREA_PATH[area]}?${qs}` : AREA_PATH[area]) as Route;
}

const pillClass = (active: boolean) =>
  cn(
    "inline-flex items-center rounded-full border px-3 py-1 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    active
      ? "border-primary/40 bg-primary/10 font-medium text-primary"
      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
  );

export function ListToolbar({
  area,
  filters,
  tabs,
  ownerFilter,
}: {
  area: ManageArea;
  filters: ListFilters;
  tabs: ("all" | AuthoringListStatusFilter)[];
  /** Show the owner filter (moderators on announcements and events). */
  ownerFilter: boolean;
}) {
  const t = useTranslations("manage.common.list");
  const owners: (AuthoringOwnerFilter | null)[] = [null, "department", "moderators"];
  return (
    <div className="space-y-3">
      {tabs.length > 0 && (
        <nav aria-label={t("statusFilter")}>
          <ul className="flex flex-wrap gap-2">
            {tabs.map((tab) => {
              const status = tab === "all" ? null : tab;
              const active = filters.status === status;
              return (
                <li key={tab}>
                  <Link
                    href={listHref(area, { ...filters, status, page: 1 })}
                    aria-current={active ? "page" : undefined}
                    className={pillClass(active)}
                  >
                    {t(`tabs.${tab}`)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
      {ownerFilter && (
        <nav aria-label={t("ownerFilter")}>
          <ul className="flex flex-wrap gap-2">
            {owners.map((owner) => {
              const active = filters.owner === owner;
              return (
                <li key={owner ?? "all"}>
                  <Link
                    href={listHref(area, { ...filters, owner, page: 1 })}
                    aria-current={active ? "page" : undefined}
                    className={pillClass(active)}
                  >
                    {t(`owners.${owner ?? "all"}`)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
      <form action={AREA_PATH[area]} method="get" role="search" className="flex flex-wrap gap-2">
        {filters.status && <input type="hidden" name="status" value={filters.status} />}
        {filters.owner && <input type="hidden" name="owner" value={filters.owner} />}
        <label htmlFor={`${area}-q`} className="sr-only">
          {t("searchLabel")}
        </label>
        <input
          id={`${area}-q`}
          name="q"
          type="search"
          defaultValue={filters.q}
          placeholder={t("searchPlaceholder")}
          maxLength={100}
          className={cn(inputClass, "min-w-0 flex-1 sm:max-w-sm")}
        />
        <button type="submit" className={buttonVariants({ variant: "outline" })}>
          <Search className="h-4 w-4" aria-hidden="true" />
          {t("search")}
        </button>
        {filters.q && (
          <Link
            href={listHref(area, { ...filters, q: "", page: 1 })}
            className={buttonVariants({ variant: "ghost" })}
          >
            {t("clear")}
          </Link>
        )}
      </form>
    </div>
  );
}

export function AuthoringList({
  area,
  rows,
  showOwner,
}: {
  area: TypedArea;
  rows: AuthoringListRow[];
  showOwner: boolean;
}) {
  const t = useTranslations("manage.common.list");
  const format = useFormatter();
  return (
    <ul className="divide-y rounded-2xl border bg-card">
      {rows.map((row) => {
        const updated = formatInstant(format, row.updatedAt, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        return (
          <li key={row.documentId} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Link
                href={areaItemPath(area, row.documentId)}
                className="block break-words font-medium outline-none hover:text-primary hover:underline focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring"
              >
                {row.label || "–"}
              </Link>
              <StatusBadges item={row} showOwner={showOwner} hideStatus={!hasDrafts(area)} />
            </div>
            <div className="shrink-0 text-xs text-muted-foreground sm:text-right">
              {updated && <div>{t("updated", { date: updated })}</div>}
              {row.authorName && <div>{t("by", { name: row.authorName })}</div>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function ListPagination({
  area,
  filters,
  pagination,
}: {
  area: ManageArea;
  filters: ListFilters;
  pagination: AuthoringPagination;
}) {
  const t = useTranslations("manage.common.list");
  const { page, pageCount, total } = pagination;
  return (
    <nav
      aria-label={t("pagination")}
      className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"
    >
      <span>{t("total", { count: total })}</span>
      {pageCount > 1 && (
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link
              href={listHref(area, { ...filters, page: page - 1 })}
              className={buttonVariants({ variant: "outline", size: "sm" })}
              rel="prev"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">{t("previous")}</span>
            </Link>
          ) : null}
          <span aria-current="page">{t("page", { page, pageCount })}</span>
          {page < pageCount ? (
            <Link
              href={listHref(area, { ...filters, page: page + 1 })}
              className={buttonVariants({ variant: "outline", size: "sm" })}
              rel="next"
            >
              <span className="sr-only sm:not-sr-only">{t("next")}</span>
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          ) : null}
        </div>
      )}
    </nav>
  );
}
