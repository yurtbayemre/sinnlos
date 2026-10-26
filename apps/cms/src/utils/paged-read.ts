/**
 * Every row of a type, read in ascending-id pages (#175, v0.33), for the
 * visibility loaders that read a whole type WITH a populate: the query
 * engine loads a relation with one statement that binds the parent ids of
 * the rows just read, so one read of 70,000 rows binds 70,000 parameters
 * and fails past the database's limit (Postgres 65535, SQLite 32766). A
 * page binds at most LOADER_PAGE. The pattern of
 * utils/poll-audience-backfill.ts readNullFlagRows.
 *
 * Mixed time: each page is its own statement under Read Committed, so a
 * write that commits during the scan can show on a later page and not on
 * an earlier one, and rows inserted above the cursor can join the scan.
 * There is no snapshot across the pages (as across the separate statements
 * of one loader before). Callers that need a fail-closed marker to win
 * re-read it after the last page (withFreshAnnouncementFlags).
 */

/** Rows per page: the parent ids one populate statement binds. */
export const LOADER_PAGE = 5000;

/** The slice of a query-engine query the reader uses. */
export interface PagedQuery {
  findMany(params: Record<string, unknown>): Promise<unknown>;
}

/**
 * Every row matching `params.where`, read page by page by an id cursor.
 * `params.select` must contain `id`; `orderBy`, `limit` and the cursor are
 * the reader's.
 */
export async function findAllPaged<T extends { id: number }>(
  query: PagedQuery,
  params: { where?: Record<string, unknown>; select: string[]; populate?: Record<string, unknown> },
  pageSize: number = LOADER_PAGE,
): Promise<T[]> {
  const rows: T[] = [];
  let afterId = 0;
  for (;;) {
    const cursor = { id: { $gt: afterId } };
    const page = await query.findMany({
      ...params,
      where: params.where ? { $and: [params.where, cursor] } : cursor,
      orderBy: [{ id: "asc" }],
      limit: pageSize,
    });
    const list = Array.isArray(page) ? (page as T[]) : [];
    rows.push(...list);
    if (list.length < pageSize) return rows;
    const lastId = list[list.length - 1]?.id;
    // A full page that does not move the cursor would repeat forever.
    if (typeof lastId !== "number" || lastId <= afterId) {
      throw new Error(`a paged read did not advance past id ${afterId}`);
    }
    afterId = lastId;
  }
}
