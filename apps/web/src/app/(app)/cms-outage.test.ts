import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmptyState } from "@/components/empty-state";
import { LatestNews } from "@/components/dashboard/latest-news";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PollsEmptyState } from "@/components/polls/polls-empty-state";
import { StatCount } from "@/components/ui/stat-tile";
import { StrapiError } from "@/lib/strapi-error";

/**
 * WD03 rehearsal in a test: the CMS goes down mid-render (every read
 * rejects with a 502). Each migrated page still renders: the CMS-down
 * banner is there, no "nothing here yet" empty state claims the section is
 * empty, and every count it shows is unknown ("–"), never 0.
 *
 * The reads are mocked to fail; the loaders, the rules and the pages are
 * real. The pages' returned element trees are searched, not rendered.
 */
const outage = () => Promise.reject(new StrapiError(502, "Bad Gateway", ""));

vi.mock("@/lib/strapi", async () => {
  const polls = await import("@/lib/api/polls");
  return {
    api: {
      departments: { list: outage },
      teams: { list: outage },
      announcements: { list: outage, requiringAck: outage },
      events: { upcoming: outage, past: outage, window: outage, rsvpSummaries: outage },
      polls: { list: outage, resultsMany: outage },
      quickLinks: { list: outage },
      kudos: { list: outage },
      celebrations: outage,
    },
    pollRef: polls.pollRef,
    findPollResults: polls.findPollResults,
  };
});
vi.mock("@/lib/acknowledgements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/acknowledgements")>()),
  fetchMyAnnouncementAcks: outage,
  fetchAnnouncementAckIndex: outage,
}));
vi.mock("@/lib/api/announcements", () => ({ listAckReportAnnouncements: outage }));
vi.mock("@/lib/api/analytics", () => ({
  countPage: outage,
  reactionsPage: outage,
  unreadNotificationsPage: outage,
  recentComments: outage,
  searchSummary: outage,
}));
vi.mock("@/lib/users", () => ({ fetchAllUsers: outage }));
vi.mock("@/lib/teams", () => ({ fetchAllTeams: outage }));
vi.mock("@/lib/training", () => ({
  fetchCourses: outage,
  fetchMyProgress: outage,
  fetchCourseBySlug: outage,
}));
vi.mock("@/lib/session", () => ({ getSession: async () => ({ user: { id: 7, name: "Ada" } }) }));
// admin_role passes every gate: the /manage reports and every dashboard section.
vi.mock("@/lib/viewer", () => ({
  getViewer: async () => ({ id: 7, displayName: "Ada", role: "admin_role", department: null }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
  getLocale: async () => "en",
  getFormatter: async () => ({ dateTime: () => "" }),
}));

const pages: Record<string, () => Promise<ReactNode>> = {
  "/": (await import("./page")).default,
  "/announcements": (await import("./announcements/page")).default,
  "/events": () =>
    import("./events/page").then((page) => page.default({ searchParams: Promise.resolve({}) })),
  "/events?view=month": () =>
    import("./events/page").then((page) =>
      page.default({ searchParams: Promise.resolve({ view: "month" }) }),
    ),
  "/polls": (await import("./polls/page")).default,
  "/kudos": (await import("./kudos/page")).default,
  "/training": (await import("./training/page")).default,
  "/manage/acknowledgements": (await import("./manage/acknowledgements/page")).default,
  "/manage/analytics": (await import("./manage/analytics/page")).default,
};

/** Every element in a returned page tree (through children and props.value). */
function elements(node: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [
    { type: node.type, props: node.props },
    ...elements(node.props.children as ReactNode),
    ...elements(node.props.value as ReactNode),
  ];
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the CMS is down", () => {
  it.each(Object.entries(pages))(
    "%s shows the banner, no empty state, no 0",
    async (_path, page) => {
      const tree = elements(await page());
      expect(tree.some((el) => el.type === FetchErrorBanner)).toBe(true);
      expect(tree.some((el) => el.type === EmptyState || el.type === PollsEmptyState)).toBe(false);
      for (const count of tree.filter((el) => el.type === StatCount)) {
        expect(count.props.count).toEqual({ value: null, truncated: false });
      }
    },
  );

  it("the dashboard's news widget keeps its heading and link, without the empty state", async () => {
    const news = elements(await pages["/"]!()).find((el) => el.type === LatestNews);
    expect(news?.props.news).toEqual({ featured: null, rest: [], failed: true });
    const widget = elements(await LatestNews(news!.props as Parameters<typeof LatestNews>[0]));
    expect(widget.some((el) => el.props.href === "/announcements")).toBe(true);
    expect(widget.some((el) => el.type === EmptyState)).toBe(false);
  });

  it("the dashboard and analytics show their tiles as unknown", async () => {
    for (const path of ["/", "/manage/analytics"]) {
      const counts = elements(await pages[path]!()).filter((el) => el.type === StatCount);
      expect(counts.length, path).toBeGreaterThanOrEqual(path === "/" ? 4 : 9);
    }
  });
});
