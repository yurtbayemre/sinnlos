import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrapiError } from "@/lib/strapi-error";

/**
 * WD03: the /kudos view-model from mocked reads (the wall, the
 * celebrations, the picker's directory walk); the picker DTO and
 * displayNameOf are the real modules. Snapshots per scenario: success,
 * partial failure, truncation, CMS down.
 */
const reads = {
  kudos: vi.fn<() => Promise<unknown>>(),
  celebrations: vi.fn<() => Promise<unknown>>(),
  users: vi.fn<(params: string) => Promise<unknown>>(),
};

vi.mock("@/lib/strapi", () => ({
  api: { kudos: { list: () => reads.kudos() }, celebrations: () => reads.celebrations() },
}));
vi.mock("@/lib/users", () => ({ fetchAllUsers: (params: string) => reads.users(params) }));

const { loadKudos } = await import("./kudos");

const user = (id: number, displayName: string, extra: Record<string, unknown> = {}) => ({
  id,
  username: `user${id}`,
  displayName,
  email: `user${id}@example.test`,
  ...extra,
});
const KUDOS = {
  data: [
    {
      id: 1,
      message: "Thanks for the release!",
      value: "teamwork",
      from: user(2, "Grace Hopper"),
      to: user(3, ""),
      createdAt: "2026-09-27T09:00:00.000Z",
    },
    { id: 2, message: "New value", value: "kindness", from: null, to: user(4, "Alan Turing") },
  ],
  meta: { pagination: { page: 1, pageSize: 30, pageCount: 1, total: 2 } },
};
const CELEBRATIONS = {
  data: [
    { user: user(5, "Ada Lovelace"), type: "birthday", date: "2026-09-29", daysUntil: 1 },
    { user: user(6, ""), type: "work-anniversary", years: 5, daysUntil: 0 },
  ],
};
const PEOPLE = {
  users: [
    user(2, "Grace Hopper", { jobTitle: "CTO", blocked: false }),
    user(7, "Blocked", { blocked: true }),
    user(1, "Me"),
  ],
  truncated: false,
};
const outage = () => new StrapiError(502, "Bad Gateway", "");

beforeEach(() => {
  reads.kudos.mockReset().mockResolvedValue(KUDOS);
  reads.celebrations.mockReset().mockResolvedValue(CELEBRATIONS);
  reads.users.mockReset().mockResolvedValue(PEOPLE);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadKudos", () => {
  it("success: the wall with resolved names, celebrations, the picker without self or blocked", async () => {
    const view = await loadKudos("member", 1);
    expect(view.kudos.map((k) => [k.fromName, k.toName])).toEqual([
      ["Grace Hopper", "user3"],
      [null, "Alan Turing"],
    ]);
    expect(view.celebrations.map((c) => c.name)).toEqual(["Ada Lovelace", "user6"]);
    expect(view.recipients.map((r) => r.id)).toEqual([2]);
    expect(reads.users.mock.calls[0]![0]).toContain("filters[id][$ne]=1");
    expect(view).toMatchSnapshot();
  });

  it("partial failure: celebrations down show the banner and keep the wall", async () => {
    reads.celebrations.mockRejectedValue(outage());
    const view = await loadKudos("member", 1);
    expect(view).toMatchObject({ failed: true, celebrations: [], empty: false });
    expect(view.kudos).toHaveLength(2);
    expect(view).toMatchSnapshot();
  });

  it("partial failure: the picker's directory alone stays out of the banner", async () => {
    reads.users.mockRejectedValue(outage());
    const view = await loadKudos("member", 1);
    expect(view).toMatchObject({ failed: false, recipientsFailed: true, recipients: [] });
  });

  it("truncated: a directory cut at its cap is flagged", async () => {
    reads.users.mockResolvedValue({ ...PEOPLE, truncated: true });
    const view = await loadKudos("member", 1);
    expect(view.truncated).toBe(true);
    expect(view).toMatchSnapshot();
  });

  it("CMS down: the banner, no wall and no empty state", async () => {
    for (const read of Object.values(reads)) read.mockRejectedValue(outage());
    const view = await loadKudos("member", 1);
    expect(view).toMatchSnapshot();
    expect(view).toMatchObject({ failed: true, empty: false, kudos: [], celebrations: [] });
  });

  it("an empty wall is the empty state", async () => {
    reads.kudos.mockResolvedValue({ data: [], meta: { pagination: { total: 0 } } });
    await expect(loadKudos("member", 1)).resolves.toMatchObject({ empty: true, failed: false });
  });

  it("the `authenticated` fallback reads kudos but not the celebrations", async () => {
    const view = await loadKudos("authenticated", 1);
    expect(reads.celebrations).not.toHaveBeenCalled();
    expect(reads.kudos).toHaveBeenCalled();
    expect(view).toMatchObject({ failed: false, celebrations: [] });
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
    reads.users.mockRejectedValue(expired);
    await expect(loadKudos("member", 1)).rejects.toBe(expired);
  });
});
