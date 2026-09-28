import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrapiError } from "@/lib/strapi-error";
import type { PollResults } from "@/lib/types";

/**
 * FX47 on /polls: the per-poll results reads rethrow Next.js control flow,
 * so an expired session's redirect (NEXT_REDIRECT) reaches Next.js instead
 * of an empty card list; a 404 (the poll was deleted, unpublished or
 * retargeted after the list read, decision 02) drops only that card and
 * shows no banner; any other failure shows the FetchErrorBanner. DA01
 * (batch 4C) addresses each poll by its documentId, for the results read
 * and for the card's vote, and keeps all of this.
 *
 * `next/navigation` is the real module (redirect's own error and
 * unstable_rethrow); the CMS client, viewer and translations are mocked
 * (`pollRef` as in lib/strapi.ts, which strapi.test.ts pins), and the poll
 * card and the banner are markers.
 */
const listMock = vi.fn<() => Promise<unknown>>();
const resultsMock = vi.fn<(ref: string | number) => Promise<PollResults>>();

vi.mock("@/lib/strapi", () => ({
  api: {
    polls: { list: () => listMock(), results: (ref: string | number) => resultsMock(ref) },
  },
  pollRef: (poll: { id: number; documentId?: string }) => poll.documentId ?? poll.id,
}));
vi.mock("@/lib/viewer", () => ({
  getViewer: async () => ({ id: 1, displayName: "M", role: "member", department: null }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
vi.mock("@/components/polls/poll-card", () => ({
  PollCard: ({ results, pollRef }: { results: PollResults; pollRef?: string | number }) =>
    createElement("div", { "data-poll-card": results.poll.id, "data-poll-ref": pollRef }),
}));
vi.mock("@/components/fetch-error", () => ({
  FetchErrorBanner: () => createElement("div", { "data-fetch-error": "" }),
}));

const { default: PollsPage } = await import("./page");
const { redirect } = await import("next/navigation");

/** The error Next's redirect() throws (NEXT_REDIRECT digest). */
function captureRedirect(url: string): unknown {
  try {
    redirect(url);
  } catch (e) {
    return e;
  }
  throw new Error("redirect() did not throw");
}

const poll = (id: number) => ({ id, question: `Question ${id}`, options: ["a", "b"] });
const results = (id: number): PollResults => ({
  poll: { id, question: `Question ${id}`, options: ["a", "b"] },
  counts: [0, 0],
  total: 0,
  myVoteIndex: null,
});

/** Poll 1 answers; poll 2's results read rejects with `error`. */
function failSecond(error: unknown) {
  resultsMock.mockImplementation(async (id) => {
    if (id === 2) throw error;
    return results(Number(id));
  });
}

const render = async () => renderToStaticMarkup(await PollsPage());
const cards = (html: string) => [...html.matchAll(/data-poll-card="(\d+)"/g)].map((m) => m[1]);

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue({ data: [poll(1), poll(2)] });
  resultsMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("/polls results reads (FX47)", () => {
  it("renders a card per poll and no banner when every read answers", async () => {
    resultsMock.mockImplementation(async (id) => results(Number(id)));
    const html = await render();
    expect(cards(html)).toEqual(["1", "2"]);
    expect(html).not.toContain("data-fetch-error");
  });

  it("lets an expired session's redirect escape the page", async () => {
    const expired = captureRedirect("/sign-in?expired=1");
    failSecond(expired);
    await expect(PollsPage()).rejects.toBe(expired);
    expect(String((expired as { digest?: unknown }).digest)).toMatch(/^NEXT_REDIRECT;/);
  });

  it("drops only the card of a poll that answers 404, without a banner", async () => {
    failSecond(new StrapiError(404, "Not Found", ""));
    const html = await render();
    expect(cards(html)).toEqual(["1"]);
    expect(html).not.toContain("data-fetch-error");
  });

  it("shows the banner for any other failure", async () => {
    failSecond(new StrapiError(502, "Bad Gateway", ""));
    const html = await render();
    expect(cards(html)).toEqual(["1"]);
    expect(html).toContain("data-fetch-error");
  });

  it("shows the banner for a failure that is no CMS answer", async () => {
    failSecond(new TypeError("fetch failed"));
    expect(await render()).toContain("data-fetch-error");
  });
});

describe("/polls poll addresses (DA01)", () => {
  it("reads each poll's results and votes by its documentId", async () => {
    listMock.mockResolvedValue({
      data: [
        { ...poll(1), documentId: "k3m9x0000000000000000001" },
        { ...poll(2), documentId: "k3m9x0000000000000000002" },
      ],
    });
    resultsMock.mockImplementation(async (ref) =>
      results(ref === "k3m9x0000000000000000001" ? 1 : 2),
    );
    const html = await render();
    expect(resultsMock.mock.calls.map(([ref]) => ref)).toEqual([
      "k3m9x0000000000000000001",
      "k3m9x0000000000000000002",
    ]);
    expect([...html.matchAll(/data-poll-ref="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "k3m9x0000000000000000001",
      "k3m9x0000000000000000002",
    ]);
  });
});
