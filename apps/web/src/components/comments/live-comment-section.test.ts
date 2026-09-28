import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommentTarget } from "@/lib/comment-target";
import type { ContentChannel } from "@/lib/live-contract";
import { createSeqGuard } from "@/lib/optimistic";
import type { CommentSectionData } from "@/lib/reaction-summary";

/**
 * The page-level refetch queue of the comment sections (WD04,
 * createSectionsRefresher in live-comment-section.tsx): a ping refetches
 * only the pinged targets, pings that arrive together share one load, loads
 * are single-flight, every section applies a snapshot through its own
 * sequence guard (FX28), and a failed load keeps the current state.
 *
 * refreshOnTabRegain: with live events off (no stream, no hello catch-up)
 * a regained tab refetches every section at once, in one batch; with a
 * stream it adds nothing (no double fetch).
 *
 * The Server Action module is stubbed; the refresher gets its load function
 * injected.
 */
vi.mock("@/lib/comment-actions", () => ({
  getCommentSection: vi.fn(),
  getCommentSections: vi.fn(),
  addComment: vi.fn(),
  deleteComment: vi.fn(),
  toggleReaction: vi.fn(),
}));

const { createSectionsRefresher, refreshOnTabRegain } = await import("./live-comment-section");

const DELAY = 50;
const target = (n: number): CommentTarget => ({ type: "announcement", documentId: `doc-${n}` });
const channel = (n: number) => `announcement:doc-${n}` as ContentChannel;
/** A snapshot that names its target, so a test can see which one it got. */
const snapshot = (doc: string, version = 1): CommentSectionData => ({
  comments: [{ id: version, body: doc, targetType: "announcement", targetDocumentId: doc }],
  reactions: [],
});

type Load = (targets: CommentTarget[]) => Promise<CommentSectionData[]>;

function section(n: number) {
  const applied: CommentSectionData[] = [];
  return {
    applied,
    handle: {
      target: target(n),
      guard: createSeqGuard(),
      apply: (data: CommentSectionData) => applied.push(data),
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSectionsRefresher", () => {
  it("a ping on card 3 refetches card 3 only", async () => {
    const load = vi.fn<Load>(async (targets) => targets.map((t) => snapshot(t.documentId ?? "")));
    const refresher = createSectionsRefresher(load, DELAY);
    const cards = Array.from({ length: 10 }, (_, i) => section(i + 1));
    cards.forEach((card, i) => refresher.add(channel(i + 1), card.handle));

    refresher.refresh([channel(3)]);
    await vi.advanceTimersByTimeAsync(DELAY);

    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[0]).toEqual([target(3)]);
    expect(cards[2]?.applied.map((data) => data.comments[0]?.body)).toEqual(["doc-3"]);
    for (const [i, card] of cards.entries()) if (i !== 2) expect(card.applied).toEqual([]);
  });

  it("loads the channels pinged together in one call, each once", async () => {
    const load = vi.fn<Load>(async (targets) => targets.map((t) => snapshot(t.documentId ?? "")));
    const refresher = createSectionsRefresher(load, DELAY);
    for (const n of [1, 2, 3]) refresher.add(channel(n), section(n).handle);

    refresher.refresh([channel(1)]);
    refresher.refresh([channel(3), channel(1)]);
    await vi.advanceTimersByTimeAsync(DELAY);

    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[0]).toEqual([target(1), target(3)]);
  });

  it("refreshAll (the poll tick) loads every channel in one call; unknown channels are ignored", async () => {
    const load = vi.fn<Load>(async (targets) => targets.map((t) => snapshot(t.documentId ?? "")));
    const refresher = createSectionsRefresher(load, DELAY);
    for (const n of [1, 2]) refresher.add(channel(n), section(n).handle);

    refresher.refresh([channel(9)]);
    refresher.refreshAll();
    await vi.advanceTimersByTimeAsync(DELAY);

    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[0]).toEqual([target(1), target(2)]);
  });

  it("is single-flight: a ping during a load goes into the next one", async () => {
    let release: (() => void) | undefined;
    const load = vi.fn<Load>(async (targets) => {
      if (load.mock.calls.length === 1) await new Promise<void>((resolve) => (release = resolve));
      return targets.map((t) => snapshot(t.documentId ?? ""));
    });
    const refresher = createSectionsRefresher(load, DELAY);
    for (const n of [1, 2]) refresher.add(channel(n), section(n).handle);

    refresher.refresh([channel(1)]);
    await vi.advanceTimersByTimeAsync(DELAY);
    refresher.refresh([channel(2)]);
    await vi.advanceTimersByTimeAsync(DELAY * 4);
    expect(load).toHaveBeenCalledTimes(1);

    release?.();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1]?.[0]).toEqual([target(2)]);
  });

  it("never lets a batch overwrite a newer snapshot of the section (FX28 guard)", async () => {
    let release: (() => void) | undefined;
    const load = vi.fn<Load>(async (targets) => {
      await new Promise<void>((resolve) => (release = resolve));
      return targets.map((t) => snapshot(t.documentId ?? "", 1));
    });
    const refresher = createSectionsRefresher(load, DELAY);
    const card = section(1);
    refresher.add(channel(1), card.handle);

    refresher.refresh([channel(1)]);
    await vi.advanceTimersByTimeAsync(DELAY);
    // The section's own mutation refetch starts later and lands first.
    const own = card.handle.guard.begin();
    expect(card.handle.guard.commit(own)).toBe(true);
    card.handle.apply(snapshot("doc-1", 2));

    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(card.applied.map((data) => data.comments[0]?.id)).toEqual([2]);
  });

  it("gives every section on a channel the snapshot, and drops the channel with its last section", async () => {
    const load = vi.fn<Load>(async (targets) => targets.map((t) => snapshot(t.documentId ?? "")));
    const refresher = createSectionsRefresher(load, DELAY);
    const first = section(1);
    const second = section(1);
    expect(refresher.add(channel(1), first.handle)).toBe(true);
    expect(refresher.add(channel(1), second.handle)).toBe(false);

    refresher.refresh([channel(1)]);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(load.mock.calls[0]?.[0]).toEqual([target(1)]);
    expect(first.applied).toHaveLength(1);
    expect(second.applied).toHaveLength(1);

    expect(refresher.remove(channel(1), first.handle)).toBe(false);
    expect(refresher.remove(channel(1), second.handle)).toBe(true);
    refresher.refreshAll();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps the current state when a load fails, and the next refresh retries", async () => {
    const load = vi.fn<Load>(async (targets) => {
      if (load.mock.calls.length === 1) throw new Error("fetch failed");
      return targets.map((t) => snapshot(t.documentId ?? ""));
    });
    const refresher = createSectionsRefresher(load, DELAY);
    const card = section(1);
    refresher.add(channel(1), card.handle);

    refresher.refresh([channel(1)]);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(card.applied).toEqual([]);

    refresher.refresh([channel(1)]);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(card.applied).toHaveLength(1);
  });

  it("loads more than 200 channels in calls of at most 200 targets", async () => {
    const load = vi.fn<Load>(async (targets) => targets.map((t) => snapshot(t.documentId ?? "")));
    const refresher = createSectionsRefresher(load, DELAY);
    for (let n = 1; n <= 450; n += 1) refresher.add(channel(n), section(n).handle);

    refresher.refreshAll();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(load.mock.calls.map(([targets]) => targets.length)).toEqual([200, 200, 50]);
  });

  it("stop() drops a pending batch", async () => {
    const load = vi.fn<Load>(async (targets) => targets.map((t) => snapshot(t.documentId ?? "")));
    const refresher = createSectionsRefresher(load, DELAY);
    refresher.add(channel(1), section(1).handle);
    refresher.refresh([channel(1)]);
    refresher.stop();
    await vi.advanceTimersByTimeAsync(DELAY * 2);
    expect(load).not.toHaveBeenCalled();
  });
});

