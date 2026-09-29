import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommentTarget } from "@/lib/comment-target";
import type { CommentSectionData } from "@/lib/reaction-summary";
import type { ReactionSummary } from "@/lib/types";
import { FakeEventSource, installFakeBrowser, type FakeBrowser } from "./fake-browser.test.helper";

/**
 * The page-level CommentSectionsProvider (WD04, live-comment-section.tsx)
 * wired to the real LiveEventsProvider, the batch-9 deferral of LF05: one
 * live listener and one subscription per target channel however many
 * sections show it, a ping refetching only its channel's sections in one
 * batched getCommentSections call, the one poll backstop at 60 s while the
 * stream is healthy and 10 s while it is not, the hello catch-up as one
 * batch, and the tab-regain refetch only without a stream.
 *
 * The Server Actions are stubbed; the reaction bar and the thread are
 * stubbed too (the bar records the reactions it is handed, which is how the
 * test sees a section's state).
 */
const actions = vi.hoisted(() => ({
  getCommentSections: vi.fn<(targets: CommentTarget[]) => Promise<CommentSectionData[]>>(),
  getCommentSection: vi.fn<(target: CommentTarget) => Promise<CommentSectionData>>(),
}));
const rendered = vi.hoisted(() => new Map<string, number>());

vi.mock("@/lib/comment-actions", () => ({
  ...actions,
  addComment: vi.fn(),
  deleteComment: vi.fn(),
  toggleReaction: vi.fn(),
}));
vi.mock("@/components/reactions/reaction-bar", () => ({
  ReactionBar: ({ target, reactions }: { target: CommentTarget; reactions: ReactionSummary[] }) => {
    rendered.set(target.documentId ?? "", reactions[0]?.count ?? 0);
    return null;
  },
}));
vi.mock("@/components/comments/comment-thread", () => ({ CommentThread: () => null }));

const { CommentSectionsProvider, LiveCommentSection } = await import(
  "@/components/comments/live-comment-section"
);
const { LiveEventsProvider } = await import("./live-events-provider");

let browser: FakeBrowser;
/** The `count` every load answers, bumped per call. */
let version = 0;

const target = (documentId: string): CommentTarget => ({ type: "announcement", documentId });
const data = (count: number): CommentSectionData => ({
  comments: [],
  reactions: [{ emoji: "heart", count, reacted: false }],
});

function section(documentId: string, key: string) {
  return createElement(LiveCommentSection, {
    key,
    target: target(documentId),
    initial: data(0),
  });
}

async function mount(sections: ReactNode, enabled = true) {
  await browser.render(
    // eslint-disable-next-line react/no-children-prop -- a .test.ts has no JSX, and createElement's types want the providers' required children in the props
    createElement(LiveEventsProvider, {
      enabled,
      // eslint-disable-next-line react/no-children-prop -- as above
      children: createElement(CommentSectionsProvider, { children: sections }),
    }),
  );
}

const advance = (ms: number) => browser.act(() => vi.advanceTimersByTimeAsync(ms).then(() => {}));

const hello = (connId = "conn-1") =>
  browser.act(() => FakeEventSource.latest().emit("hello", { connId }));

const ping = (documentId: string) =>
  browser.act(() =>
    FakeEventSource.latest().emit("ping", {
      type: "content",
      channel: `announcement:${documentId}`,
    }),
  );

/** The document ids of every getCommentSections call so far. */
const loads = () =>
  actions.getCommentSections.mock.calls.map(([targets]) => targets.map((t) => t.documentId));

const subscribeBodies = () =>
  browser.calls.filter((call) => call.url === "/live/subscribe").map((call) => call.body);

beforeEach(() => {
  vi.useFakeTimers();
  browser = installFakeBrowser();
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  version = 0;
  rendered.clear();
  actions.getCommentSections.mockReset();
  actions.getCommentSections.mockImplementation(async (targets) => {
    version += 1;
    return targets.map(() => data(version));
  });
});

afterEach(async () => {
  await browser.unmount();
  browser.uninstall();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("CommentSectionsProvider on the live provider", () => {
  it("subscribes each target channel once, however many sections show it", async () => {
    await mount([section("a", "a1"), section("b", "b1"), section("a", "a2")]);
    await hello();
    expect(subscribeBodies()).toEqual([
      { connId: "conn-1", rev: 1, channels: ["announcement:a", "announcement:b"] },
    ]);
  });

  it("a ping refetches its channel only, and every section of it gets the snapshot", async () => {
    await mount([section("a", "a1"), section("b", "b1"), section("a", "a2")]);
    await hello();
    await ping("a");
    // 150 ms ping coalescing in the live provider, 50 ms batching in the page provider.
    await advance(199);
    expect(loads()).toEqual([]);
    await advance(1);
    expect(loads()).toEqual([["a"]]);
    expect(rendered.get("a")).toBe(1);
    expect(rendered.get("b")).toBe(0);
  });

  it("pings of several channels that arrive together load in one call", async () => {
    await mount([section("a", "a1"), section("b", "b1"), section("c", "c1")]);
    await hello();
    await ping("a");
    await advance(10);
    await ping("c");
    await advance(500);
    expect(loads()).toEqual([["a", "c"]]);
  });

  it("drops a channel's subscription only with its last section", async () => {
    await mount([section("a", "a1"), section("a", "a2"), section("b", "b1")]);
    await hello();
    await mount([section("a", "a1"), section("b", "b1")]);
    expect(subscribeBodies()).toHaveLength(1);
    await mount([section("b", "b1")]);
    expect(subscribeBodies().at(-1)).toEqual({
      connId: "conn-1",
      rev: 2,
      channels: ["announcement:b"],
    });
  });

  it("polls every section at 10 s without a healthy stream and at 60 s with one", async () => {
    await mount([section("a", "a1"), section("b", "b1")]);
    // Each tick queues one batch, loaded 50 ms later.
    await advance(10_050);
    expect(loads()).toEqual([["a", "b"]]);
    await hello();
    await advance(59_999);
    expect(loads()).toHaveLength(1);
    await advance(51);
    expect(loads()).toEqual([
      ["a", "b"],
      ["a", "b"],
    ]);
  });

  it("the catch-up after a reconnect loads every section in one batch", async () => {
    await mount([section("a", "a1"), section("b", "b1")]);
    await hello();
    await advance(3_000);
    await browser.act(() => FakeEventSource.latest().fail());
    await advance(750);
    await hello("conn-2");
    await advance(50);
    expect(loads()).toEqual([["a", "b"]]);
  });

  it("refetches every section on tab regain only when there is no stream", async () => {
    await mount([section("a", "a1"), section("b", "b1")], false);
    await browser.setVisibility("hidden");
    await browser.setVisibility("visible");
    await advance(50);
    expect(loads()).toEqual([["a", "b"]]);
  });

  it("does not refetch on tab regain with a stream (the hello's catch-up does)", async () => {
    await mount([section("a", "a1")]);
    await hello();
    await browser.setVisibility("hidden");
    await browser.setVisibility("visible");
    await advance(50);
    expect(loads()).toEqual([]);
  });
});
