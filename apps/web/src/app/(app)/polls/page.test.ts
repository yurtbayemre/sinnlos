import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrapiError } from "@/lib/strapi-error";
import type { PollResults } from "@/lib/types";

/**
 * /polls reads every card's results in ONE request (WD04:
 * GET /api/poll-results through api.polls.resultsMany; it used to be one
 * request per poll). FX47 still holds: the results read rethrows Next.js
 * control flow, so an expired session's redirect (NEXT_REDIRECT) reaches
 * Next.js instead of an empty card list; a poll the cms leaves out (deleted,
 * unpublished or retargeted after the list read, decision 02) drops only
 * that card and shows no banner; a failed read shows the FetchErrorBanner.
 * DA01 addresses each poll by its documentId, for the results read and for
 * the card's vote, and a republish between the two reads keeps the card.
 *
 * `next/navigation` is the real module (redirect's own error and
 * unstable_rethrow); the CMS client, viewer and translations are mocked
 * (`pollRef` and `findPollResults` as in lib/api/polls.ts, which
 * strapi.test.ts pins), and the poll card and the banner are markers.
 */
const listMock = vi.fn<() => Promise<unknown>>();
const resultsManyMock = vi.fn<(refs: (string | number)[]) => Promise<PollResults[]>>();
const singleMock = vi.fn();

vi.mock("@/lib/strapi", () => ({
  api: {
    polls: {
      list: () => listMock(),
      resultsMany: (refs: (string | number)[]) => resultsManyMock(refs),
      results: (ref: string | number) => singleMock(ref),
    },
  },
  pollRef: (poll: { id: number; documentId?: string }) => poll.documentId ?? poll.id,
  findPollResults: (results: PollResults[], ref: string | number) =>
    results.find((entry) =>
      typeof ref === "string" ? entry.poll.documentId === ref : entry.poll.id === ref,
    ),
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

const doc = (n: number) => `k3m9x000000000000000000${n}`;
const poll = (id: number, documentId = doc(id)) => ({
  id,
  documentId,
  question: `Question ${id}`,
  options: ["a", "b"],
});
const results = (id: number, documentId = doc(id)): PollResults => ({
  poll: { id, documentId, question: `Question ${id}`, options: ["a", "b"] },
  counts: [0, 0],
  total: 0,
  myVoteIndex: null,
});

const render = async () => renderToStaticMarkup(await PollsPage());
const cards = (html: string) => [...html.matchAll(/data-poll-card="(\d+)"/g)].map((m) => m[1]);

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue({ data: [poll(1), poll(2)] });
  resultsManyMock.mockReset();
  resultsManyMock.mockImplementation(async (refs) =>
    refs.map((ref) => results(Number(String(ref).slice(-1)))),
  );
  singleMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("/polls results read (WD04: one request)", () => {
  it("asks for every card's results in one request, by documentId, and renders a card per poll", async () => {
    const html = await render();
    expect(resultsManyMock).toHaveBeenCalledOnce();
    expect(resultsManyMock).toHaveBeenCalledWith([doc(1), doc(2)]);
    expect(singleMock).not.toHaveBeenCalled();
    expect(cards(html)).toEqual(["1", "2"]);
    expect(html).not.toContain("data-fetch-error");
  });

  it("sends no results request without polls", async () => {
    listMock.mockResolvedValue({ data: [] });
    // Not rendered: the empty state is a client component (next-intl).
    await PollsPage();
    expect(resultsManyMock).not.toHaveBeenCalled();
  });

  it("drops only the card of a poll the cms leaves out, without a banner", async () => {
    resultsManyMock.mockResolvedValue([results(1)]);
    const html = await render();
    expect(cards(html)).toEqual(["1"]);
    expect(html).not.toContain("data-fetch-error");
  });

  it("lets an expired session's redirect escape the page (FX47)", async () => {
    const expired = captureRedirect("/sign-in?expired=1");
    resultsManyMock.mockRejectedValue(expired);
    await expect(PollsPage()).rejects.toBe(expired);
    expect(String((expired as { digest?: unknown }).digest)).toMatch(/^NEXT_REDIRECT;/);
  });

  it.each([
    ["a CMS error", new StrapiError(502, "Bad Gateway", "")],
    ["a failure that is no CMS answer", new TypeError("fetch failed")],
    ["an older cms without the endpoint", new StrapiError(404, "Not Found", "")],
  ])("shows the banner and no card for %s", async (_, error) => {
    resultsManyMock.mockRejectedValue(error);
    const html = await render();
    expect(cards(html)).toEqual([]);
    expect(html).toContain("data-fetch-error");
  });
});

describe("/polls poll addresses (DA01)", () => {
  it("keys each card by its documentId and votes there, also after a republish", async () => {
    // Poll 1 was republished between the list read and the results read:
    // new row id 21, same documentId.
    listMock.mockResolvedValue({ data: [poll(1), poll(7)] });
    resultsManyMock.mockResolvedValue([results(21, doc(1)), results(7)]);
    const html = await render();
    expect(cards(html)).toEqual(["21", "7"]);
    expect([...html.matchAll(/data-poll-ref="([^"]+)"/g)].map((m) => m[1])).toEqual([
      doc(1),
      doc(7),
    ]);
    const { PollCard } = await import("@/components/polls/poll-card");
    const keys: unknown[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== "object" || node === null || !("props" in node)) return;
      const element = node as { type: unknown; key: unknown; props: { children?: unknown } };
      if (element.type === PollCard) keys.push(element.key);
      walk(element.props.children);
    };
    walk(await PollsPage());
    expect(keys).toEqual([doc(1), doc(7)]);
  });

  it("addresses a poll without a documentId in Strapi's shape by its row id", async () => {
    listMock.mockResolvedValue({ data: [{ id: 3, question: "q", options: ["a"] }] });
    resultsManyMock.mockResolvedValue([results(3, "demo-poll-3")]);
    const html = await render();
    expect(resultsManyMock).toHaveBeenCalledWith([3]);
    expect(cards(html)).toEqual(["3"]);
  });
});
