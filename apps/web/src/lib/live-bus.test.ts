import { afterEach, describe, expect, it } from "vitest";

import { getLiveBus, parseLiveEvents, type LiveFrame } from "./live-bus";
import { MAX_EVENTS_PER_EMIT, channelFor, type ByeReason } from "./live-contract";

type TestConn = {
  id: string;
  userId: number;
  frames: LiveFrame[];
  closed: boolean;
  /** The reason the bus closed it with (the stream's terminal bye), if any. */
  bye: ByeReason | undefined;
};

function connect(
  overrides: Partial<{
    id: string;
    userId: number;
    channels: string[];
    broken: boolean;
    openedAt: number;
  }> = {},
): TestConn {
  const conn: TestConn = {
    id: overrides.id ?? crypto.randomUUID(),
    userId: overrides.userId ?? 1,
    frames: [],
    closed: false,
    bye: undefined,
  };
  getLiveBus().register({
    id: conn.id,
    userId: conn.userId,
    channels: new Set(overrides.channels ?? []),
    openedAt: overrides.openedAt ?? Date.now(),
    enqueue: (frame) => {
      if (overrides.broken) return false;
      conn.frames.push(frame);
      return true;
    },
    close: (reason) => {
      conn.closed = true;
      conn.bye = reason;
    },
  });
  return conn;
}

afterEach(() => {
  getLiveBus().closeAll();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__sinnlosLiveBus;
});

describe("live-bus singleton", () => {
  it("is pinned on globalThis — two import-layer lookups share one instance", () => {
    // The Turbopack layer-duplication landmine (login-rate-limit.ts P1.5):
    // simulate a second module registry by calling the factory twice and
    // asserting the registered connection is visible to "both layers".
    const first = getLiveBus();
    connect({ userId: 7 });
    const second = getLiveBus();
    expect(second).toBe(first);
    expect(second.connectionCount()).toBe(1);
  });
});

describe("delivery filtering", () => {
  it("delivers content pings only to subscribed connections", () => {
    const subscribed = connect({ userId: 1, channels: ["announcement:abc"] });
    const other = connect({ userId: 2, channels: ["announcement:zzz"] });
    const bare = connect({ userId: 3 });

    getLiveBus().publish([
      { kind: "content", targetType: "announcement", targetDocumentId: "abc" },
    ]);

    expect(subscribed.frames).toEqual([{ type: "content", channel: "announcement:abc" }]);
    expect(other.frames).toEqual([]);
    expect(bare.frames).toEqual([]);
  });

  it("delivers notification pings only to the recipient's connections", () => {
    const mine = connect({ userId: 42 });
    const notMine = connect({ userId: 43 });

    getLiveBus().publish([{ kind: "notification", recipientId: 42 }]);

    expect(mine.frames).toEqual([{ type: "notification" }]);
    expect(notMine.frames).toEqual([]);
  });

  it("broadcasts announcements pings to every connection", () => {
    const a = connect({ userId: 1 });
    const b = connect({ userId: 2 });

    getLiveBus().publish([{ kind: "announcements" }]);

    expect(a.frames).toEqual([{ type: "announcements" }]);
    expect(b.frames).toEqual([{ type: "announcements" }]);
  });

  it("addresses content pings by the contract's channel name", () => {
    const channel = channelFor({ targetType: "wiki-page", targetDocumentId: "doc-w" });
    expect(channel).toBe("wiki-page:doc-w");
    const conn = connect({ userId: 1, channels: [channel ?? ""] });
    getLiveBus().publish([{ kind: "content", targetType: "wiki-page", targetDocumentId: "doc-w" }]);
    expect(conn.frames).toEqual([{ type: "content", channel: "wiki-page:doc-w" }]);
  });

  it("delivers a content event without a valid channel to nobody", () => {
    // Channel-shaped strings a connection could hold, but no valid target.
    const conn = connect({ userId: 1, channels: ["event:abc", "announcement:a b"] });
    getLiveBus().publish([
      { kind: "content", targetType: "event", targetDocumentId: "abc" },
      { kind: "content", targetType: "announcement", targetDocumentId: "a b" },
    ]);
    expect(conn.frames).toEqual([]);
  });

  it("drops a connection whose enqueue fails", () => {
    connect({ userId: 1, broken: true });
    expect(getLiveBus().connectionCount()).toBe(1);
    getLiveBus().publish([{ kind: "announcements" }]);
    expect(getLiveBus().connectionCount()).toBe(0);
  });
});

