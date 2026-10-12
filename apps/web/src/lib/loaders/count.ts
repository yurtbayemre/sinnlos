/**
 * Counts as the tiles show them (WD03). A count is never a stand-in for a
 * failed read: `value: null` renders "–" (components/ui/stat-tile.tsx
 * StatCount), never a misleading 0, and the page shows its CMS-down banner.
 */

/** A number a tile shows, with how far it can be trusted. */
export interface Count {
  /** null: the read failed (shown as "–"). */
  value: number | null;
  /**
   * The list walk stopped at its safety cap with pages left over: the real
   * number is higher than `value` (shown as "N+").
   */
  truncated: boolean;
}

/** The count of a failed read. */
export const FAILED_COUNT: Count = Object.freeze({ value: null, truncated: false });

/** A list response as far as its total goes. */
export interface CountedList {
  data?: unknown[] | null;
  meta?: { pagination?: { total?: number } } | null;
}

/**
 * The total of a capped list from its own response (issue #26): Strapi's
 * `meta.pagination.total` (per user: the visibility policy filters the
 * query before the count), else the rows it holds (DEMO_MODE fixtures
 * without pagination), else 0. Optional chaining throughout: a fixture
 * drift must not crash a page.
 */
export function listTotal(list: CountedList | null | undefined): number {
  return list?.meta?.pagination?.total ?? list?.data?.length ?? 0;
}

/** A tryFetch() result of a capped list as a count. */
export function countOfList(result: { data: CountedList | null; failed: boolean }): Count {
  return result.failed ? FAILED_COUNT : { value: listTotal(result.data), truncated: false };
}

/** A tryFetch() result of a complete page walk (walkAllPages) as a count. */
export function countOfWalk(result: {
  data: { data: unknown[]; truncated: boolean } | null;
  failed: boolean;
}): Count {
  if (result.failed || !result.data) return FAILED_COUNT;
  return { value: result.data.data.length, truncated: result.data.truncated };
}
