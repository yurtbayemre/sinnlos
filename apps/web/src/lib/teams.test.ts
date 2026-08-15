import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The acknowledgement report derives the TARGET AUDIENCE of team-scoped
 * announcements from this roster, so an incomplete roster is not a
 * cosmetic truncation — it silently empties the denominator and used to
 * render as a green "everyone confirmed".
 *
 * `api.teams.list()` sent no `pagination[pageSize]` and therefore stopped
 * at Strapi's `api.rest.defaultLimit` = 25. These tests pin the page walk
 * that replaced it, and the `truncated` signal callers need to fail closed.
 *
 * `@/lib/strapi` is mocked wholesale — the real module pulls in next/auth
 * and only its URL contract matters here.
 */
const strapiMock = vi.fn();
vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));

const { fetchAllTeams } = await import("./teams");

/** One Strapi list page. */
const page = (ids: number[], pageNo: number, pageCount: number) => ({
  data: ids.map((id) => ({ id, lead: { id: id * 100 }, members: [] })),
  meta: { pagination: { page: pageNo, pageSize: 100, pageCount, total: pageCount * 100 } },
});

const urls = () => strapiMock.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  strapiMock.mockReset();
});

describe("fetchAllTeams", () => {
  it("asks for the maximum page size instead of relying on the 25-row default", async () => {
    strapiMock.mockResolvedValueOnce(page([1, 2], 1, 1));
    await fetchAllTeams();
    expect(urls()[0]).toContain("pagination[pageSize]=100");
    expect(urls()[0]).toContain("pagination[page]=1");
    // A stable order is required, otherwise a page walk can skip rows.
    expect(urls()[0]).toContain("sort=id:asc");
  });

  it("walks every page and concatenates the roster", async () => {
    strapiMock
      .mockResolvedValueOnce(page([1, 2], 1, 3))
      .mockResolvedValueOnce(page([3, 4], 2, 3))
      .mockResolvedValueOnce(page([5], 3, 3));
    const { teams, truncated } = await fetchAllTeams();
    expect(teams.map((t) => t.id)).toEqual([1, 2, 3, 4, 5]);
    expect(truncated).toBe(false);
    expect(strapiMock).toHaveBeenCalledTimes(3);
    expect(urls()[2]).toContain("pagination[page]=3");
  });

  it("stops after a single request when there is only one page", async () => {
    strapiMock.mockResolvedValueOnce(page([1], 1, 1));
    const { teams, truncated } = await fetchAllTeams();
    expect(teams).toHaveLength(1);
    expect(truncated).toBe(false);
    expect(strapiMock).toHaveBeenCalledTimes(1);
  });

  it("reports truncated=true when the hard page cap cuts the walk short", async () => {
    // pageCount far beyond MAX_PAGES: the roster is incomplete and callers
    // must NOT read the result as "these are all the teams".
    strapiMock.mockImplementation(async (url: string) => {
      const p = Number(/pagination\[page\]=(\d+)/.exec(url)?.[1] ?? 1);
      return page([p], p, 999);
    });
    const { teams, truncated } = await fetchAllTeams();
    expect(truncated).toBe(true);
    expect(teams).toHaveLength(20);
    expect(strapiMock).toHaveBeenCalledTimes(20);
  });

  it("treats a response without pagination meta as complete (DEMO_MODE fixtures)", async () => {
    strapiMock.mockResolvedValueOnce({ data: [{ id: 1 }] });
    const { teams, truncated } = await fetchAllTeams();
    expect(teams.map((t) => t.id)).toEqual([1]);
    expect(truncated).toBe(false);
    expect(strapiMock).toHaveBeenCalledTimes(1);
  });

  it("field-limits the user populates so member e-mails stay out of the cache", async () => {
    strapiMock.mockResolvedValueOnce(page([1], 1, 1));
    await fetchAllTeams();
    expect(urls()[0]).toContain("populate[lead][fields][0]=username");
    expect(urls()[0]).toContain("populate[members][fields][0]=username");
  });
});
