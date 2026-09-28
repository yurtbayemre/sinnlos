import { describe, expect, it } from "vitest";
import type { ReactionSummary } from "@/lib/types";
import {
  applyLatest,
  applyReactionIntent,
  createSeqGuard,
  reactionIntent,
  type SeqGuard,
} from "./optimistic";

/**
 * FX28: the reaction reducer carries the desired end state, and refetches
 * are ordered by the last APPLIED sequence number, so a mutation's own
 * snapshot is not dropped by a refetch that started later.
 */
const summary = (): ReactionSummary[] => [
  { emoji: "thumbsup", count: 2, reacted: true },
  { emoji: "heart", count: 1, reacted: false },
];

/** A promise the test settles by hand, to control the resolution order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("reactionIntent", () => {
  it("asks for the opposite of what the bar shows", () => {
    expect(reactionIntent(summary(), "thumbsup")).toEqual({ emoji: "thumbsup", reacted: false });
    expect(reactionIntent(summary(), "heart")).toEqual({ emoji: "heart", reacted: true });
    expect(reactionIntent(summary(), "laugh")).toEqual({ emoji: "laugh", reacted: true });
  });
});

describe("applyReactionIntent", () => {
  it("sets the reaction and adjusts the count", () => {
    expect(applyReactionIntent(summary(), { emoji: "heart", reacted: true })).toEqual([
      { emoji: "thumbsup", count: 2, reacted: true },
      { emoji: "heart", count: 2, reacted: true },
    ]);
    expect(applyReactionIntent(summary(), { emoji: "thumbsup", reacted: false })).toEqual([
      { emoji: "thumbsup", count: 1, reacted: false },
      { emoji: "heart", count: 1, reacted: false },
    ]);
  });

  it("adds a first reaction for an emoji nobody used yet", () => {
    expect(applyReactionIntent(summary(), { emoji: "laugh", reacted: true })).toContainEqual({
      emoji: "laugh",
      count: 1,
      reacted: true,
    });
    const current = summary();
    expect(applyReactionIntent(current, { emoji: "laugh", reacted: false })).toBe(current);
  });

  it("is idempotent: re-applied on a base that already has the state, nothing flips back", () => {
    const current = summary();
    const once = applyReactionIntent(current, { emoji: "heart", reacted: true });
    // React re-runs pending optimistic updates on each new base state; the
    // refetched base already contains the reaction.
    expect(applyReactionIntent(once, { emoji: "heart", reacted: true })).toBe(once);
    expect(applyReactionIntent(current, { emoji: "thumbsup", reacted: true })).toBe(current);
  });

  it("never mutates the base, so a rejected action falls back to it unchanged", () => {
    const base = summary();
    const copy = structuredClone(base);
    applyReactionIntent(base, { emoji: "thumbsup", reacted: false });
    applyReactionIntent(base, { emoji: "laugh", reacted: true });
    expect(base).toEqual(copy);
  });

  it("never counts below zero on inconsistent input", () => {
    const [heart] = applyReactionIntent([{ emoji: "heart", count: 0, reacted: true }], {
      emoji: "heart",
      reacted: false,
    });
    expect(heart).toEqual({ emoji: "heart", count: 0, reacted: false });
  });
});

describe("createSeqGuard", () => {
  it("accepts answers in order and drops one older than the last applied", () => {
    const guard = createSeqGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(guard.commit(second)).toBe(true);
    expect(guard.commit(first)).toBe(false);
  });

  it("applies an answer although a newer request is still in flight", () => {
    const guard = createSeqGuard();
    const first = guard.begin();
    guard.begin();
    expect(guard.commit(first)).toBe(true);
  });

  it("applies each answer at most once", () => {
    const guard = createSeqGuard();
    const seq = guard.begin();
    expect(guard.commit(seq)).toBe(true);
    expect(guard.commit(seq)).toBe(false);
  });
});

describe("applyLatest", () => {
  const setup = () => {
    const guard: SeqGuard = createSeqGuard();
    const applied: string[] = [];
    const run = (load: () => Promise<string>) => applyLatest(guard, load, (v) => applied.push(v));
    return { applied, run };
  };

  it("keeps the mutation's own snapshot when a later ping refetch resolves after it", async () => {
    const { applied, run } = setup();
    const mutation = deferred<string>();
    const ping = deferred<string>();
    const a = run(() => mutation.promise);
    const b = run(() => ping.promise);
    mutation.resolve("after-mutation");
    await expect(a).resolves.toBe(true);
    ping.resolve("after-ping");
    await expect(b).resolves.toBe(true);
    expect(applied).toEqual(["after-mutation", "after-ping"]);
  });

  it("drops an older snapshot that resolves after a newer one (out of order)", async () => {
    const { applied, run } = setup();
    const older = deferred<string>();
    const newer = deferred<string>();
    const a = run(() => older.promise);
    const b = run(() => newer.promise);
    newer.resolve("new");
    await expect(b).resolves.toBe(true);
    older.resolve("old");
    await expect(a).resolves.toBe(false);
    expect(applied).toEqual(["new"]);
  });

  it("keeps the state on a rejection and still applies the other answer", async () => {
    const { applied, run } = setup();
    const mutation = deferred<string>();
    const ping = deferred<string>();
    const a = run(() => mutation.promise);
    const b = run(() => ping.promise);
    ping.reject(new Error("CMS down"));
    await expect(b).rejects.toThrow("CMS down");
    expect(applied).toEqual([]);
    // The former `seq === latest` guard dropped this one as well.
    mutation.resolve("after-mutation");
    await expect(a).resolves.toBe(true);
    expect(applied).toEqual(["after-mutation"]);
  });
});
