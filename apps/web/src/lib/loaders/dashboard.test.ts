import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrapiError } from "@/lib/strapi-error";

/**
 * WD03: the dashboard view-model and the streamed people count from mocked
 * reads. Snapshots per scenario: success, partial failure, truncation, CMS
 * down. A failed count is null ("–" on the tile), never 0.
 */
const reads = {
  departments: vi.fn<() => Promise<unknown>>(),
  teams: vi.fn<() => Promise<unknown>>(),
  announcements: vi.fn<() => Promise<unknown>>(),
  events: vi.fn<(from: string, now: string) => Promise<unknown>>(),
  quickLinks: vi.fn<() => Promise<unknown>>(),
  users: vi.fn<(params: string) => Promise<unknown>>(),
};

vi.mock("@/lib/strapi", () => ({
  api: {
    departments: { list: () => reads.departments() },
    teams: { list: () => reads.teams() },
    announcements: { list: () => reads.announcements() },
    events: { upcoming: (from: string, now: string) => reads.events(from, now) },
    quickLinks: { list: () => reads.quickLinks() },
  },
}));
vi.mock("@/lib/users", () => ({ fetchAllUsers: (params: string) => reads.users(params) }));

const { loadDashboard, dashboardSections } = await import("./dashboard");
const { loadPeopleCount } = await import("./people-count");

/** Monday 2026-09-28, 10:00 UTC = 12:00 in Berlin. */
const NOW = new Date("2026-09-28T10:00:00.000Z");
const ZONE = "Europe/Berlin";
const walk = (n: number, truncated = false) => ({
  data: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Row ${i + 1}` })),
  truncated,
});
const feed = (n: number, total: number) => ({
  data: Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    documentId: `doc-${i + 1}`,
    title: `Item ${i + 1}`,
    pinned: i === 2,
  })),
  meta: { pagination: { page: 1, pageSize: n, pageCount: 1, total } },
});
const outage = () => new StrapiError(503, "Service Unavailable", "");

beforeEach(() => {
  reads.departments.mockReset().mockResolvedValue(walk(3));
  reads.teams.mockReset().mockResolvedValue(walk(5));
  reads.announcements.mockReset().mockResolvedValue(feed(6, 42));
  reads.events.mockReset().mockResolvedValue(feed(2, 17));
  reads.quickLinks.mockReset().mockResolvedValue({
    data: [{ id: 1, label: "Payroll", url: "https://pay.example.test", category: "hr" }],
    truncated: false,
  });
  reads.users.mockReset().mockResolvedValue({ users: [{ id: 1 }, { id: 2 }], truncated: false });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadDashboard", () => {
  it("success: walk counts from the rows, feed counts from their totals", async () => {
    const view = await loadDashboard("member", NOW, ZONE);
    expect(view.counts).toEqual({
      departments: { value: 3, truncated: false },
      teams: { value: 5, truncated: false },
      events: { value: 17, truncated: false },
      news: { value: 42, truncated: false },
    });
    // Upcoming from the first instant of today in APP_TIME_ZONE.
    expect(reads.events).toHaveBeenCalledWith(
      "2026-09-27T22:00:00.000Z",
      "2026-09-28T10:00:00.000Z",
    );
    expect(view.latestNews?.featured?.id).toBe(3);
    expect(view.latestNews?.rest.map((n) => n.id)).toEqual([1, 2, 4, 5]);
    expect(view).toMatchSnapshot();
  });

  it("partial failure: the failed tile is unknown (null), not 0; the rest stays", async () => {
    reads.teams.mockRejectedValue(outage());
    reads.events.mockRejectedValue(outage());
    const view = await loadDashboard("member", NOW, ZONE);
    expect(view.failed).toBe(true);
    expect(view.counts.teams).toEqual({ value: null, truncated: false });
    expect(view.counts.events).toEqual({ value: null, truncated: false });
    expect(view.counts.departments).toEqual({ value: 3, truncated: false });
    expect(view).toMatchSnapshot();
  });

  it("truncated: a walk cut at its cap is a lower bound (N+)", async () => {
    reads.departments.mockResolvedValue(walk(4, true));
    const view = await loadDashboard("member", NOW, ZONE);
    expect(view.counts.departments).toEqual({ value: 4, truncated: true });
    expect(view.truncated).toBe(true);
    expect(view.failed).toBe(false);
    expect(view).toMatchSnapshot();
  });

  it("CMS down: every count unknown, no links, no news, the banner", async () => {
    for (const read of Object.values(reads)) read.mockRejectedValue(outage());
    const view = await loadDashboard("member", NOW, ZONE);
    expect(view).toMatchSnapshot();
    expect(view.failed).toBe(true);
    expect(Object.values(view.counts).every((c) => c?.value === null)).toBe(true);
    // The heading and its link stay, no "no announcements yet" under the banner.
    expect(view.latestNews).toEqual({ featured: null, rest: [], failed: true });
  });

  it("a guest reads neither org, news nor kudos and gets no tile for them", async () => {
    const view = await loadDashboard("guest", NOW, ZONE);
    expect(reads.departments).not.toHaveBeenCalled();
    expect(reads.teams).not.toHaveBeenCalled();
    expect(reads.announcements).not.toHaveBeenCalled();
    expect(view.counts).toMatchObject({ departments: null, teams: null, news: null });
    expect(view.latestNews).toBeNull();
    expect(view.sections).toEqual({
      org: false,
      news: false,
      acks: false,
      kudos: false,
      training: false,
      events: true,
    });
  });

  it("an unreadable role (null) reads every section: the CMS decides", () => {
    expect(dashboardSections(null)).toEqual({
      org: true,
      news: true,
      acks: true,
      kudos: true,
      training: true,
      events: true,
    });
  });

  it("switched-off modules and features are neither read nor shown, for any role (v0.28)", async () => {
    const off = new Set(["events", "kudos", "training", "read-confirmations"] as const);
    expect(dashboardSections("admin_role", off)).toEqual({
      org: true,
      news: true,
      acks: false,
      kudos: false,
      training: false,
      events: false,
    });
    vi.stubEnv("FEATURES_OFF", "events");
    try {
      const view = await loadDashboard("member", NOW, ZONE);
      expect(reads.events).not.toHaveBeenCalled();
      expect(view.counts.events).toBeNull();
      expect(view.failed).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a feed without pagination meta counts its rows (DEMO_MODE fixtures)", async () => {
    reads.events.mockResolvedValue({ data: [{ id: 1 }, { id: 2 }] });
    const view = await loadDashboard("member", NOW, ZONE);
    expect(view.counts.events).toEqual({ value: 2, truncated: false });
  });
});

describe("loadPeopleCount (dashboard and analytics)", () => {
  it("counts the id-only directory walk", async () => {
    await expect(loadPeopleCount("test")).resolves.toEqual({ value: 2, truncated: false });
    expect(reads.users).toHaveBeenCalledWith("fields[0]=id");
  });

  it("is unknown when the walk fails, a lower bound when it hit the cap", async () => {
    reads.users.mockRejectedValueOnce(outage());
    await expect(loadPeopleCount("test")).resolves.toEqual({ value: null, truncated: false });
    reads.users.mockResolvedValueOnce({ users: [{ id: 1 }], truncated: true });
    await expect(loadPeopleCount("test")).resolves.toEqual({ value: 1, truncated: true });
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
    reads.quickLinks.mockRejectedValue(expired);
    await expect(loadDashboard("member", NOW, ZONE)).rejects.toBe(expired);
    reads.users.mockRejectedValue(expired);
    await expect(loadPeopleCount("test")).rejects.toBe(expired);
  });
});
