import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrapiError } from "@/lib/strapi-error";

/**
 * WD03: the /manage/acknowledgements view-model from mocked reads (the
 * mandatory announcements, the directory, the team roster, the ack index);
 * the report rules (lib/ack-report.ts, the domain targeting) are real.
 * Snapshots per scenario: success, partial failure, truncation, CMS down.
 */
const reads = {
  announcements: vi.fn<() => Promise<unknown>>(),
  users: vi.fn<(params: string) => Promise<unknown>>(),
  teams: vi.fn<() => Promise<unknown>>(),
  acks: vi.fn<(documentIds: string[]) => Promise<unknown>>(),
};

vi.mock("@/lib/api/announcements", () => ({
  listAckReportAnnouncements: () => reads.announcements(),
}));
vi.mock("@/lib/users", () => ({ fetchAllUsers: (params: string) => reads.users(params) }));
vi.mock("@/lib/teams", () => ({ fetchAllTeams: () => reads.teams() }));
vi.mock("@/lib/acknowledgements", () => ({
  fetchAnnouncementAckIndex: (documentIds: string[]) => reads.acks(documentIds),
}));

const { loadAckReport, ACK_REPORT_USER_QUERY } = await import("./ack-report");

const member = { id: 2, type: "member" };
const user = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  username: `user${id}`,
  displayName: `User ${id}`,
  role: member,
  department: { id: 10, name: "Engineering" },
  ...extra,
});
const ANNOUNCEMENTS = {
  data: [
    // Company-wide.
    {
      id: 1,
      documentId: "ann-1",
      title: "Code of conduct",
      requiresAck: true,
      ackDeadline: "2026-10-31",
    },
    // Engineering only.
    {
      id: 2,
      documentId: "ann-2",
      title: "On-call rota",
      requiresAck: true,
      department: { id: 10, name: "Engineering" },
    },
    // One team, and the role list (names missing: the type, else #id).
    {
      id: 3,
      documentId: "ann-3",
      title: "Release freeze",
      requiresAck: true,
      team: { id: 30 },
      audienceRoles: [{ id: 2, type: "member" }, { id: 9 }],
    },
    // Not mandatory (DEMO_MODE answers unfiltered): left out.
    { id: 4, documentId: "ann-4", title: "Lunch", requiresAck: false },
  ],
  truncated: false,
};
const USERS = {
  users: [
    user(1),
    user(2, { displayName: "" }),
    user(3, { department: { id: 11, name: "Sales" } }),
    // Never counted: blocked, a guest.
    user(4, { blocked: true }),
    user(5, { role: { id: 6, type: "guest" } }),
  ],
  truncated: false,
};
const TEAMS = { teams: [{ id: 30, lead: { id: 1 }, members: [{ id: 3 }] }], truncated: false };
const ACKS = {
  index: new Map([
    ["ann-1", new Set([1, 3, 4])],
    ["ann-2", new Set([1])],
    ["ann-3", new Set<number>()],
  ]),
  truncated: false,
};
const outage = () => new StrapiError(502, "Bad Gateway", "");

beforeEach(() => {
  reads.announcements.mockReset().mockResolvedValue(ANNOUNCEMENTS);
  reads.users.mockReset().mockResolvedValue(USERS);
  reads.teams.mockReset().mockResolvedValue(TEAMS);
  reads.acks.mockReset().mockResolvedValue(ACKS);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadAckReport", () => {
  it("success: one row per mandatory announcement, rates over the eligible audience", async () => {
    const view = await loadAckReport();
    expect(reads.users).toHaveBeenCalledWith(ACK_REPORT_USER_QUERY);
    expect(reads.acks).toHaveBeenCalledWith(["ann-1", "ann-2", "ann-3"]);
    expect(view.rows.map((r) => [r.id, r.ackedCount, r.targetTotal, r.pct])).toEqual([
      [1, 2, 3, 67],
      [2, 1, 2, 50],
      [3, 0, 2, 0],
    ]);
    // An empty display name falls back to the username.
    expect(view.rows[1]!.openUsers).toEqual([{ id: 2, name: "user2" }]);
    expect(view.rows[2]!.audience).toEqual({
      department: null,
      team: "#30",
      roles: ["member", "#9"],
    });
    expect(view).toMatchSnapshot();
  });

  it("partial failure: no team roster leaves only the team-scoped row unknown", async () => {
    reads.teams.mockRejectedValue(outage());
    const view = await loadAckReport();
    expect(view.failed).toBe(true);
    expect(view.rows.map((r) => r.targetUnknown)).toEqual([false, false, true]);
    expect(view).toMatchSnapshot();
  });

  it("partial failure: no directory leaves every row unknown, never 0 of 0", async () => {
    reads.users.mockRejectedValue(outage());
    const view = await loadAckReport();
    expect(view.rows.every((r) => r.targetUnknown)).toBe(true);
    expect(view.failed).toBe(true);
  });

  it("truncated: any input walk cut at its cap marks the report incomplete", async () => {
    reads.acks.mockResolvedValue({ ...ACKS, truncated: true });
    const view = await loadAckReport();
    expect(view).toMatchObject({ truncated: true, failed: false });
    expect(view).toMatchSnapshot();
    reads.acks.mockResolvedValue(ACKS);
    reads.users.mockResolvedValue({ ...USERS, truncated: true });
    const directoryCut = await loadAckReport();
    expect(directoryCut.truncated).toBe(true);
    expect(directoryCut.rows.every((r) => r.targetUnknown)).toBe(true);
  });

  it("CMS down: the banner, no rows and no empty state", async () => {
    for (const read of Object.values(reads)) read.mockRejectedValue(outage());
    const view = await loadAckReport();
    expect(view).toMatchSnapshot();
    expect(view).toMatchObject({ rows: [], empty: false, failed: true });
  });

  it("no mandatory announcement is the empty state", async () => {
    reads.announcements.mockResolvedValue({ data: [], truncated: false });
    await expect(loadAckReport()).resolves.toMatchObject({ rows: [], empty: true, failed: false });
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
    reads.acks.mockRejectedValue(expired);
    await expect(loadAckReport()).rejects.toBe(expired);
  });
});
