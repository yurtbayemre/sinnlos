import { afterEach, describe, expect, it } from "vitest";

import { getLiveBus, parseLiveEvents, type LiveFrame } from "./live-bus";

type TestConn = {
  id: string;
  userId: number;
  frames: LiveFrame[];
  closed: boolean;
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
    close: () => {
      conn.closed = true;
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
