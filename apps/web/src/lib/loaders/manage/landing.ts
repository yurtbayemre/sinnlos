import type { AuthoringListStatusFilter } from "@sinnlos/domain";
import { fetchAuthoringList } from "@/lib/api/manage/authoring";
import { AREA_TYPE, hasDrafts, SCHEDULE_FIELDS, type ManageArea } from "@/lib/manage/areas";
import { tryFetch } from "@/lib/safe-fetch";
import { FAILED_COUNT, type Count } from "../count";

/**
 * The /manage landing tiles (WD03; deep-dive decision 06 §L1: "one tile per
 * area (drafts, scheduled, failed schedules)"). Per area the viewer authors
 * in, the totals of its authoringList filters, each from one page-1 read's
 * `meta.pagination.total`: what needs attention. The cms scopes them per
 * caller (a department author counts their department's items). A failed
 * count is "–" (FAILED_COUNT), never 0, and the page shows the banner.
 */

/** The filters a landing tile counts. */
export type CountedFilter = Extract<AuthoringListStatusFilter, "draft" | "scheduled" | "failed">;

/** The counted filters of an area: drafts and, where it schedules, scheduled and failed. */
export function countedFilters(area: ManageArea): CountedFilter[] {
  if (!hasDrafts(area)) return [];
  return SCHEDULE_FIELDS[area].length > 0 ? ["draft", "scheduled", "failed"] : ["draft"];
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
      const result = await tryFetch(
        () => fetchAuthoringList(AREA_TYPE[area], { status }),
        `manage-${area}`,
      );
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