/** A document stand-in: its visibility and the visibilitychange listeners. */
function fakeDocument(initial: DocumentVisibilityState = "visible") {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: initial,
    addEventListener: vi.fn((_type: "visibilitychange", listener: () => void) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: "visibilitychange", listener: () => void) => {
      listeners.delete(listener);
    }),
  };
  /** The browser hiding or showing the tab. */
  const show = (state: DocumentVisibilityState) => {
    doc.visibilityState = state;
    for (const listener of [...listeners]) listener();
  };
  return { doc, show, listeners };
}

describe("refreshOnTabRegain", () => {
  it("without a stream: refetches every section once when the tab is visible again", () => {
    const { doc, show } = fakeDocument();
    const refreshAll = vi.fn();
    refreshOnTabRegain(doc, false, refreshAll);

    show("hidden");
    expect(refreshAll).not.toHaveBeenCalled();
    show("visible");
    expect(refreshAll).toHaveBeenCalledOnce();
  });

  it("without a stream: the regain is one batched load for all sections", async () => {
    const load = vi.fn<Load>(async (targets) => targets.map((t) => snapshot(t.documentId ?? "")));
    const refresher = createSectionsRefresher(load, DELAY);
    const cards = [1, 2, 3].map((n) => section(n));
    cards.forEach((card, i) => refresher.add(channel(i + 1), card.handle));
    const { doc, show } = fakeDocument();
    refreshOnTabRegain(doc, false, () => refresher.refreshAll());

    show("hidden");
    show("visible");
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[0]).toEqual([target(1), target(2), target(3)]);
    for (const card of cards) expect(card.applied).toHaveLength(1);
  });

  it("with a stream: adds no listener (the stream's hello runs the catch-up)", () => {
    const { doc, show } = fakeDocument();
    const refreshAll = vi.fn();
    const remove = refreshOnTabRegain(doc, true, refreshAll);

    expect(doc.addEventListener).not.toHaveBeenCalled();
    show("hidden");
    show("visible");
    expect(refreshAll).not.toHaveBeenCalled();
    remove();
  });

  it("removes its listener on cleanup", () => {
    const { doc, show, listeners } = fakeDocument();
    const refreshAll = vi.fn();
    const remove = refreshOnTabRegain(doc, false, refreshAll);
    expect(listeners.size).toBe(1);

    remove();
    expect(listeners.size).toBe(0);
    show("visible");
    expect(refreshAll).not.toHaveBeenCalled();
  });
});
