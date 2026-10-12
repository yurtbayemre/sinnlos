import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrapiError } from "@/lib/strapi-error";

/**
 * WD03: the /manage/analytics view-model from mocked reads. A count that
 * cannot be read is null ("–" with the banner), never the 0 the page used
 * to show; one failed activity read no longer zeroes the others. Snapshots
 * per scenario: success, partial failure, CMS down (the counts are totals,
 * nothing to truncate).
 */
const countMock = vi.fn<(collection: string) => Promise<unknown>>();
const reactionsMock = vi.fn<() => Promise<unknown>>();
const unreadMock = vi.fn<() => Promise<unknown>>();
const commentsMock = vi.fn<() => Promise<unknown>>();
const searchMock = vi.fn<() => Promise<unknown>>();

vi.mock("@/lib/api/analytics", () => ({
  countPage: (collection: string) => countMock(collection),
  reactionsPage: () => reactionsMock(),
  unreadNotificationsPage: () => unreadMock(),
  recentComments: () => commentsMock(),
  searchSummary: () => searchMock(),
}));

const { loadAnalytics, zeroResultRate, ANALYTICS_STATS } = await import("./analytics");

const total = (n: number) => ({
  data: [{ id: 1 }],
  meta: { pagination: { page: 1, pageSize: 1, pageCount: n, total: n } },
});
const TOTALS: Record<string, number> = {
  announcements: 12,
  events: 7,
  "wiki-pages": 40,
  "wiki-spaces": 4,
  documents: 9,
  polls: 3,
  comments: 55,
};
const COMMENTS = {
  data: [
    {
      id: 1,
      body: "Great!",
      targetType: "announcement",
      createdAt: "2026-09-28T09:15:00.000Z",
      author: { id: 2, username: "grace", displayName: "" },
    },
    { id: 2, body: "Anonymous", targetType: "wiki-page", author: null },
  ],
};
const SEARCH = {
  windowDays: 30,
  total: 8,
  zeroResultCount: 3,
  topTerms: [{ term: "vpn", count: 4, avgResults: 2 }],
  topZeroTerms: [{ term: "kantine", count: 2 }],
};
const outage = () => new StrapiError(502, "Bad Gateway", "");

beforeEach(() => {
  countMock.mockReset().mockImplementation(async (c) => total(TOTALS[c] ?? 0));
  reactionsMock.mockReset().mockResolvedValue(total(120));
  unreadMock.mockReset().mockResolvedValue(total(6));
  commentsMock.mockReset().mockResolvedValue(COMMENTS);
  searchMock.mockReset().mockResolvedValue(SEARCH);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadAnalytics", () => {
  it("success: every total, the search summary with its zero rate, recent comments", async () => {
    const view = await loadAnalytics();
    expect(Object.keys(view.counts).sort()).toEqual([...ANALYTICS_STATS].sort());
    expect(view.counts.comments).toEqual({ value: 55, truncated: false });
    expect(view.counts.reactions).toEqual({ value: 120, truncated: false });
    expect(view.search?.zeroRate).toBe(38);
    expect(view.recentComments.map((c) => c.authorName)).toEqual(["grace", null]);
    expect(view).toMatchSnapshot();
  });

  it("partial failure: a failed count is unknown and raises the banner, the rest stays", async () => {
    countMock.mockImplementation(async (c) => {
      if (c === "polls") throw outage();
      return total(TOTALS[c] ?? 0);
    });
    reactionsMock.mockRejectedValue(outage());
    const view = await loadAnalytics();
    expect(view).toMatchObject({ failed: true, countsFailed: true });
    expect(view.counts.polls).toEqual({ value: null, truncated: false });
    expect(view.counts.reactions).toEqual({ value: null, truncated: false });
    // One failed activity read no longer zeroes the others.
    expect(view.counts.unreadNotifications).toEqual({ value: 6, truncated: false });
    expect(view.recentComments).toHaveLength(2);
    expect(view).toMatchSnapshot();
  });

  it("partial failure: no search summary hides the section and raises the banner", async () => {
    searchMock.mockRejectedValue(outage());
    const view = await loadAnalytics();
    expect(view).toMatchObject({ search: null, failed: true, countsFailed: false });
  });

  it("a summary of another shape counts as failed instead of crashing the page", async () => {
    searchMock.mockResolvedValue({ data: [], meta: { pagination: { total: 0 } } });
    const view = await loadAnalytics();
    expect(view).toMatchObject({ search: null, failed: true, countsFailed: false });
  });

  it("CMS down: every count unknown, no 0 anywhere", async () => {
    countMock.mockRejectedValue(outage());
    for (const mock of [reactionsMock, unreadMock, commentsMock, searchMock]) {
      mock.mockRejectedValue(outage());
    }
    const view = await loadAnalytics();
    expect(view).toMatchSnapshot();
    expect(Object.values(view.counts).every((c) => c.value === null)).toBe(true);
    expect(view.failed).toBe(true);
  });

  it("the zero-result rate is whole percent, 0 without searches", () => {
    expect(zeroResultRate({ total: 0, zeroResultCount: 0 })).toBe(0);
    expect(zeroResultRate({ total: 3, zeroResultCount: 1 })).toBe(33);
  });
});

describe("control flow", () => {
  it("never swallows the expired-session redirect of a read", async () => {
    const expired = (() => {
      try {
        redirect("/sign-in?expired=1");
      } catch (e) {
        return e;
      }
    })();
    searchMock.mockRejectedValue(expired);
    await expect(loadAnalytics()).rejects.toBe(expired);
  });
});
