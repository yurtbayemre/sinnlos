import { createElement, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveChannel } from "@/lib/live-contract";
import { FakeEventSource, installFakeBrowser, type FakeBrowser } from "./fake-browser.test.helper";
import {
  LiveEventsProvider,
  useLiveChannel,
  useLiveRegistry,
  type LiveContextValue,
} from "./live-events-provider";

/**
 * Characterisation of the LiveEventsProvider's connection state machine
 * (LF05), driven through React with fake timers, a fake EventSource and a
 * fake document (fake-browser.test.helper.ts): the jittered backoff, the
 * stop after five instant closes and its five-minute self-heal, the 65 s
 * heartbeat watchdog, the hidden-tab teardown, the catch-up queue
 * (notifications first, two at a time), the ping coalescing with its
 * single-flight refetch, and the once-per-tick subscription sync (WD04).
 * These pinned the behaviour the extraction into lib/live-client.ts kept;
 * the LF05 changes since (the full channel set with a revision, …) are
 * pinned here and in lib/live-client.test.ts.
 *
 * Math.random is fixed per test, so every jittered delay is exact.
 */

let browser: FakeBrowser;
let registry: LiveContextValue;

/** Hands the provider's context to the test after every provider render. */
function ExposeRegistry() {
  const value = useLiveRegistry();
  useEffect(() => {
    registry = value;
  }, [value]);
  return null;
}

/** One useLiveChannel consumer (the bell's and the announcements hint's hook). */
function Channel({ channel, onPing }: { channel: LiveChannel; onPing: () => unknown }) {
  useLiveChannel(channel, async () => {
    await onPing();
  });
  return null;
}

async function mount(children: ReactNode = null, enabled = true) {
  await browser.render(
    // eslint-disable-next-line react/no-children-prop -- a .test.ts has no JSX, and createElement's types want the provider's required children in the props
    createElement(LiveEventsProvider, {
      enabled,
      children: [createElement(ExposeRegistry, { key: "registry" }), children],
    }),
  );
}

const advance = (ms: number) => browser.act(() => vi.advanceTimersByTimeAsync(ms).then(() => {}));

async function hello(source: FakeEventSource, connId = "conn-1") {
  await browser.act(() => source.emit("hello", { connId, emitFresh: true }));
}

/** The subscribe POSTs so far (LiveSubscribeRequest bodies). */
function subscribeBodies() {
  return browser.calls
    .filter((call) => call.url === "/live/subscribe")
    .map((call) => call.body as { connId: string; rev: number; channels: string[] });
}

/** The status /live/subscribe answers with. */
let subscribeStatus = 200;

