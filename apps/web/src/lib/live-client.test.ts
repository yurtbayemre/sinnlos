import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeEventSource } from "@/components/live/fake-browser.test.helper";
import { LiveClient, type LiveClientDeps } from "./live-client";

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
      return undefined;
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
    FakeEventSource.latest().emit("hello", { connId: "c1" });
    await Promise.resolve();
    expect(h.health).toEqual([true]);
    expect(h.posts).toEqual([
      { url: "/live/subscribe", body: { connId: "c1", add: ["announcement:a"], remove: [] } },
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
    source.emit("hello", { connId: "c1" });
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
    FakeEventSource.latest().emit("hello", { connId: "c2" });
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

describe("start and stop (the provider's effect)", () => {
  it("stop() closes the stream, removes the visibility listener and every timer", async () => {
    const h = harness();
    h.client.start();
    const source = FakeEventSource.latest();
    source.emit("hello", { connId: "c1" });
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
