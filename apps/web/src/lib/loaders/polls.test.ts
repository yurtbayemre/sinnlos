import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrapiError } from "@/lib/strapi-error";

/**
 * WD03: the /polls view-model from mocked reads (the list and the batched
 * results); pollRef/findPollResults and the closing rule are the real
 * modules. Snapshots per scenario: success, partial failure, truncation,
 * CMS down.
 */
const listMock = vi.fn<() => Promise<unknown>>();
const resultsMock = vi.fn<(refs: readonly (string | number)[]) => Promise<unknown>>();

vi.mock("@/lib/strapi", async () => {
  const polls = await import("@/lib/api/polls");
  return {
    api: {
      polls: {
        list: () => listMock(),
        resultsMany: (refs: readonly (string | number)[]) => resultsMock(refs),
      },
    },
    pollRef: polls.pollRef,
    findPollResults: polls.findPollResults,
  };
});

const { loadPolls } = await import("./polls");

const NOW = new Date("2026-09-28T10:00:00.000Z");
/** A Strapi 5 documentId (24 characters, lowercase letter first). */
const docId = (id: number) => `poll${String(id).padStart(20, "0")}`;
const poll = (id: number, closesAt: string | null) => ({
  id,
  documentId: docId(id),
  question: `Question ${id}?`,
  options: ["Yes", "No"],
  closesAt,
});
const resultsOf = (id: number, closesAt: string | null) => ({
  poll: { ...poll(id, closesAt) },
  counts: [id, 1],
  total: id + 1,
  myVoteIndex: null,
  canVote: true,
});
const LIST = {
  data: [poll(1, null), poll(2, "2026-09-27T12:00:00.000Z"), poll(3, "2026-10-01T12:00:00.000Z")],
  meta: { pagination: { page: 1, pageSize: 20, pageCount: 1, total: 3 } },
};
/** The cms left poll 3 out (retargeted after the list read). */
const RESULTS = [resultsOf(1, null), resultsOf(2, "2026-09-27T12:00:00.000Z")];
const outage = () => new StrapiError(502, "Bad Gateway", "");

beforeEach(() => {
  listMock.mockReset().mockResolvedValue(LIST);
  resultsMock.mockReset().mockResolvedValue(RESULTS);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadPolls", () => {
  it("success: active and closed cards by documentId; a poll the cms left out has none", async () => {
    const view = await loadPolls(NOW);
    expect(resultsMock).toHaveBeenCalledWith([docId(1), docId(2), docId(3)]);
    expect(view.active.map((e) => e.ref)).toEqual([docId(1)]);
    expect(view.closed.map((e) => e.ref)).toEqual([docId(2)]);
    expect(view).toMatchSnapshot();
  });

  it("partial failure: results down, no card, the banner, no empty state", async () => {
    resultsMock.mockRejectedValue(outage());
    const view = await loadPolls(NOW);
    expect(view).toMatchSnapshot();
    expect(view).toMatchObject({ active: [], closed: [], empty: false, failed: true });
  });

  it("truncated: the list holds the newest 20 of more", async () => {
    listMock.mockResolvedValue({
      ...LIST,
      meta: { pagination: { ...LIST.meta.pagination, total: 25 } },
    });
    const view = await loadPolls(NOW);
    expect(view.truncated).toBe(true);
    expect(view).toMatchSnapshot();
  });

  it("CMS down: no results request, the banner, no empty state", async () => {
    listMock.mockRejectedValue(outage());
    const view = await loadPolls(NOW);
    expect(resultsMock).not.toHaveBeenCalled();
    expect(view).toMatchSnapshot();
    expect(view).toMatchObject({ empty: false, failed: true });
  });

  it("no poll at all, or none the caller may still see, is the empty state", async () => {
    listMock.mockResolvedValue({ data: [], meta: { pagination: { total: 0 } } });
    await expect(loadPolls(NOW)).resolves.toMatchObject({ empty: true, failed: false });
    expect(resultsMock).not.toHaveBeenCalled();
    listMock.mockResolvedValue(LIST);
    resultsMock.mockResolvedValue([]);
    await expect(loadPolls(NOW)).resolves.toMatchObject({ empty: true, failed: false });
  });

  it("closes a poll exactly at closesAt", async () => {
    const view = await loadPolls(new Date("2026-09-27T12:00:00.000Z"));
    expect(view.closed.map((e) => e.ref)).toEqual([docId(2)]);
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
    resultsMock.mockRejectedValue(expired);
    await expect(loadPolls(NOW)).rejects.toBe(expired);
  });
});
