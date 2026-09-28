import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStrapiStub, type StrapiStub } from "../test/strapi-stub.test.helper";
import {
  __flushLiveEventsForTest,
  emitLiveEvent,
  registerLiveEventSubscriber,
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
