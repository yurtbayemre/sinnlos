import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnouncementListItem } from "@/lib/api/announcements";
import { StrapiError } from "@/lib/strapi-error";
import type { Acknowledgement } from "@/lib/types";

/**
 * WD03: the /announcements view-model and the dashboard's open-ack count
 * from mocked reads (the api facade and the receipts walk); computeOpenAcks
 * is the real rule. Snapshots pin the view-model per scenario: success,
 * partial failure, truncation, CMS down.
 */
const feedMock = vi.fn<() => Promise<unknown>>();
const mandatoryMock = vi.fn<() => Promise<unknown>>();
const receiptsMock = vi.fn<() => Promise<unknown>>();

vi.mock("@/lib/strapi", () => ({
  api: {
    announcements: { list: () => feedMock(), requiringAck: () => mandatoryMock() },
  },
}));
vi.mock("@/lib/acknowledgements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/acknowledgements")>()),
  fetchMyAnnouncementAcks: () => receiptsMock(),
}));

const { loadAnnouncements, loadOpenAckCount, pickLatestNews } = await import("./announcements");

const author = { id: 9, username: "grace", displayName: "Grace Hopper", jobTitle: "CTO" };
const post = (id: number, extra: Partial<AnnouncementListItem> = {}): AnnouncementListItem => ({
  id,
  documentId: `ann-${id}`,
  title: `Post ${id}`,
  body: `Body ${id}`,
  pinned: false,
  createdAt: `2026-10-0${id}T08:00:00.000Z`,
  author,
  ...extra,
});
const receipt = (documentId: string, acknowledgedAt: string | null, id = 1): Acknowledgement => ({
  id,
  targetType: "announcement",
  targetDocumentId: documentId,
  acknowledgedAt,
  createdAt: "2026-10-05T09:00:00.000Z",
});

/** The feed: newest 20, pinned first (pinned:desc,createdAt:desc). */
const FEED = {
  data: [
    post(5, { pinned: true }),
    post(4, { requiresAck: true, ackDeadline: "2026-10-20" }),
    post(3),
    post(2, { requiresAck: true }),
  ],
  meta: { pagination: { page: 1, pageSize: 20, pageCount: 1, total: 4 } },
};
/** Every mandatory announcement: two in the feed, one older (not in the top 20). */
const MANDATORY = {
  data: [
    post(4, { requiresAck: true, author: null }),
    post(2, { requiresAck: true }),
    post(1, { requiresAck: true, title: "Old but open" }),
  ],
  truncated: false,
};
/** Post 2 confirmed (twice: the later receipt wins), post 4 and post 1 open. */
const RECEIPTS = {
  acks: [receipt("ann-2", null, 1), receipt("ann-2", "2026-10-06T10:00:00.000Z", 2)],
  truncated: false,
};

const outage = () => new StrapiError(502, "Bad Gateway", "");

