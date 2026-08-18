/**
 * Generic Strapi list page-walk.
 *
 * Every core-content list endpoint (classifieds, announcements,
 * acknowledgements, event-rsvps, teams …) returns `meta.pagination` and
 * honours `pagination[page]`/`pagination[pageSize]` — this CMS sets NO
 * `api.rest.maxLimit`, so a `pageSize` above 100 is served in full. The one
 * thing every consumer that needs the COMPLETE list still has to do is walk
 * `page = 1..pageCount`, because a single request is still bounded by
 * whatever `pageSize` it asked for.
 *
 * This helper centralises that walk (previously copy-pasted into
 * `teams.ts`, `acknowledgements.ts` and `events.rsvps`) together with the
 * two things every copy has to get right:
 *   - a hard `maxPages` safety cap, so a wrong `pageCount` can't spin
 *     forever, and
 *   - a `truncated` signal + a `[list-cap]` warning when that cap is hit,
 *     so an INCOMPLETE list is never silently mistaken for a complete one
 *     (issue #14).
 *
 * `fetchPage` is injected (not tied to `strapi`), which keeps this pure and
 * unit-testable and lets `/api/users` — which pages by `start`/`limit`
 * instead of `pagination[page]` — keep its own walk in `users.ts`.
 */

/** One list page as returned by a Strapi content-type `find`. */
export interface PageResult<T> {
  data: T[];
  meta?: { pagination?: { page: number; pageCount: number; total?: number } };
}

export interface WalkOptions {
  /** Hard upper bound on requests — bounds a runaway loop if `pageCount`
   *  ever comes back wrong. Hitting it sets `truncated`. */
  maxPages: number;
  /** Human-readable list name for the `[list-cap]` warning. */
  label: string;
}

export interface WalkResult<T> {
  data: T[];
  /**
   * `true` when the walk stopped at `maxPages` while the server still
   * reported more pages: the returned `data` is INCOMPLETE and callers must
   * fail closed instead of treating it as the whole list.
   */
  truncated: boolean;
}

export async function walkAllPages<T>(
  fetchPage: (page: number) => Promise<PageResult<T>>,
  opts: WalkOptions,
): Promise<WalkResult<T>> {
  const { maxPages, label } = opts;
  const data: T[] = [];
  let truncated = false;
  let pageCount = 1;

  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchPage(page);
    data.push(...(res?.data ?? []));

    const pagination = res?.meta?.pagination;
    // No pagination meta (DEMO_MODE fixtures, or a non-paginated stub) —
    // treat the single page we got as the complete list.
    if (!pagination) break;

    pageCount = pagination.pageCount;
    if (page >= pageCount) break;

    // More pages exist but we've reached the safety cap: stop and flag the
    // list as incomplete rather than walking unbounded.
    if (page >= maxPages) {
      truncated = true;
      break;
    }
  }

  if (truncated) {
    console.warn(
      `[list-cap] '${label}' hit the ${maxPages}-page safety cap (${pageCount} pages total) — list is INCOMPLETE`,
    );
  }

  return { data, truncated };
}
