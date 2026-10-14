import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrapiError } from "@/lib/strapi-error";

/**
 * The /manage view models (WD03; decision 06 §L1, §L4): a cms outage is the
 * `failed` flag (the banner), never an empty list or a zero count; a hidden
 * or missing item is `notFound` (the page answers 404 and says nothing
 * else); URL filters are checked before any request; the sign-in redirect
 * of an expired session is never swallowed. strapi() is mocked.
 */
const strapiMock = vi.fn();
vi.mock("@/lib/strapi/client", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));

const { loadManageList, parseListFilters, statusTabs } = await import("./list");
const { loadEditable, loadEventYesCount } = await import("./editor");
const { loadTargetingOptions } = await import("./options");
const { loadManageLanding, countedFilters, countHref } = await import("./landing");

const DOC = "annc00000000000000000001";
const outage = () => new StrapiError(502, "Bad Gateway", "");
const refusal = (status: number) => new StrapiError(status, "Error", "");
const page = (rows: unknown[], total = rows.length) => ({
  data: rows,
  meta: { pagination: { page: 1, pageSize: 25, pageCount: Math.ceil(total / 25), total } },
});
const row = (n: number) => ({
  documentId: `annc${String(n).padStart(20, "0")}`,
  label: `Item ${n}`,
  status: "draft",
  publishedAt: null,
  updatedAt: "2026-10-12T08:00:00.000Z",
  version: "1",
  authorName: "Ada",
  needsRetarget: false,
});

function signInRedirect(): unknown {
  try {
    redirect("/sign-in?expired=1");
  } catch (error) {
    return error;
  }
  throw new Error("redirect() did not throw");
}