beforeEach(() => {
  feedMock.mockReset().mockResolvedValue(FEED);
  mandatoryMock.mockReset().mockResolvedValue(MANDATORY);
  receiptsMock.mockReset().mockResolvedValue(RECEIPTS);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadAnnouncements", () => {
  it("success: open confirmations on top, then pinned and recent, receipts per card", async () => {
    const view = await loadAnnouncements("member");
    expect(view.failed).toBe(false);
    expect(view.truncated).toBe(false);
    // The open post 4 is taken from the feed (with its author), post 1 from the walk.
    expect(view.openAcks.map((e) => e.item.id)).toEqual([4, 1]);
    expect(view.openAcks[0]!.item.author).toEqual(author);
    expect(view.pinned.map((e) => e.item.id)).toEqual([5]);
    expect(view.recent.map((e) => e.item.id)).toEqual([3, 2]);
    expect(view.recent[1]).toMatchObject({
      ackRequired: true,
      acknowledgedAt: "2026-10-06T10:00:00.000Z",
    });
    expect(view).toMatchSnapshot();
  });

  it("partial failure: no receipts means every mandatory post is open, with the banner", async () => {
    receiptsMock.mockRejectedValue(outage());
    const view = await loadAnnouncements("member");
    expect(view.failed).toBe(true);
    expect(view.openAcks.map((e) => e.item.id)).toEqual([4, 2, 1]);
    expect(view.recent.map((e) => e.item.id)).toEqual([3]);
    expect(view).toMatchSnapshot();
  });

  it("partial failure: the feed down keeps the open confirmations", async () => {
    feedMock.mockRejectedValue(outage());
    const view = await loadAnnouncements("member");
    expect(view.failed).toBe(true);
    expect(view.empty).toBe(false);
    expect(view.openAcks.map((e) => e.item.id)).toEqual([4, 1]);
    expect(view.feedDocumentIds).toEqual([]);
  });

  it("truncated: a walk cut at its cap is flagged", async () => {
    mandatoryMock.mockResolvedValue({ ...MANDATORY, truncated: true });
    expect((await loadAnnouncements("member")).truncated).toBe(true);
    mandatoryMock.mockResolvedValue(MANDATORY);
    receiptsMock.mockResolvedValue({ ...RECEIPTS, truncated: true });
    const view = await loadAnnouncements("member");
    expect(view.truncated).toBe(true);
    expect(view.failed).toBe(false);
    expect(view).toMatchSnapshot();
  });

  it("CMS down: failed, no cards and no empty state (the banner explains)", async () => {
    feedMock.mockRejectedValue(outage());
    mandatoryMock.mockRejectedValue(outage());
    receiptsMock.mockRejectedValue(outage());
    const view = await loadAnnouncements("member");
    expect(view).toMatchSnapshot();
    expect(view).toMatchObject({
      failed: true,
      empty: false,
      openAcks: [],
      pinned: [],
      recent: [],
    });
  });

  it("a role without the receipts read skips them (no request)", async () => {
    const view = await loadAnnouncements("guest");
    expect(receiptsMock).not.toHaveBeenCalled();
    expect(view.failed).toBe(false);
    expect(view.openAcks.map((e) => e.item.id)).toEqual([4, 2, 1]);
  });

  it("an empty feed without open confirmations is the empty state", async () => {
    feedMock.mockResolvedValue({ data: [], meta: { pagination: { total: 0 } } });
    mandatoryMock.mockResolvedValue({ data: [], truncated: false });
    const view = await loadAnnouncements("member");
    expect(view).toMatchObject({ empty: true, failed: false });
  });
});

describe("loadOpenAckCount (the dashboard banner)", () => {
  it("counts the mandatory posts the caller has not confirmed", async () => {
    await expect(loadOpenAckCount()).resolves.toEqual({ count: 2, truncated: false });
  });

  it("is unknown (null) when a read fails, never 0 or every post", async () => {
    receiptsMock.mockRejectedValue(outage());
    await expect(loadOpenAckCount()).resolves.toEqual({ count: null, truncated: false });
    receiptsMock.mockResolvedValue(RECEIPTS);
    mandatoryMock.mockRejectedValue(outage());
    await expect(loadOpenAckCount()).resolves.toEqual({ count: null, truncated: false });
  });

  it("flags a walk cut at its cap", async () => {
    receiptsMock.mockResolvedValue({ ...RECEIPTS, truncated: true });
    await expect(loadOpenAckCount()).resolves.toEqual({ count: 2, truncated: true });
  });
});

describe("pickLatestNews", () => {
  it("features the first pinned post, else the newest, and adds up to four more", () => {
    const items = [1, 2, 3, 4, 5, 6].map((id) => post(id, { pinned: id === 3 }));
    const news = pickLatestNews(items);
    expect(news.featured?.id).toBe(3);
    expect(news.rest.map((n) => n.id)).toEqual([1, 2, 4, 5]);
    expect(pickLatestNews([post(1), post(2)]).featured?.id).toBe(1);
    expect(pickLatestNews([])).toEqual({ featured: null, rest: [], failed: false });
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
    receiptsMock.mockRejectedValue(expired);
    await expect(loadAnnouncements("member")).rejects.toBe(expired);
    await expect(loadOpenAckCount()).rejects.toBe(expired);
  });
});