/** A listener whose calls the test resolves one by one. */
function deferredListener(log: string[], name: string) {
  const pending: (() => void)[] = [];
  return {
    pending,
    fn: () =>
      new Promise<void>((resolve) => {
        log.push(`start ${name}`);
        pending.push(() => {
          log.push(`end ${name}`);
          resolve();
        });
      }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  subscribeStatus = 200;
  browser = installFakeBrowser(async () => Response.json({}, { status: subscribeStatus }));
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await browser.unmount();
  browser.uninstall();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("connection", () => {
  it("opens one stream on mount and is healthy once the hello arrives", async () => {
    await mount();
    expect(FakeEventSource.instances.map((source) => source.url)).toEqual(["/live/stream"]);
    expect(registry.healthy).toBe(false);
    expect(registry.streaming).toBe(true);
    await hello(FakeEventSource.latest());
    expect(registry.healthy).toBe(true);
  });

  it("reports degraded while the stream says the cms leg is not fresh (LF05)", async () => {
    await mount();
    const source = FakeEventSource.latest();
    await browser.act(() => source.emit("hello", { connId: "conn-1", emitFresh: false }));
    expect(registry.healthy).toBe(false);
    await browser.act(() => source.emit("hb", { emitFresh: true }));
    expect(registry.healthy).toBe(true);
    await browser.act(() => source.emit("hb", { emitFresh: false }));
    expect(registry.healthy).toBe(false);
  });

  it("opens nothing when disabled (LIVE_EVENTS_DISABLED, DEMO_MODE)", async () => {
    await mount(null, false);
    await advance(10 * 60_000);
    expect(FakeEventSource.instances).toEqual([]);
    expect(registry).toMatchObject({ healthy: false, streaming: false });
  });

  it("opens nothing while the tab is hidden, and opens on the next visibility", async () => {
    browser.document.visibilityState = "hidden";
    await mount();
    expect(FakeEventSource.instances).toEqual([]);
    await browser.setVisibility("visible");
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("closes the stream and leaves no timer behind on unmount", async () => {
    await mount();
    const source = FakeEventSource.latest();
    await hello(source);
    await browser.unmount();
    expect(source.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves a network drop (CONNECTING) to the browser's own retry", async () => {
    await mount();
    const source = FakeEventSource.latest();
    await hello(source);
    await browser.act(() => source.fail(FakeEventSource.CONNECTING));
    expect(registry.healthy).toBe(false);
    expect(source.closed).toBe(false);
    await advance(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    // The browser reconnected the same source: healthy again.
    await hello(source, "conn-2");
    expect(registry.healthy).toBe(true);
  });
});

describe("reconnect backoff", () => {
  /** Opens the current source, lets it live `lifetimeMs`, then closes it for good. */
  async function dies(lifetimeMs: number) {
    const source = FakeEventSource.latest();
    await advance(lifetimeMs);
    await browser.act(() => source.fail());
    return source;
  }

  it("reconnects after base/2 + random·base, doubling from 1.5 s up to 60 s", async () => {
    await mount();
    // No hello in between: the attempt counter keeps climbing.
    const delays = [750, 1500, 3000, 6000, 12_000, 24_000, 30_000, 30_000];
    for (const delay of delays) {
      const before = FakeEventSource.instances.length;
      const source = await dies(3_000);
      expect(source.closed).toBe(true);
      expect(registry.healthy).toBe(false);
      await advance(delay - 1);
      expect(FakeEventSource.instances).toHaveLength(before);
      await advance(1);
      expect(FakeEventSource.instances).toHaveLength(before + 1);
    }
  });

  it("jitters by up to one base: random 0.999 waits almost 1.5 bases", async () => {
    vi.mocked(Math.random).mockReturnValue(0.999);
    await mount();
    await dies(3_000);
    // 750 + 0.999·1500 = 2248.5 ms; the fake clock truncates like browsers do.
    await advance(2_247);
    expect(FakeEventSource.instances).toHaveLength(1);
    await advance(1);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("a hello resets the backoff", async () => {
    await mount();
    await dies(3_000);
    await advance(750);
    await dies(3_000);
    await advance(1_500);
    await hello(FakeEventSource.latest());
    await dies(3_000);
    await advance(750);
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it("spreads the reopen of a stable stream (over 60 s) by up to 15 s more", async () => {
    vi.mocked(Math.random).mockReturnValue(0.5);
    await mount();
    await hello(FakeEventSource.latest());
    // Heartbeats keep the watchdog quiet for the 61 s.
    for (let i = 0; i < 3; i += 1) {
      await advance(20_000);
      await browser.act(() => FakeEventSource.latest().emit("hb", "1"));
    }
    await dies(1_000);
    // 750 + 0.5·1500 + 0.5·15 000
    await advance(9_000 - 1);
    expect(FakeEventSource.instances).toHaveLength(1);
    await advance(1);
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});

describe("terminal stop after five instant closes", () => {
  async function instantClose() {
    await browser.act(() => FakeEventSource.latest().fail());
  }

  it("stops after the fifth close within 2 s of opening", async () => {
    await mount();
    for (const delay of [750, 1500, 3000, 6000]) {
      await instantClose();
      await advance(delay);
    }
    expect(FakeEventSource.instances).toHaveLength(5);
    await instantClose();
    await advance(4 * 60_000);
    expect(FakeEventSource.instances).toHaveLength(5);
  });

  it("a close after 2 s or more resets the count", async () => {
    await mount();
    for (const delay of [750, 1500, 3000, 6000]) {
      await instantClose();
      await advance(delay);
    }
    await advance(2_000);
    await instantClose(); // lived 2 s: not instant
    await advance(12_000);
    await instantClose();
    await advance(24_000);
    expect(FakeEventSource.instances).toHaveLength(7);
  });

  it("self-heals with one fresh attempt five minutes later while visible", async () => {
    await mount();
    for (const delay of [750, 1500, 3000, 6000]) {
      await instantClose();
      await advance(delay);
    }
    // The watchdog ticks every 20 s from the mount (t = 0); the stop happens
    // at t = 11.25 s, and the first tick more than 5 min later is t = 320 s.
    await instantClose();
    await advance(320_000 - 11_250 - 1);
    expect(FakeEventSource.instances).toHaveLength(5);
    await advance(1);
    expect(FakeEventSource.instances).toHaveLength(6);
  });

  it("a visibility regain restarts at once", async () => {
    await mount();
    for (const delay of [750, 1500, 3000, 6000]) {
      await instantClose();
      await advance(delay);
    }
    await instantClose();
    await browser.setVisibility("hidden");
    await browser.setVisibility("visible");
    expect(FakeEventSource.instances).toHaveLength(6);
  });
});

describe("heartbeat watchdog", () => {
  it("reopens a stream that sent nothing for more than 65 s (checked every 20 s)", async () => {
    await mount();
    const source = FakeEventSource.latest();
    await hello(source);
    await advance(60_000);
    expect(source.closed).toBe(false);
    await advance(20_000); // t = 80 s: 80 s since the hello
    expect(source.closed).toBe(true);
    expect(registry.healthy).toBe(false);
    // Jittered like a stable stream's reopen: 750 + 0 + 0 with random 0.
    await advance(749);
    expect(FakeEventSource.instances).toHaveLength(1);
    await advance(1);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("every hb and ping counts as a beat", async () => {
    await mount();
    const source = FakeEventSource.latest();
    await hello(source);
    await advance(50_000);
    await browser.act(() => source.emit("hb", "1"));
    await advance(50_000);
    await browser.act(() => source.emit("ping", { type: "content", channel: "announcement:a" }));
    await advance(60_000);
    expect(source.closed).toBe(false);
    await advance(20_000);
    expect(source.closed).toBe(true);
  });
});

describe("hidden tab", () => {
  it("closes the stream, drops pending dispatches and reconnects, and opens again when visible", async () => {
    const calls: string[] = [];
    await mount(
      createElement(Channel, { channel: "notifications", onPing: () => calls.push("n") }),
    );
    const source = FakeEventSource.latest();
    await hello(source);
    await browser.act(() => source.emit("ping", { type: "notification" }));
    await browser.setVisibility("hidden");
    expect(source.closed).toBe(true);
    expect(registry.healthy).toBe(false);
    await advance(10 * 60_000);
    expect(calls).toEqual([]);
    expect(FakeEventSource.instances).toHaveLength(1);

    await browser.setVisibility("visible");
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("cancels a pending reconnect", async () => {
    await mount();
    await advance(3_000);
    await browser.act(() => FakeEventSource.latest().fail());
    await browser.setVisibility("hidden");
    await advance(10 * 60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

describe("pings", () => {
  it("coalesces a content channel's pings for 150 ms into one refetch (LF05, was 400 ms)", async () => {
    const calls: string[] = [];
    await mount(
      createElement(Channel, { channel: "announcement:a", onPing: () => calls.push("a") }),
    );
    const source = FakeEventSource.latest();
    await hello(source);
    const ping = { type: "content", channel: "announcement:a" };
    await browser.act(() => source.emit("ping", ping));
    await advance(100);
    await browser.act(() => source.emit("ping", ping));
    await advance(49);
    expect(calls).toEqual([]);
    await advance(1);
    expect(calls).toEqual(["a"]);
  });

  it("adds up to 1 s of jitter for notifications and 4 s for announcements (LF05, was 3 s and 10 s)", async () => {
    vi.mocked(Math.random).mockReturnValue(0.5);
    const calls: string[] = [];
    await mount([
      createElement(Channel, { key: "n", channel: "notifications", onPing: () => calls.push("n") }),
      createElement(Channel, { key: "a", channel: "announcements", onPing: () => calls.push("a") }),
    ]);
    const source = FakeEventSource.latest();
    await hello(source);
    await browser.act(() => {
      source.emit("ping", { type: "notification" });
      source.emit("ping", { type: "announcements" });
    });
    // 150 + 0.5·1000 and 150 + 0.5·4000
    await advance(649);
    expect(calls).toEqual([]);
    await advance(1);
    expect(calls).toEqual(["n"]);
    await advance(2_150 - 650 - 1);
    expect(calls).toEqual(["n"]);
    await advance(1);
    expect(calls).toEqual(["n", "a"]);
  });

  it("ignores malformed frames", async () => {
    const calls: string[] = [];
    await mount(
      createElement(Channel, { channel: "announcement:a", onPing: () => calls.push("a") }),
    );
    const source = FakeEventSource.latest();
    await hello(source);
    await browser.act(() => {
      source.emit("ping", "not json");
      source.emit("ping", { type: "content", channel: "announcements" });
      source.emit("ping", { type: "unknown" });
    });
    await advance(60_000);
    expect(calls).toEqual([]);
  });

  it("runs a channel single-flight: pings during a refetch cause exactly one more", async () => {
    const log: string[] = [];
    const listener = deferredListener(log, "a");
    await mount(createElement(Channel, { channel: "announcement:a", onPing: listener.fn }));
    const source = FakeEventSource.latest();
    await hello(source);
    const ping = () => source.emit("ping", { type: "content", channel: "announcement:a" });
    await browser.act(ping);
    await advance(400);
    expect(log).toEqual(["start a"]);
    for (let i = 0; i < 3; i += 1) {
      await browser.act(ping);
      await advance(400);
    }
    expect(log).toEqual(["start a"]);
    await browser.act(() => listener.pending.shift()?.());
    expect(log).toEqual(["start a", "end a", "start a"]);
    await browser.act(() => listener.pending.shift()?.());
    expect(log).toEqual(["start a", "end a", "start a", "end a"]);
  });
});

describe("catch-up after a reconnect", () => {
  it("skips the first hello, then refetches every channel once: notifications first, two at a time", async () => {
    const log: string[] = [];
    const listeners = {
      "announcement:a": deferredListener(log, "a"),
      notifications: deferredListener(log, "n"),
      "wiki-page:w": deferredListener(log, "w"),
      announcements: deferredListener(log, "ann"),
    };
    await mount(
      Object.entries(listeners).map(([channel, listener]) =>
        createElement(Channel, {
          key: channel,
          channel: channel as LiveChannel,
          onPing: listener.fn,
        }),
      ),
    );
    await hello(FakeEventSource.latest());
    expect(log).toEqual([]);

    await advance(3_000);
    await browser.act(() => FakeEventSource.latest().fail());
    await advance(750);
    await hello(FakeEventSource.latest(), "conn-2");
    expect(log).toEqual(["start n", "start a"]);
    await browser.act(() => listeners["announcement:a"].pending.shift()?.());
    expect(log).toEqual(["start n", "start a", "end a", "start w"]);
    await browser.act(() => listeners.notifications.pending.shift()?.());
    expect(log).toEqual(["start n", "start a", "end a", "start w", "end n", "start ann"]);
    await browser.act(() => {
      listeners["wiki-page:w"].pending.shift()?.();
      listeners.announcements.pending.shift()?.();
    });
    expect(log.filter((entry) => entry.startsWith("start"))).toHaveLength(4);
  });

  it("a visibility regain runs one catch-up per channel (the reopen's hello), not two", async () => {
    const calls: string[] = [];
    await mount([
      createElement(Channel, { key: "n", channel: "notifications", onPing: () => calls.push("n") }),
      createElement(Channel, {
        key: "a",
        channel: "announcement:a",
        onPing: () => calls.push("a"),
      }),
    ]);
    await hello(FakeEventSource.latest());
    await browser.setVisibility("hidden");
    await browser.setVisibility("visible");
    expect(calls).toEqual([]);
    await hello(FakeEventSource.latest(), "conn-2");
    await advance(60_000);
    expect(calls).toEqual(["n", "a"]);
  });

  it("a browser-side reconnect (the same source's second hello) catches up as well", async () => {
    const calls: string[] = [];
    await mount(
      createElement(Channel, { channel: "notifications", onPing: () => calls.push("n") }),
    );
    const source = FakeEventSource.latest();
    await hello(source);
    await browser.act(() => source.fail(FakeEventSource.CONNECTING));
    await hello(source, "conn-2");
    expect(calls).toEqual(["n"]);
  });
});

describe("subscription sync (WD04, LF05: the full set with a revision)", () => {
  const noop = () => undefined;

  it("sends nothing before the hello, then every content channel in one POST", async () => {
    await mount([
      createElement(Channel, { key: "1", channel: "announcement:a", onPing: noop }),
      createElement(Channel, { key: "2", channel: "wiki-page:w", onPing: noop }),
      createElement(Channel, { key: "3", channel: "notifications", onPing: noop }),
    ]);
    expect(subscribeBodies()).toEqual([]);
    await hello(FakeEventSource.latest());
    expect(subscribeBodies()).toEqual([
      { connId: "conn-1", rev: 1, channels: ["announcement:a", "wiki-page:w"] },
    ]);
  });

  it("sends the whole set once per tick, with the next revision", async () => {
    await mount();
    await hello(FakeEventSource.latest());
    let removeA = noop as () => void;
    await browser.act(() => {
      removeA = registry.register("announcement:a", noop);
      registry.register("announcement:b", noop);
      registry.register("notifications", noop);
    });
    await browser.act(() => {
      removeA();
      registry.register("wiki-page:w", noop);
    });
    expect(subscribeBodies()).toEqual([
      { connId: "conn-1", rev: 1, channels: ["announcement:a", "announcement:b"] },
      { connId: "conn-1", rev: 2, channels: ["announcement:b", "wiki-page:w"] },
    ]);
  });

  it("sends nothing when a tick leaves the set as it was", async () => {
    await mount();
    await hello(FakeEventSource.latest());
    await browser.act(() => {
      const remove = registry.register("announcement:a", noop);
      remove();
    });
    await browser.act(() => {
      registry.register("notifications", noop);
    });
    expect(subscribeBodies()).toEqual([]);
  });

  it("subscribes a channel with its first listener and drops it with its last", async () => {
    await mount();
    await hello(FakeEventSource.latest());
    let first = noop as () => void;
    let second = noop as () => void;
    await browser.act(() => {
      first = registry.register("announcement:a", () => undefined);
    });
    await browser.act(() => {
      second = registry.register("announcement:a", () => undefined);
    });
    await browser.act(() => first());
    expect(subscribeBodies()).toHaveLength(1);
    await browser.act(() => second());
    expect(subscribeBodies().at(-1)).toEqual({ connId: "conn-1", rev: 2, channels: [] });
  });

  it("splits a set of more than 100 into POSTs of the same revision", async () => {
    await mount();
    await hello(FakeEventSource.latest());
    await browser.act(() => {
      for (let i = 0; i < 250; i += 1) registry.register(`announcement:doc-${i}`, noop);
    });
    const bodies = subscribeBodies();
    expect(bodies.map((body) => body.channels.length)).toEqual([100, 100, 50]);
    expect(bodies.map((body) => body.rev)).toEqual([1, 1, 1]);
    expect(new Set(bodies.flatMap((body) => body.channels)).size).toBe(250);
  });

  it("sends the set to each new connection, the revision still counting up", async () => {
    await mount(createElement(Channel, { channel: "announcement:a", onPing: noop }));
    await hello(FakeEventSource.latest());
    await advance(3_000);
    await browser.act(() => FakeEventSource.latest().fail());
    await advance(750);
    await hello(FakeEventSource.latest(), "conn-2");
    expect(subscribeBodies()).toEqual([
      { connId: "conn-1", rev: 1, channels: ["announcement:a"] },
      { connId: "conn-2", rev: 2, channels: ["announcement:a"] },
    ]);
  });

  it("sends the set again after a POST the server did not take", async () => {
    await mount(createElement(Channel, { channel: "announcement:a", onPing: noop }));
    subscribeStatus = 404;
    await hello(FakeEventSource.latest());
    subscribeStatus = 200;
    // The same set: normally skipped, but the last POST was refused.
    await browser.act(() => {
      registry.register("announcement:a", () => undefined);
      registry.register("notifications", noop);
      registry.register("announcement:b", noop)();
    });
    expect(subscribeBodies()).toEqual([
      { connId: "conn-1", rev: 1, channels: ["announcement:a"] },
      { connId: "conn-1", rev: 2, channels: ["announcement:a"] },
    ]);
  });
});
