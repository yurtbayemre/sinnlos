import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStrapiStub, type StrapiStub } from "../test/strapi-stub.test.helper";
import { LIVE_KEEPALIVE_MS, MAX_EVENTS_PER_EMIT } from "./live-contract";
import {
  __flushLiveEventsForTest,
  emitLiveEvent,
  registerLiveEventSubscriber,
  startLiveKeepalive,
  stopLiveKeepalive,
  type LiveEvent,
} from "./live-events";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 204 });
  process.env.WEB_INTERNAL_URL = "http://web:3000";
  process.env.REVALIDATE_SECRET = "test-secret";
  delete process.env.LIVE_EVENTS_DISABLED;
});

afterEach(async () => {
  await __flushLiveEventsForTest();
  stopLiveKeepalive();
  vi.unstubAllGlobals();
});

describe("emitLiveEvent batching", () => {
  it("collapses a burst into ONE POST and dedupes per channel", async () => {
    // The announcement fan-out shape: one announcements ping + N
    // notification rows + repeated pings for the same comment channel.
    emitLiveEvent({ kind: "announcements" });
    emitLiveEvent({ kind: "notification", recipientId: 1 });
    emitLiveEvent({ kind: "notification", recipientId: 2 });
    emitLiveEvent({ kind: "notification", recipientId: 1 }); // dupe
    emitLiveEvent({ kind: "content", targetType: "announcement", targetDocumentId: "abc" });
    emitLiveEvent({ kind: "content", targetType: "announcement", targetDocumentId: "abc" }); // dupe

    await __flushLiveEventsForTest();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://web:3000/api/live/emit");
    expect(init.headers["x-revalidate-secret"]).toBe("test-secret");
    const { events } = JSON.parse(init.body);
    expect(events).toHaveLength(4);
  });

  it("sends a burst of more than 1000 events in POSTs of at most 1000, in order (LF01)", async () => {
    // The web refuses a list longer than MAX_EVENTS_PER_EMIT with 400
    // (lib/live-bus.ts parseLiveEvents), which used to lose the whole burst.
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    for (let recipientId = 1; recipientId <= 2500; recipientId += 1) {
      emitLiveEvent({ kind: "notification", recipientId });
    }
    emitLiveEvent({ kind: "announcements" });
    await __flushLiveEventsForTest();

    const bodies = fetchMock.mock.calls.map(
      ([, init]) => (JSON.parse((init as { body: string }).body) as { events: LiveEvent[] }).events,
    );
    expect(bodies.map((events) => events.length)).toEqual([MAX_EVENTS_PER_EMIT, 1000, 501]);
    const sent = bodies.flat();
    expect(sent[0]).toEqual({ kind: "notification", recipientId: 1 });
    expect(sent[2499]).toEqual({ kind: "notification", recipientId: 2500 });
    expect(sent[2500]).toEqual({ kind: "announcements" });
    expect(info).toHaveBeenCalledWith("[live-emit] 2501 events in 3 POSTs (at most 1000 each)");
    info.mockRestore();
  });

  it("sends the POSTs one after the other, and a failed one does not stop the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let open = 0;
    let maxOpen = 0;
    fetchMock.mockImplementation(async () => {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open -= 1;
      if (fetchMock.mock.calls.length === 1) throw new Error("ECONNRESET");
      return { ok: true, status: 204 };
    });
    for (let recipientId = 1; recipientId <= 2001; recipientId += 1) {
      emitLiveEvent({ kind: "notification", recipientId });
    }
    await __flushLiveEventsForTest();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(maxOpen).toBe(1);
    expect(warn).toHaveBeenCalledWith("[live-emit] failed (1000 event(s)): ECONNRESET");
    warn.mockRestore();
    info.mockRestore();
  });

  it("sends exactly 1000 events in one POST without the chunk log", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    for (let recipientId = 1; recipientId <= MAX_EVENTS_PER_EMIT; recipientId += 1) {
      emitLiveEvent({ kind: "notification", recipientId });
    }
    await __flushLiveEventsForTest();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("drops a content event whose target has no channel (nobody could subscribe to it)", async () => {
    emitLiveEvent({ kind: "content", targetType: "event", targetDocumentId: "abc" });
    emitLiveEvent({ kind: "content", targetType: "announcement", targetDocumentId: "a b" });
    emitLiveEvent({ kind: "content", targetType: "wiki-page", targetDocumentId: "doc-w" });
    await __flushLiveEventsForTest();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { events } = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(events).toEqual([
      { kind: "content", targetType: "wiki-page", targetDocumentId: "doc-w" },
    ]);
  });

  it("no-ops when WEB_INTERNAL_URL is unset (local dev)", async () => {
    delete process.env.WEB_INTERNAL_URL;
    emitLiveEvent({ kind: "announcements" });
    await __flushLiveEventsForTest();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops when the kill switch is on", async () => {
    process.env.LIVE_EVENTS_DISABLED = "1";
    emitLiveEvent({ kind: "announcements" });
    await __flushLiveEventsForTest();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("warns on non-2xx instead of failing silently", async () => {
    // The proxy.ts-307 failure class: a misroute must be VISIBLE in the
    // cms logs instead of being swallowed.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 307 });
    emitLiveEvent({ kind: "announcements" });
    await __flushLiveEventsForTest();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("status=307"));
    warn.mockRestore();
  });

  it("never throws when the web container is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    emitLiveEvent({ kind: "notification", recipientId: 1 });
    await expect(__flushLiveEventsForTest()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The DB lifecycle subscriber (S08 characterisation)
// ---------------------------------------------------------------------------

/** What registerLiveEventSubscriber hands to strapi.db.lifecycles.subscribe. */
type SubscriberHandler = (event: Record<string, unknown>) => unknown;
type Subscriber = SubscriberHandler | ({ models?: string[] } & Record<string, unknown>);

/**
 * Dispatches one lifecycle event the way @strapi/database 5.55.1 does
 * (lifecycles/index.js run): a function subscriber sees every event, an
 * object subscriber only the actions it defines, on its `models` if set.
 */
async function dispatch(
  subscriber: Subscriber,
  action: string,
  uid: string,
  properties: Record<string, unknown> = {},
): Promise<void> {
  const event = { action, model: { uid }, state: {}, ...properties };
  if (typeof subscriber === "function") {
    await subscriber(event);
    return;
  }
  if (!(action in subscriber)) return;
  if (subscriber.models && !subscriber.models.includes(uid)) return;
  const handler = subscriber[action];
  if (typeof handler === "function") await (handler as SubscriberHandler)(event);
}

interface SubscriberHarness {
  strapi: StrapiStub;
  fire(action: string, uid: string, properties?: Record<string, unknown>): Promise<void>;
  /** Flushes the batch and returns every event POSTed so far. */
  emitted(): Promise<LiveEvent[]>;
}

function subscriberHarness(tables: StrapiStub["tables"] = {}): SubscriberHarness {
  const strapi = createStrapiStub({ tables });
  let subscriber: Subscriber | undefined;
  // Delegates at call time, so a test can swap strapi.db.query afterwards.
  registerLiveEventSubscriber({
    log: strapi.log,
    db: {
      query: (uid: string) => strapi.db.query(uid),
      transaction: strapi.db.transaction,
      inTransaction: strapi.db.inTransaction,
      lifecycles: { subscribe: (s: Subscriber) => (subscriber = s) },
    },
  });
  return {
    strapi,
    async fire(action, uid, properties) {
      if (!subscriber) throw new Error("no subscriber registered");
      await dispatch(subscriber, action, uid, properties);
    },
    async emitted() {
      await __flushLiveEventsForTest();
      return fetchMock.mock.calls.flatMap(
        ([, init]) =>
          (JSON.parse((init as { body: string }).body) as { events: LiveEvent[] }).events,
      );
    },
  };
}

const COMMENT = "api::comment.comment";
const REACTION = "api::reaction.reaction";
const NOTIFICATION = "api::notification.notification";
const ANNOUNCEMENT = "api::announcement.announcement";
const ANCHOR = { targetType: "announcement", targetDocumentId: "a0000000000000000000000b" };
const PUBLISHED = "2026-09-28T08:00:00.000Z";

describe("live subscriber: comments and reactions", () => {
  it("pings the content channel on create, update and delete", async () => {
    const h = subscriberHarness();
    await h.fire("afterCreate", COMMENT, { result: { id: 1, ...ANCHOR } });
    await h.fire("afterUpdate", COMMENT, { result: { id: 1, ...ANCHOR } });
    await h.fire("afterDelete", REACTION, { result: null, params: { data: ANCHOR } });
    expect(await h.emitted()).toEqual([{ kind: "content", ...ANCHOR }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores other actions and rows without an anchor", async () => {
    const h = subscriberHarness();
    for (const action of ["beforeCreate", "afterCreateMany", "afterDeleteMany", "afterFindMany"]) {
      await h.fire(action, COMMENT, { result: { id: 1, ...ANCHOR } });
    }
    await h.fire("afterCreate", REACTION, { result: { id: 2, targetType: "announcement" } });
    expect(await h.emitted()).toEqual([]);
  });
});

describe("live subscriber: notifications", () => {
  it("pings the recipient of a created notification, in every relation shape", async () => {
    const h = subscriberHarness();
    await h.fire("afterCreate", NOTIFICATION, {
      result: { id: 1 },
      params: { data: { recipient: 7 } },
    });
    await h.fire("afterCreate", NOTIFICATION, {
      result: { id: 2 },
      params: { data: { recipient: { set: [{ id: 8 }] } } },
    });
    await h.fire("afterCreate", NOTIFICATION, {
      result: { id: 3 },
      params: { data: { recipient: { connect: [{ id: 9 }] } } },
    });
    await h.fire("afterCreate", NOTIFICATION, { result: { id: 4, recipient: { id: 10 } } });
    expect(await h.emitted()).toEqual(
      [7, 8, 9, 10].map((recipientId) => ({ kind: "notification", recipientId })),
    );
    expect(h.strapi.calls).toEqual([]);
  });

  it("re-reads the recipient when the write did not carry it", async () => {
    const h = subscriberHarness({
      [NOTIFICATION]: [{ id: 5, title: "x", recipient: { id: 11 } }],
    });
    await h.fire("afterCreate", NOTIFICATION, { result: { id: 5 }, params: { data: {} } });
    await h.fire("afterCreate", NOTIFICATION, { result: { id: 6 }, params: { data: {} } });
    expect(await h.emitted()).toEqual([{ kind: "notification", recipientId: 11 }]);
    expect(h.strapi.calls.map((call) => call.method)).toEqual(["findOne", "findOne"]);
  });

  it("ignores updates and deletes (markRead emits from the controller)", async () => {
    const h = subscriberHarness();
    await h.fire("afterUpdate", NOTIFICATION, {
      result: { id: 1 },
      params: { data: { recipient: 7 } },
    });
    await h.fire("afterDelete", NOTIFICATION, { result: { id: 1, recipient: { id: 7 } } });
    await h.fire("afterUpdateMany", NOTIFICATION, { result: { count: 3 } });
    expect(await h.emitted()).toEqual([]);
  });
});

describe("live subscriber: announcements", () => {
  it("pings the list only when a PUBLISHED row is created", async () => {
    const h = subscriberHarness();
    await h.fire("afterCreate", ANNOUNCEMENT, { result: { id: 1, publishedAt: null } });
    await h.fire("afterUpdate", ANNOUNCEMENT, { result: { id: 1, publishedAt: PUBLISHED } });
    await h.fire("afterDelete", ANNOUNCEMENT, { result: { id: 1, publishedAt: PUBLISHED } });
    expect(await h.emitted()).toEqual([]);
    await h.fire("afterCreate", ANNOUNCEMENT, { result: { id: 2, publishedAt: PUBLISHED } });
    expect(await h.emitted()).toEqual([{ kind: "announcements" }]);
  });
});

describe("live subscriber: filtering and failure", () => {
  it("unwatched models never ping and never query", async () => {
    const h = subscriberHarness();
    for (const uid of ["api::poll.poll", "api::kudos.kudos", "api::wiki-page.wiki-page"]) {
      await h.fire("afterCreate", uid, {
        result: { id: 1, publishedAt: PUBLISHED, recipient: { id: 3 }, ...ANCHOR },
      });
    }
    expect(await h.emitted()).toEqual([]);
    expect(h.strapi.calls).toEqual([]);
  });

  it("does nothing while live events are off (no lookup either)", async () => {
    delete process.env.WEB_INTERNAL_URL;
    const h = subscriberHarness();
    await h.fire("afterCreate", NOTIFICATION, { result: { id: 5 }, params: { data: {} } });
    await h.fire("afterCreate", ANNOUNCEMENT, { result: { id: 2, publishedAt: PUBLISHED } });
    expect(await h.emitted()).toEqual([]);
    expect(h.strapi.calls).toEqual([]);
  });

  it("never throws into the write: a failing lookup is a warning", async () => {
    const h = subscriberHarness();
    h.strapi.db.query = () => {
      throw new Error("db down");
    };
    await expect(
      h.fire("afterCreate", NOTIFICATION, { result: { id: 5 }, params: { data: {} } }),
    ).resolves.toBeUndefined();
    expect(h.strapi.log.warn).toHaveBeenCalledWith("[live-emit] subscriber error: db down");
  });
});

describe("live subscriber registration (LF06)", () => {
  it("subscribes in object form: the watched models, three actions", () => {
    const strapi = createStrapiStub();
    let registered: Subscriber | undefined;
    registerLiveEventSubscriber({
      log: strapi.log,
      db: {
        query: (uid: string) => strapi.db.query(uid),
        lifecycles: { subscribe: (s: Subscriber) => (registered = s) },
      },
    });
    if (typeof registered !== "object") throw new Error("expected an object subscriber");
    expect(Object.keys(registered).sort()).toEqual([
      "afterCreate",
      "afterDelete",
      "afterUpdate",
      "models",
    ]);
    expect([...(registered.models ?? [])].sort()).toEqual([
      ANNOUNCEMENT,
      COMMENT,
      NOTIFICATION,
      REACTION,
    ]);
    expect(strapi.log.info).toHaveBeenCalledWith("[live-emit] DB lifecycle subscriber registered");
  });
});

describe("live subscriber: pings go out after the commit (LF02)", () => {
  it("nothing is queued while the write is open; the commit queues the ping", async () => {
    const h = subscriberHarness();
    let queuedBeforeCommit: LiveEvent[] = [{ kind: "announcements" }];
    await h.strapi.db.transaction(async () => {
      await h.fire("afterCreate", ANNOUNCEMENT, { result: { id: 2, publishedAt: PUBLISHED } });
      await h.fire("afterCreate", NOTIFICATION, {
        result: { id: 3 },
        params: { data: { recipient: 7 } },
      });
      queuedBeforeCommit = await h.emitted();
    });
    expect(queuedBeforeCommit).toEqual([]);
    expect(await h.emitted()).toEqual([
      { kind: "announcements" },
      { kind: "notification", recipientId: 7 },
    ]);
  });

  it("a nested transaction defers to the OUTER commit", async () => {
    const h = subscriberHarness();
    let afterInner: LiveEvent[] = [{ kind: "announcements" }];
    await h.strapi.db.transaction(async () => {
      await h.strapi.db.transaction(async () => {
        await h.fire("afterCreate", COMMENT, { result: { id: 1, ...ANCHOR } });
      });
      afterInner = await h.emitted();
    });
    expect(afterInner).toEqual([]);
    expect(await h.emitted()).toEqual([{ kind: "content", ...ANCHOR }]);
  });

  it("a rollback pings nothing", async () => {
    const h = subscriberHarness();
    await expect(
      h.strapi.db.transaction(async () => {
        await h.fire("afterCreate", ANNOUNCEMENT, { result: { id: 2, publishedAt: PUBLISHED } });
        throw new Error("validation failed");
      }),
    ).rejects.toThrow("validation failed");
    expect(await h.emitted()).toEqual([]);
  });

  it("without a transaction the ping is queued right away", async () => {
    const h = subscriberHarness();
    await h.fire("afterCreate", ANNOUNCEMENT, { result: { id: 2, publishedAt: PUBLISHED } });
    expect(h.strapi.db.inTransaction()).toBe(false);
    expect(await h.emitted()).toEqual([{ kind: "announcements" }]);
  });
});

describe("keepalive (LF05)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const keepalives = () =>
    fetchMock.mock.calls.map(([url, init]) => ({
      url,
      secret: (init as { headers: Record<string, string> }).headers["x-revalidate-secret"],
      events: (JSON.parse((init as { body: string }).body) as { events: LiveEvent[] }).events,
    }));

  it("POSTs one keepalive event to the emit endpoint every 20 s", async () => {
    expect(LIVE_KEEPALIVE_MS).toBe(20_000);
    startLiveKeepalive();
    await vi.advanceTimersByTimeAsync(LIVE_KEEPALIVE_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(keepalives()).toEqual([
      {
        url: "http://web:3000/api/live/emit",
        secret: "test-secret",
        events: [{ kind: "keepalive" }],
      },
    ]);
    await vi.advanceTimersByTimeAsync(2 * LIVE_KEEPALIVE_MS);
    expect(keepalives()).toHaveLength(3);
  });

  it("starts with the subscriber, and only once", async () => {
    const strapi = createStrapiStub();
    for (let i = 0; i < 2; i += 1) {
      registerLiveEventSubscriber({
        log: strapi.log,
        db: {
          query: (uid: string) => strapi.db.query(uid),
          lifecycles: { subscribe: () => undefined },
        },
      });
    }
    await vi.advanceTimersByTimeAsync(LIVE_KEEPALIVE_MS);
    expect(keepalives()).toHaveLength(1);
  });

  it.each([
    ["without WEB_INTERNAL_URL", () => delete process.env.WEB_INTERNAL_URL],
    ["without REVALIDATE_SECRET", () => delete process.env.REVALIDATE_SECRET],
    ["with LIVE_EVENTS_DISABLED=1", () => (process.env.LIVE_EVENTS_DISABLED = "1")],
  ])("stays off %s", async (_label, configure) => {
    configure();
    startLiveKeepalive();
    await vi.advanceTimersByTimeAsync(3 * LIVE_KEEPALIVE_MS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs a failing keepalive once, and once more when it gets through again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    startLiveKeepalive();
    await vi.advanceTimersByTimeAsync(3 * LIVE_KEEPALIVE_MS);
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await vi.advanceTimersByTimeAsync(LIVE_KEEPALIVE_MS);
    expect(warn.mock.calls).toEqual([
      [
        "[live-emit] keepalive status=401 — the web's live streams show degraded until it gets through (logged again only when it does)",
      ],
    ]);
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    await vi.advanceTimersByTimeAsync(2 * LIVE_KEEPALIVE_MS);
    expect(info.mock.calls).toEqual([["[live-emit] keepalive reaches the web again"]]);
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await vi.advanceTimersByTimeAsync(LIVE_KEEPALIVE_MS);
    expect(warn.mock.calls[warn.mock.calls.length - 1]).toEqual([
      "[live-emit] keepalive failed: connect ECONNREFUSED — the web's live streams show degraded until it gets through (logged again only when it does)",
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("never keeps the process alive", () => {
    const unref = vi.fn();
    vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref } as unknown as NodeJS.Timeout);
    startLiveKeepalive();
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
