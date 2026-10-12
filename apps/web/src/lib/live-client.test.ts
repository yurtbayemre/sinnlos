import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeEventSource } from "@/components/live/fake-browser.test.helper";
import { LiveClient, type AddRemoveSubscribeRequest, type LiveClientDeps } from "./live-client";

/**
 * LiveClient on injected dependencies (LF05): no window, document,
 * EventSource or fetch global exists in this file; the clock, the random
 * source, the visibility and the subscribe POST are fakes the test sets.
 * The connection rules themselves are pinned through the React provider in
 * components/live/live-events-provider.test.ts; this file covers what the
 * extraction made injectable and the lifecycle the provider's effect uses.
 */

interface Harness {
  deps: LiveClientDeps;
  client: LiveClient;
  health: boolean[];
  posts: { url: string; body: unknown }[];
  clock: { now: number };
  rng: { value: number };
  setVisible(visible: boolean): void;
  visibilityListeners: Set<() => void>;
}

function harness(): Harness {
  const clock = { now: 1_000_000 };
  const rng = { value: 0 };
  let visible = true;
  const visibilityListeners = new Set<() => void>();
  const posts: { url: string; body: unknown }[] = [];
  const health: boolean[] = [];
  const deps: LiveClientDeps = {
    createEventSource: (url) => new FakeEventSource(url),
    now: () => clock.now,
    random: () => rng.value,
    visibility: {
      visible: () => visible,
      subscribe(listener) {
        visibilityListeners.add(listener);
        return () => visibilityListeners.delete(listener);
      },
    },
    post: async (url, body) => {
      posts.push({ url, body });
      return true;
    },
  };
  return {
    deps,
    client: new LiveClient(deps, (healthy) => health.push(healthy)),
    health,
    posts,
    clock,
    rng,
    visibilityListeners,
    setVisible(next) {
      visible = next;
      for (const listener of [...visibilityListeners]) listener();
    },
  };
}

