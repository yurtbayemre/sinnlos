import {
  AUTHORING_LIST_MAX_QUERY,
  AUTHORING_LIST_PAGE_SIZE,
  type AuthoringListRow,
  type AuthoringListStatusFilter,
  type AuthoringOwnerFilter,
  type AuthoringPagination,
} from "@sinnlos/domain";
import { fetchAuthoringList, type AuthoringListQuery } from "@/lib/api/manage/authoring";
import { AREA_TYPE, hasDrafts, SCHEDULE_FIELDS, type ManageArea } from "@/lib/manage/areas";
import { tryFetch } from "@/lib/safe-fetch";

/**
 * The /manage/<area> lists (WD03; deep-dive decision 06 §B3 `authoringList`,
 * §L1, §N3). One page of 25 rows from the cms, which decides what the
 * caller sees: moderators every item, a department author exactly their
 * department's owned items. The page renders this view model only.
 *
 * The filters come from the URL, so they are untrusted: anything that is
 * not a status tab of the area, a page number or (moderators, owner-aware
 * areas) an owner filter is dropped, and `q` is trimmed and capped, before
 * a request is built. A failed read is `failed` (the banner), never an
 * empty list.
 */

/** The status tabs of an area, "all" first. */
export function statusTabs(area: ManageArea): ("all" | AuthoringListStatusFilter)[] {
  if (!hasDrafts(area)) return [];
  const tabs: ("all" | AuthoringListStatusFilter)[] = ["all", "draft", "published", "modified"];
  if (SCHEDULE_FIELDS[area].length > 0) tabs.push("scheduled", "failed");
  return tabs;
}

/** The URL search parameters of a list page, as Next hands them over. */
export type ListSearchParams = Record<string, string | string[] | undefined>;

export interface ListFilters {
  status: AuthoringListStatusFilter | null;
  q: string;
  page: number;
  owner: AuthoringOwnerFilter | null;
}

const first = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? "";

/**
 * The filters of a list URL that the area and the viewer can use.
 * `ownerFilter`: whether the viewer may filter by owner (moderators on
 * announcements and events).
 */
export function parseListFilters(
  area: ManageArea,
  params: ListSearchParams,
  { ownerFilter }: { ownerFilter: boolean },
): ListFilters {
  const status = first(params.status);
  const tabs = statusTabs(area);
  const page = Number(first(params.page));
  const owner = first(params.owner);
  return {
    status:
      status !== "all" && (tabs as string[]).includes(status)
        ? (status as AuthoringListStatusFilter)
        : null,
    q: first(params.q).trim().slice(0, AUTHORING_LIST_MAX_QUERY),
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
    owner: ownerFilter && (owner === "department" || owner === "moderators") ? owner : null,
  };
}

export interface ManageListView {
  rows: AuthoringListRow[];
  pagination: AuthoringPagination;
  /** The read answered no row and nothing failed. */
  empty: boolean;
  /** The read failed: the CMS-down banner, no rows. */
  failed: boolean;
}

const NO_PAGES: AuthoringPagination = {
  page: 1,
  pageSize: AUTHORING_LIST_PAGE_SIZE,
  pageCount: 0,
  total: 0,
};

/** One page of the area's authoring list. */
export async function loadManageList(
  area: ManageArea,
  filters: ListFilters,
): Promise<ManageListView> {
  const query: AuthoringListQuery = {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.q ? { q: filters.q } : {}),
    ...(filters.page > 1 ? { page: filters.page } : {}),
    ...(filters.owner ? { owner: filters.owner } : {}),
  };
  const result = await tryFetch(() => fetchAuthoringList(AREA_TYPE[area], query), `manage-${area}`);
  const rows = Array.isArray(result.data?.data) ? result.data.data : [];
  return {
    rows,
    pagination: result.data?.meta?.pagination ?? { ...NO_PAGES, page: filters.page },
    empty: !result.failed && rows.length === 0,
    failed: result.failed,
  };
}
