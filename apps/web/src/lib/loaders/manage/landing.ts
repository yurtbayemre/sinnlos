import type { Route } from "next";
import type { AuthoringListStatusFilter } from "@sinnlos/domain";
import { fetchAuthoringList } from "@/lib/api/manage/authoring";
import { fetchWikiPageList } from "@/lib/api/manage/wiki";
import {
  AREA_PATH,
  AREA_TYPE,
  hasDrafts,
  SCHEDULE_FIELDS,
  type ManageArea,
} from "@/lib/manage/areas";
import { tryFetch } from "@/lib/safe-fetch";
import { FAILED_COUNT, type Count } from "../count";
import { statusTabs } from "./list";

/**
 * The /manage landing tiles (WD03; deep-dive decision 06 §L1: "one tile per
 * area (drafts, scheduled, failed schedules)"; issue #78 adds the published
 * items). Per area the viewer authors in, the totals of its authoringList
 * filters, each from one page-1 read's `meta.pagination.total`: what is
 * live and what needs attention. The cms scopes them per caller (a
 * department author counts their department's items). A failed count is
 * "–" (FAILED_COUNT), never 0, and the page shows the banner.
 * The wiki tile counts the wiki's PAGES (drafts, published, scheduled,
 * failed; the moderators' wiki-page authoringList), the work that waits
 * there; spaces are always published.
 */

/** The filters a landing tile counts. */
export type CountedFilter = Extract<
  AuthoringListStatusFilter,
  "draft" | "published" | "scheduled" | "failed"
>;

/**
 * The counted filters of an area, in the order of the list's status tabs:
 * drafts and the published items, and scheduled and failed where the area
 * schedules. Polls publish at create (no drafts): their published polls
 * only. `published` is the list's tab of that name: a published item
 * whose draft was saved after its publication is "Changes pending" there
 * (`modified`), and not counted here.
 */
export function countedFilters(area: ManageArea): CountedFilter[] {
  if (area !== "wiki" && !hasDrafts(area)) return ["published"];
  return SCHEDULE_FIELDS[area].length > 0
    ? ["draft", "published", "scheduled", "failed"]
    : ["draft", "published"];
}

/**
 * The list a count opens: the area's list filtered to that status tab, or
 * null where the list has no such tab (polls have none; the wiki's list
 * holds spaces, not pages) and the tile's own link leads to the list.
 */
export function countHref(area: ManageArea, status: CountedFilter): Route | null {
  if (area === "wiki" || !statusTabs(area).includes(status)) return null;
  return `${AREA_PATH[area]}?status=${status}` as Route;
}

/** The page-1 read whose total is the count. */
function countRead(area: ManageArea, status: CountedFilter) {
  return area === "wiki"
    ? fetchWikiPageList({ status })
    : fetchAuthoringList(AREA_TYPE[area], { status });
}

export interface LandingTile {
  area: ManageArea;
  counts: Partial<Record<CountedFilter, Count>>;
}

export interface LandingView {
  tiles: LandingTile[];
  /** A count failed: the banner, and that count reads "–". */
  failed: boolean;
}

export async function loadManageLanding(areas: readonly ManageArea[]): Promise<LandingView> {
  const reads = areas.flatMap((area) =>
    countedFilters(area).map(async (status) => {
      const result = await tryFetch(() => countRead(area, status), `manage-${area}`);
      const total = result.data?.meta?.pagination?.total;
      const count: Count =
        result.failed || typeof total !== "number"
          ? FAILED_COUNT
          : { value: total, truncated: false };
      return { area, status, count, failed: result.failed };
    }),
  );
  const results = await Promise.all(reads);
  return {
    tiles: areas.map((area) => ({
      area,
      counts: Object.fromEntries(
        results.filter((r) => r.area === area).map((r) => [r.status, r.count]),
      ),
    })),
    failed: results.some((r) => r.failed),
  };
}