describe("subscription ownership", () => {
  it("rejects subscribe calls for a foreign connId", () => {
    const conn = connect({ userId: 1 });
    expect(getLiveBus().subscribe(conn.id, 999, ["announcement:abc"], [])).toBe(false);
    getLiveBus().publish([
      { kind: "content", targetType: "announcement", targetDocumentId: "abc" },
    ]);
    expect(conn.frames).toEqual([]);
  });

  it("applies add/remove for the owner", () => {
    const conn = connect({ userId: 1 });
    expect(getLiveBus().subscribe(conn.id, 1, ["announcement:abc"], [])).toBe(true);
    getLiveBus().publish([
      { kind: "content", targetType: "announcement", targetDocumentId: "abc" },
    ]);
    expect(conn.frames).toHaveLength(1);

    expect(getLiveBus().subscribe(conn.id, 1, [], ["announcement:abc"])).toBe(true);
    getLiveBus().publish([
      { kind: "content", targetType: "announcement", targetDocumentId: "abc" },
    ]);
    expect(conn.frames).toHaveLength(1);
  });
});

describe("connection caps", () => {
  it("evicts the user's OLDEST connection at the per-user cap", () => {
    const conns = Array.from({ length: 5 }, (_, i) => connect({ userId: 1, openedAt: 1000 + i }));
    const sixth = connect({ userId: 1, openedAt: 9999 });

    expect(conns[0].closed).toBe(true);
    expect(conns.slice(1).every((c) => !c.closed)).toBe(true);
    expect(sixth.closed).toBe(false);
    expect(getLiveBus().connectionCount()).toBe(5);
  });

  it("tells the evicted stream why (bye evicted), so its tab does not evict the next one (LF05)", () => {
    const first = connect({ userId: 1, openedAt: 1 });
    for (let i = 0; i < 5; i += 1) connect({ userId: 1, openedAt: 2 + i });
    expect(first.bye).toBe("evicted");
  });

  it("evicts the oldest connection of anyone at the total cap, with bye evicted", () => {
    const oldest = connect({ userId: 1, openedAt: 1 });
    for (let i = 0; i < 499; i += 1) connect({ userId: 100 + i, openedAt: 2 + i });
    expect(getLiveBus().connectionCount()).toBe(500);
    const newcomer = connect({ userId: 9999, openedAt: 10_000 });
    expect(oldest.bye).toBe("evicted");
    expect(newcomer.closed).toBe(false);
    expect(getLiveBus().connectionCount()).toBe(500);
  });
});

describe("shutdown", () => {
  it("registers its SIGTERM/SIGINT hook once per process, not once per bus", () => {
    connect({ userId: 1 });
    const hooks = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];
    getLiveBus().closeAll();
    delete globalThis.__sinnlosLiveBus;
    connect({ userId: 1 });
    expect([process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")]).toEqual(hooks);
  });

  it("closes every stream with bye shutdown (the deploy's SIGTERM)", () => {
    const a = connect({ userId: 1 });
    const b = connect({ userId: 2 });
    getLiveBus().closeAll();
    expect([a.bye, b.bye]).toEqual(["shutdown", "shutdown"]);
    expect(getLiveBus().connectionCount()).toBe(0);
  });
});

describe("parseLiveEvents", () => {
  it("accepts the three event shapes", () => {
    expect(
      parseLiveEvents({
        events: [
          { kind: "content", targetType: "announcement", targetDocumentId: "abc" },
          { kind: "notification", recipientId: 5 },
          { kind: "announcements" },
        ],
      }),
    ).toHaveLength(3);
  });

  it("accepts up to MAX_EVENTS_PER_EMIT events and refuses one more (the cms chunks, LF01)", () => {
    const events = (n: number) => Array.from({ length: n }, () => ({ kind: "announcements" }));
    expect(parseLiveEvents({ events: events(MAX_EVENTS_PER_EMIT) })).toHaveLength(1000);
    expect(parseLiveEvents({ events: events(MAX_EVENTS_PER_EMIT + 1) })).toBeNull();
  });

  it.each([
    [null],
    [{}],
    [{ events: [] }],
    [{ events: [{ kind: "content", targetType: "announcement" }] }],
    [{ events: [{ kind: "notification", recipientId: "5" }] }],
    [{ events: [{ kind: "unknown" }] }],
  ])("rejects malformed payload %#", (payload) => {
    expect(parseLiveEvents(payload)).toBeNull();
  });
});
