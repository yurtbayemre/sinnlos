import { afterEach, describe, expect, it, vi } from "vitest";
import { walkAllPages, type PageResult } from "./paginate";

/**
 * `walkAllPages` centralises the "read the COMPLETE list" page walk that
 * previously sat copy-pasted in teams.ts / acknowledgements.ts / rsvps. The
 * two things every copy had to get right — accumulating pages in order and
 * failing closed (with a visible `[list-cap]` warning) when the safety cap
 * is hit — are pinned here. `fetchPage` is injected, so no Strapi/Next
 * runtime is involved.
 */

/** One Strapi list page. */
const page = <T>(data: T[], pageNo: number, pageCount: number): PageResult<T> => ({
  data,
  meta: { pagination: { page: pageNo, pageCount, total: pageCount * data.length } },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("walkAllPages", () => {
  it("walks every page and concatenates the rows in page order", async () => {
    const pages = [page([1, 2], 1, 3), page([3, 4], 2, 3), page([5], 3, 3)];
    const fetchPage = vi.fn(async (p: number) => pages[p - 1]);

    const { data, truncated } = await walkAllPages(fetchPage, { maxPages: 10, label: "x" });

    expect(data).toEqual([1, 2, 3, 4, 5]);
    expect(truncated).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    // Pages must be requested in ascending order, or the walk skips rows.
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  it("stops after a single request when there is only one page", async () => {
    const fetchPage = vi.fn(async () => page([1], 1, 1));

    const { data, truncated } = await walkAllPages(fetchPage, { maxPages: 10, label: "x" });

    expect(data).toEqual([1]);
    expect(truncated).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("treats a response without pagination meta as complete (DEMO_MODE fixtures)", async () => {
    const fetchPage = vi.fn(async () => ({ data: [1, 2] }));

    const { data, truncated } = await walkAllPages(fetchPage, { maxPages: 10, label: "x" });

    expect(data).toEqual([1, 2]);
    expect(truncated).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("flags truncated and warns when the safety cap cuts the walk short", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The server keeps reporting far more pages than the cap allows.
    const fetchPage = vi.fn(async (p: number) => page([p], p, 999));

    const { data, truncated } = await walkAllPages(fetchPage, { maxPages: 3, label: "widgets" });

    expect(truncated).toBe(true);
    expect(data).toEqual([1, 2, 3]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("[list-cap]");
    expect(message).toContain("widgets");
    expect(message).toContain("3-page safety cap");
    expect(message).toContain("INCOMPLETE");
  });

  it("does NOT flag truncated when pageCount equals maxPages exactly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchPage = vi.fn(async (p: number) => page([p], p, 3));

    const { data, truncated } = await walkAllPages(fetchPage, { maxPages: 3, label: "x" });

    expect(truncated).toBe(false);
    expect(data).toEqual([1, 2, 3]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
  });
});