/** Moves the injected clock and the fake timers together. */
async function advance(h: Harness, ms: number) {
  h.clock.now += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LiveClient without browser globals", () => {
  it("runs on the injected dependencies alone", async () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined");
    expect(typeof (globalThis as { EventSource?: unknown }).EventSource).toBe("undefined");
    const h = harness();
    h.client.register("announcement:a", () => undefined);
    h.client.start();
    expect(FakeEventSource.instances.map((source) => source.url)).toEqual(["/live/stream"]);
    FakeEventSource.latest().emit("hello", { connId: "c1", emitFresh: true });
    await Promise.resolve();
    expect(h.health).toEqual([true]);
    expect(h.posts).toEqual([
      { url: "/live/subscribe", body: { connId: "c1", rev: 1, channels: ["announcement:a"] } },
    ]);
    h.client.stop();
  });

  it("creates nothing before start() (the provider constructs it during the server render)", () => {
    const h = harness();
    h.client.register("notifications", () => undefined);
    expect(FakeEventSource.instances).toEqual([]);
    expect(h.visibilityListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("classifies a close by the injected clock, not by Date", async () => {
    const h = harness();
    h.client.start();
    // The fake timers stand still; the injected clock says 10 s passed:
    // not an instant close, so the next close does not count towards five.
    h.clock.now += 10_000;
    FakeEventSource.latest().fail();
    await vi.advanceTimersByTimeAsync(750);
    expect(FakeEventSource.instances).toHaveLength(2);
    h.client.stop();
  });

  it("draws every jitter from the injected random source", async () => {
    const h = harness();
    h.rng.value = 0.5;
    h.client.start();
    await advance(h, 3_000);
    FakeEventSource.latest().fail();
    // 750 + 0.5·1500
    await advance(h, 1_499);
    expect(FakeEventSource.instances).toHaveLength(1);
    await advance(h, 1);
    expect(FakeEventSource.instances).toHaveLength(2);
    h.client.stop();
  });

  it("follows the injected visibility: hidden closes, visible reopens", async () => {
    const h = harness();
    h.client.start();
    const first = FakeEventSource.latest();
    h.setVisible(false);
    expect(first.closed).toBe(true);
    h.setVisible(true);
    expect(FakeEventSource.open()).toHaveLength(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    h.client.stop();
  });
});

describe("terminal bye frames (LF05)", () => {
  /** A started client with a stream that said hello `stableMs` ago. */
  async function openStream(h: Harness, stableMs = 5_000) {
    h.client.start();
    const source = FakeEventSource.latest();
    source.emit("hello", { connId: "c1", emitFresh: true });
    await advance(h, stableMs);
    return source;
  }

  it("evicted: closes the stream and stays off, the watchdog included, until the tab is visible again", async () => {
    const h = harness();
    const source = await openStream(h);
    source.emit("bye", { reason: "evicted" });
    expect(source.closed).toBe(true);
    expect(h.health.at(-1)).toBe(false);
    await advance(h, 30 * 60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    h.setVisible(false);
    h.setVisible(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    h.client.stop();
  });

  it("expired: stays off like evicted", async () => {
    const h = harness();
    const source = await openStream(h);
    source.emit("bye", { reason: "expired" });
    await advance(h, 30 * 60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    h.client.stop();
  });

  it("shutdown: reconnects with the fleet spread (up to 15 s more), not the browser's 3 s", async () => {
    const h = harness();
    h.rng.value = 0.5;
    const source = await openStream(h);
    source.emit("bye", { reason: "shutdown" });
    expect(source.closed).toBe(true);
    // 750 + 0.5·1500 + 0.5·15 000
    await advance(h, 8_999);
    expect(FakeEventSource.instances).toHaveLength(1);
    await advance(h, 1);
    expect(FakeEventSource.instances).toHaveLength(2);
    h.client.stop();
  });

  it("rotate: reconnects after the normal backoff and catches up on the hello", async () => {
    const h = harness();
    const calls: string[] = [];
    h.client.register("notifications", () => {
      calls.push("n");
    });
    const source = await openStream(h);
    source.emit("bye", { reason: "rotate" });
    await advance(h, 750);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.latest().emit("hello", { connId: "c2", emitFresh: true });
    await advance(h, 0);
    expect(calls).toEqual(["n"]);
    h.client.stop();
  });

  it("an unknown or malformed reason counts as a rotation", async () => {
    for (const data of [{ reason: "gone" }, "not json"]) {
      FakeEventSource.instances = [];
      const h = harness();
      const source = await openStream(h);
      source.emit("bye", data);
      expect(source.closed).toBe(true);
      await advance(h, 750);
      expect(FakeEventSource.instances).toHaveLength(2);
      h.client.stop();
    }
  });

  it("a bye is no instant close: five quick byes never make the terminal stop", async () => {
    const h = harness();
    h.client.start();
    // Each within 2 s of its open, and no hello: the backoff still climbs.
    for (const delay of [750, 1_500, 3_000, 6_000, 12_000, 24_000]) {
      FakeEventSource.latest().emit("bye", { reason: "rotate" });
      await advance(h, delay);
    }
    expect(FakeEventSource.instances).toHaveLength(7);
    h.client.stop();
  });
});

describe("catch-up queue (LF05)", () => {
  it("hiding the tab drops the queued refetches; the running ones finish", async () => {
    const h = harness();
    const log: string[] = [];
    const pending: (() => void)[] = [];
    for (const channel of [
      "notifications",
      "announcement:a",
      "announcement:b",
      "wiki-page:w",
    ] as const) {
      h.client.register(
        channel,
        () =>
          new Promise<void>((resolve) => {
            log.push(channel);
            pending.push(resolve);
          }),
      );
    }
    h.client.start();
    FakeEventSource.latest().emit("hello", { connId: "c1", emitFresh: true });
    await advance(h, 3_000);
    FakeEventSource.latest().fail();
    await advance(h, 750);
    FakeEventSource.latest().emit("hello", { connId: "c2", emitFresh: true });
    // Two at a time: notifications first, then the first content channel.
    expect(log).toEqual(["notifications", "announcement:a"]);

    h.setVisible(false);
    for (const resolve of pending.splice(0)) resolve();
    await advance(h, 60_000);
    expect(log).toEqual(["notifications", "announcement:a"]);

    // The next regain's hello queues every channel again.
    h.setVisible(true);
    FakeEventSource.latest().emit("hello", { connId: "c3", emitFresh: true });
    await advance(h, 0);
    expect(log.slice(2)).toEqual(["notifications", "announcement:a"]);
    for (const resolve of pending.splice(0)) resolve();
    await advance(h, 0);
    expect(log.slice(4)).toEqual(["announcement:b", "wiki-page:w"]);
    h.client.stop();
  });

  it("stop() drops the queued refetches too", async () => {
    const h = harness();
    const log: string[] = [];
    const pending: (() => void)[] = [];
    for (const channel of ["notifications", "announcement:a", "announcement:b"] as const) {
      h.client.register(
        channel,
        () =>
          new Promise<void>((resolve) => {
            log.push(channel);
            pending.push(resolve);
          }),
      );
    }
    h.client.start();
    FakeEventSource.latest().emit("hello", { connId: "c1", emitFresh: true });
    FakeEventSource.latest().fail(FakeEventSource.CONNECTING);
    FakeEventSource.latest().emit("hello", { connId: "c2", emitFresh: true });
    expect(log).toEqual(["notifications", "announcement:a"]);
    h.client.stop();
    for (const resolve of pending.splice(0)) resolve();
    await advance(h, 0);
    expect(log).toEqual(["notifications", "announcement:a"]);
  });
});

describe("two-leg health (LF05)", () => {
  it("is degraded while the hello or the heartbeats say the cms leg is not fresh", async () => {
    const h = harness();
    h.client.start();
    const source = FakeEventSource.latest();
    source.emit("hello", { connId: "c1", emitFresh: false });
    expect(h.health).toEqual([false]);
    source.emit("hb", { emitFresh: true });
    expect(h.health.at(-1)).toBe(true);
    source.emit("hb", { emitFresh: false });
    expect(h.health.at(-1)).toBe(false);
    // Still subscribed and connected: the stream itself is fine.
    await advance(h, 0);
    expect(h.posts).toEqual([]);
    expect(source.closed).toBe(false);
    h.client.stop();
  });

  it("a stale heartbeat still feeds the watchdog", async () => {
    const h = harness();
    h.client.start();
    const source = FakeEventSource.latest();
    source.emit("hello", { connId: "c1", emitFresh: false });
    for (let i = 0; i < 6; i += 1) {
      await advance(h, 25_000);
      source.emit("hb", { emitFresh: false });
    }
    expect(source.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
    h.client.stop();
  });

  it("a web from before LF05 (hello without the flag, hb data 1) counts as fresh", () => {
    const h = harness();
    h.client.start();
    const source = FakeEventSource.latest();
    source.emit("hello", { connId: "c1" });
    source.emit("hb", "1");
    expect(h.health).toEqual([true, true]);
    h.client.stop();
  });
});

describe("a subscribe POST the server did not take", () => {
  /** A client whose subscribe POSTs answer `answers` in turn (then true). */
  function failing(answers: boolean[]) {
    const h = harness();
    h.deps.post = async (url, body) => {
      h.posts.push({ url, body });
      return answers.shift() ?? true;
    };
    h.client.register("announcement:a", () => undefined);
    h.client.start();
    FakeEventSource.latest().emit("hello", { connId: "c1", emitFresh: true });
    return h;
  }
  const revs = (h: Harness) => h.posts.map((post) => (post.body as { rev: number }).rev);

  it("is retried after 2 and 4 s, degraded until one is taken", async () => {
    const h = failing([false, false]);
    await advance(h, 0);
    expect(revs(h)).toEqual([1]);
    // The set is not on the bus: the owners poll at the short intervals.
    expect(h.health).toEqual([true, false]);
    await advance(h, 1_999);
    expect(revs(h)).toEqual([1]);
    await advance(h, 1);
    expect(revs(h)).toEqual([1, 2]);
    expect(h.health.at(-1)).toBe(false);
    await advance(h, 4_000);
    expect(revs(h)).toEqual([1, 2, 3]);
    expect(h.posts.at(-1)?.body).toEqual({ connId: "c1", rev: 3, channels: ["announcement:a"] });
    expect(h.health.at(-1)).toBe(true);
    // Taken: no more retries.
    await advance(h, 60_000);
    expect(revs(h)).toEqual([1, 2, 3]);
    h.client.stop();
  });

  it("a fresh heartbeat does not hide the failure", async () => {
    const h = failing([false]);
    await advance(h, 0);
    FakeEventSource.latest().emit("hb", { emitFresh: true });
    expect(h.health.at(-1)).toBe(false);
    await advance(h, 2_000);
    FakeEventSource.latest().emit("hb", { emitFresh: true });
    expect(h.health.at(-1)).toBe(true);
    h.client.stop();
  });

  it("gives up after the third retry until the next change or hello", async () => {
    const h = failing([false, false, false, false, false]);
    await advance(h, 0);
    await advance(h, 2_000 + 4_000 + 8_000);
    expect(revs(h)).toEqual([1, 2, 3, 4]);
    // The stream itself stays up (fresh heartbeats), the set stays untaken.
    for (let i = 0; i < 4; i += 1) {
      await advance(h, 20_000);
      FakeEventSource.latest().emit("hb", { emitFresh: true });
    }
    expect(revs(h)).toEqual([1, 2, 3, 4]);
    expect(h.health.at(-1)).toBe(false);
    // A change sends the set again (and fails once more: no new retries).
    h.client.register("announcement:b", () => undefined);
    await advance(h, 20_000);
    expect(revs(h)).toEqual([1, 2, 3, 4, 5]);
    // The next hello starts over: a new connection, a new budget.
    FakeEventSource.latest().emit("hello", { connId: "c2", emitFresh: true });
    await advance(h, 0);
    expect(revs(h)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(h.health.at(-1)).toBe(true);
    h.client.stop();
  });

  it("hiding the tab or stop() drops the pending retry", async () => {
    const h = failing([false, false]);
    await advance(h, 0);
    h.setVisible(false);
    await advance(h, 60_000);
    expect(revs(h)).toEqual([1]);
    h.setVisible(true);
    FakeEventSource.latest().emit("hello", { connId: "c2", emitFresh: true });
    await advance(h, 0);
    expect(revs(h)).toEqual([1, 2]);
    h.client.stop();
    expect(vi.getTimerCount()).toBe(0);
    await advance(h, 60_000);
    expect(revs(h)).toEqual([1, 2]);
  });
});

describe("a web from before LF05 (a web-only rollback with this bundle open)", () => {
  /** A started client whose stream said the old hello (no emitFresh). */
  function legacyStream(h: Harness) {
    h.client.start();
    const source = FakeEventSource.latest();
    source.emit("hello", { connId: "old-1" });
    return source;
  }

  it("sends the change in the add/remove body its route knows, never the set body", async () => {
    const h = harness();
    const dropA = h.client.register("announcement:a", () => undefined);
    h.client.register("announcement:b", () => undefined);
    legacyStream(h);
    await advance(h, 0);
    expect(h.posts).toEqual([
      {
        url: "/live/subscribe",
        body: { connId: "old-1", add: ["announcement:a", "announcement:b"], remove: [] },
      },
    ]);
    // Only the difference to what this connection was sent.
    dropA();
    h.client.register("wiki-page:w", () => undefined);
    await advance(h, 0);
    expect(h.posts.at(-1)?.body).toEqual({
      connId: "old-1",
      add: ["wiki-page:w"],
      remove: ["announcement:a"],
    });
    expect(h.posts).toHaveLength(2);
    // Its hello and hb count as fresh.
    expect(h.health).toEqual([true]);
    h.client.stop();
  });

  it("chunks a big change at 100 channels per list", async () => {
    const h = harness();
    for (let i = 0; i < 150; i += 1) h.client.register(`announcement:a${i}`, () => undefined);
    legacyStream(h);
    await advance(h, 0);
    const bodies = h.posts.map((post) => post.body as AddRemoveSubscribeRequest);
    expect(bodies.map((body) => [body.add.length, body.remove.length])).toEqual([
      [100, 0],
      [50, 0],
    ]);
    h.client.stop();
  });

  it("after a POST it did not take, adds the whole set again", async () => {
    const h = harness();
    let accept = false;
    h.deps.post = async (url, body) => {
      h.posts.push({ url, body });
      return accept;
    };
    h.client.register("announcement:a", () => undefined);
    legacyStream(h);
    await advance(h, 0);
    accept = true;
    h.client.register("announcement:b", () => undefined);
    await advance(h, 0);
    expect(h.posts.map((post) => post.body)).toEqual([
      { connId: "old-1", add: ["announcement:a"], remove: [] },
      { connId: "old-1", add: ["announcement:a", "announcement:b"], remove: [] },
    ]);
    h.client.stop();
  });

  it("a connection to a current web gets the set body again", async () => {
    const h = harness();
    h.client.register("announcement:a", () => undefined);
    const source = legacyStream(h);
    await advance(h, 3_000);
    source.fail();
    await advance(h, 750);
    FakeEventSource.latest().emit("hello", { connId: "new-1", emitFresh: true });
    await advance(h, 0);
    expect(h.posts.map((post) => post.body)).toEqual([
      { connId: "old-1", add: ["announcement:a"], remove: [] },
      { connId: "new-1", rev: 1, channels: ["announcement:a"] },
    ]);
    h.client.stop();
  });
});

describe("start and stop (the provider's effect)", () => {
  it("stop() closes the stream, removes the visibility listener and every timer", async () => {
    const h = harness();
    h.client.start();
    const source = FakeEventSource.latest();
    source.emit("hello", { connId: "c1", emitFresh: true });
    source.emit("ping", { type: "notification" });
    h.client.stop();
    expect(source.closed).toBe(true);
    expect(h.visibilityListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.health.at(-1)).toBe(false);
  });

  it("a second start() is a no-op, and start() after stop() opens again (StrictMode's double effect)", () => {
    const h = harness();
    h.client.start();
    h.client.start();
    expect(FakeEventSource.instances).toHaveLength(1);
    h.client.stop();
    h.client.stop();
    h.client.start();
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.open()).toHaveLength(1);
    expect(h.visibilityListeners.size).toBe(1);
    h.client.stop();
  });

  it("opens nothing on start() while the tab is hidden", () => {
    const h = harness();
    h.setVisible(false);
    h.client.start();
    expect(FakeEventSource.instances).toEqual([]);
    h.client.stop();
  });

  it("register() is stable, so a consumer's effect does not re-run per render", () => {
    const h = harness();
    const { register } = h.client;
    expect(h.client.register).toBe(register);
  });
});