beforeEach(() => {
  strapiMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("list filters from the URL", () => {
  it("keep only what the area and the viewer can use", () => {
    expect(
      parseListFilters(
        "announcements",
        { status: "scheduled", q: "  canteen ", page: "2", owner: "department" },
        { ownerFilter: true },
      ),
    ).toEqual({ status: "scheduled", q: "canteen", page: 2, owner: "department" });
    expect(
      parseListFilters(
        "polls",
        { status: "draft", page: "-1", owner: "moderators" },
        { ownerFilter: false },
      ),
    ).toEqual({ status: null, q: "", page: 1, owner: null });
    expect(
      parseListFilters(
        "events",
        { status: ["failed", "draft"], page: "1.5" },
        { ownerFilter: false },
      ),
    ).toEqual({ status: "failed", q: "", page: 1, owner: null });
  });

  it("offer status tabs to the draft areas only, schedule tabs where they schedule", () => {
    expect(statusTabs("polls")).toEqual([]);
    expect(statusTabs("events")).toEqual([
      "all",
      "draft",
      "published",
      "modified",
      "scheduled",
      "failed",
    ]);
    expect(countedFilters("polls")).toEqual(["published"]);
    expect(countedFilters("quickLinks")).toEqual(["draft", "published", "scheduled", "failed"]);
    expect(countedFilters("wiki")).toEqual(["draft", "published", "scheduled", "failed"]);
  });

  it("a count opens its list's status tab; polls and the wiki have none (#78)", () => {
    expect(countHref("announcements", "published")).toBe("/manage/announcements?status=published");
    expect(countHref("quickLinks", "draft")).toBe("/manage/quick-links?status=draft");
    expect(countHref("documents", "failed")).toBe("/manage/documents?status=failed");
    // Every count with a tab gets one, and the list keeps the filter it names.
    for (const area of ["announcements", "events", "quickLinks", "documents"] as const) {
      for (const status of countedFilters(area)) {
        const href = countHref(area, status);
        const params = Object.fromEntries(new URL(String(href), "http://x").searchParams);
        expect(parseListFilters(area, params, { ownerFilter: false }).status).toBe(status);
      }
    }
    expect(countHref("polls", "published")).toBeNull();
    expect(countHref("wiki", "published")).toBeNull();
  });
});

describe("loadManageList", () => {
  const filters = { status: null, q: "", page: 1, owner: null };

  it("one page of rows with the cms's pagination", async () => {
    strapiMock.mockResolvedValue(page([row(1), row(2)], 27));
    const view = await loadManageList("announcements", { ...filters, status: "draft" });
    expect(strapiMock).toHaveBeenCalledWith("/api/announcements/authoring?status=draft");
    expect(view).toMatchObject({ empty: false, failed: false });
    expect(view.rows).toHaveLength(2);
    expect(view.pagination.total).toBe(27);
  });

  it("an empty answer is empty; an outage is failed, never empty", async () => {
    strapiMock.mockResolvedValueOnce(page([]));
    expect(await loadManageList("events", filters)).toMatchObject({ empty: true, failed: false });
    strapiMock.mockRejectedValueOnce(outage());
    const failed = await loadManageList("events", filters);
    expect(failed).toMatchObject({ empty: false, failed: true, rows: [] });
  });

  it("lets the sign-in redirect through", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValue(redirectError);
    await expect(loadManageList("polls", filters)).rejects.toBe(redirectError);
  });
});

describe("loadEditable", () => {
  const editable = {
    documentId: DOC,
    version: "4",
    status: "draft",
    publishedAt: null,
    updatedAt: null,
    roleClass: "moderator",
  };

  it("answers the draft in the write shape", async () => {
    strapiMock.mockResolvedValue({ data: editable });
    await expect(loadEditable("announcements", DOC)).resolves.toEqual({ state: "ok", editable });
    expect(strapiMock).toHaveBeenCalledWith(`/api/announcements/${DOC}/editable`);
  });

  it("is notFound for a malformed id (no request), a 404 and a 403 alike", async () => {
    await expect(loadEditable("events", "not-a-document-id")).resolves.toEqual({
      state: "notFound",
    });
    expect(strapiMock).not.toHaveBeenCalled();
    for (const status of [404, 403]) {
      strapiMock.mockRejectedValueOnce(refusal(status));
      await expect(loadEditable("events", DOC)).resolves.toEqual({ state: "notFound" });
    }
  });

  it("is failed for an outage or an unexpected answer, and lets the redirect through", async () => {
    strapiMock.mockRejectedValueOnce(outage());
    await expect(loadEditable("polls", DOC)).resolves.toEqual({ state: "failed" });
    strapiMock.mockResolvedValueOnce({
      data: { ...editable, documentId: "another0000000000000000" },
    });
    await expect(loadEditable("polls", DOC)).resolves.toEqual({ state: "failed" });
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValueOnce(redirectError);
    await expect(loadEditable("polls", DOC)).rejects.toBe(redirectError);
  });

  it("reads a published event's yes count, unknown when it cannot", async () => {
    strapiMock.mockResolvedValueOnce({
      data: [{ targetDocumentId: DOC, yesCount: 12, maybeCount: 0, noCount: 1, yesNames: [] }],
    });
    await expect(loadEventYesCount(DOC)).resolves.toBe(12);
    strapiMock.mockRejectedValueOnce(outage());
    await expect(loadEventYesCount(DOC)).resolves.toBeNull();
  });
});

describe("loadTargetingOptions", () => {
  it("departments and teams by documentId; a department author's teams of their department only", async () => {
    strapiMock.mockImplementation(async (path: string) =>
      path.startsWith("/api/departments")
        ? page([{ id: 1, documentId: "dept1", name: "Engineering" }])
        : page([
            { id: 1, documentId: "team1", name: "Platform", department: { documentId: "dept1" } },
            { id: 2, documentId: "team2", name: "Field", department: { documentId: "dept2" } },
          ]),
    );
    const all = await loadTargetingOptions({ departments: true, teams: true });
    expect(all).toEqual({
      departments: [{ documentId: "dept1", name: "Engineering" }],
      teams: [
        { documentId: "team1", name: "Platform", department: "dept1" },
        { documentId: "team2", name: "Field", department: "dept2" },
      ],
      failed: false,
      truncated: false,
    });
    const own = await loadTargetingOptions({ departments: false, teams: true, teamsOf: "dept1" });
    expect(own.departments).toEqual([]);
    expect(own.teams.map((team) => team.documentId)).toEqual(["team1"]);
  });

  it("is failed when a list could not be read (the form locks the targeting)", async () => {
    strapiMock.mockRejectedValue(outage());
    await expect(loadTargetingOptions({ departments: true, teams: false })).resolves.toMatchObject({
      departments: [],
      failed: true,
    });
  });
});

describe("loadManageLanding", () => {
  it("counts drafts, published, scheduled and failed per area; a failed count is unknown, never 0", async () => {
    strapiMock.mockImplementation(async (path: string) => {
      if (path.includes("status=failed")) throw outage();
      if (path.includes("status=published")) return page([], path.includes("/polls/") ? 4 : 7);
      return page([], path.includes("status=draft") ? 3 : 1);
    });
    const view = await loadManageLanding(["announcements", "polls"]);
    expect(view.failed).toBe(true);
    expect(view.tiles).toEqual([
      {
        area: "announcements",
        counts: {
          draft: { value: 3, truncated: false },
          published: { value: 7, truncated: false },
          scheduled: { value: 1, truncated: false },
          failed: { value: null, truncated: false },
        },
      },
      { area: "polls", counts: { published: { value: 4, truncated: false } } },
    ]);
    // The published count is the list's own `published` filter (#78).
    expect(strapiMock).toHaveBeenCalledWith("/api/announcements/authoring?status=published");
    expect(strapiMock).toHaveBeenCalledWith("/api/polls/authoring?status=published");
  });
});
