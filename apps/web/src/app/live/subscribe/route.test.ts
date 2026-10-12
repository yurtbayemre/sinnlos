import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getLiveBus } from "@/lib/live-bus";
import type { LiveFrame } from "@/lib/live-contract";

/**
 * POST /live/subscribe on the real in-memory bus (LF05). Pinned:
 *   1. no session → 401, LIVE_EVENTS_DISABLED=1 → 404;
 *   2. the body is the full desired set with a revision
 *      (`{ connId, rev, channels }`, the contract's LiveSubscribeRequest):
 *      a newer revision replaces the set, a stale one is answered
 *      `applied: false` and changes nothing, the cap is reported;
 *   3. only the session's own connection can be changed (404 otherwise),
 *      and a malformed body is a 400;
 *   4. the add/remove body of the previous client still works, for tabs
 *      that run the old bundle after a deploy.
 *
 * `@/lib/session` is mocked (the real module pulls in next-auth).
 */
const session = vi.hoisted(() => ({ current: null as Session | null }));
vi.mock("@/lib/session", () => ({ getSession: async () => session.current }));

const { POST } = await import("./route");

const signedIn = (id: number): Session => ({
  user: { id, name: `user ${id}` },
  expires: "2099-01-01T00:00:00.000Z",
});

const post = (body: unknown) =>
  POST(
    new Request("http://web.test/live/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

/** A bus connection of `userId` that records its frames. */
function connection(userId: number) {
  const frames: LiveFrame[] = [];
  const id = crypto.randomUUID();
  getLiveBus().register({
    id,
    userId,
    channels: new Set(),
    openedAt: Date.now(),
    enqueue: (frame) => {
      frames.push(frame);
      return true;
    },
    close: () => undefined,
  });
  /** The content channels that ping it, of a/b/c. */
  const receives = () => {
    frames.length = 0;
    for (const doc of ["a", "b", "c"]) {
      getLiveBus().publish([
        { kind: "content", targetType: "announcement", targetDocumentId: doc },
      ]);
    }
    return frames.map((frame) => (frame.type === "content" ? frame.channel : frame.type));
  };
  return { id, receives };
}

beforeEach(() => {
  session.current = signedIn(1);
  delete process.env.LIVE_EVENTS_DISABLED;
});

afterEach(() => {
  getLiveBus().closeAll();
  delete globalThis.__sinnlosLiveBus;
  vi.restoreAllMocks();
});

describe("POST /live/subscribe", () => {
  it("refuses a request without a session (401) and answers 404 while live events are off", async () => {
    session.current = null;
    expect((await post({ connId: "c", rev: 1, channels: [] })).status).toBe(401);
    session.current = signedIn(1);
    process.env.LIVE_EVENTS_DISABLED = "1";
    expect((await post({ connId: "c", rev: 1, channels: [] })).status).toBe(404);
  });

  it("sets the full set per revision and ignores a stale one", async () => {
    const conn = connection(1);
    let res = await post({
      connId: conn.id,
      rev: 2,
      channels: ["announcement:a", "announcement:b"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: true, rev: 2, channels: 2, dropped: 0 });
    expect(conn.receives()).toEqual(["announcement:a", "announcement:b"]);

    res = await post({ connId: conn.id, rev: 3, channels: ["announcement:c"] });
    expect(await res.json()).toMatchObject({ applied: true, rev: 3, channels: 1 });
    expect(conn.receives()).toEqual(["announcement:c"]);

    res = await post({ connId: conn.id, rev: 1, channels: ["announcement:a"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: false, rev: 3 });
    expect(conn.receives()).toEqual(["announcement:c"]);
  });

  it("reports the channels the 200-channel cap dropped", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const conn = connection(1);
    const answers = [];
    // One revision in three parts of 100: the third does not fit.
    for (let part = 0; part < 3; part += 1) {
      const channels = Array.from({ length: 100 }, (_, i) => `announcement:d${part * 100 + i}`);
      answers.push(await (await post({ connId: conn.id, rev: 1, channels })).json());
    }
    expect(answers).toEqual([
      { ok: true, applied: true, rev: 1, channels: 100, dropped: 0 },
      { ok: true, applied: true, rev: 1, channels: 200, dropped: 0 },
      { ok: true, applied: true, rev: 1, channels: 200, dropped: 100 },
    ]);
  });

  it("changes only the session's own connection", async () => {
    const other = connection(2);
    const res = await post({ connId: other.id, rev: 1, channels: ["announcement:a"] });
    expect(res.status).toBe(404);
    expect(other.receives()).toEqual([]);
    expect((await post({ connId: "gone", rev: 1, channels: [] })).status).toBe(404);
  });

  it("answers 400 to a malformed body", async () => {
    const conn = connection(1);
    for (const body of [
      "not json",
      { connId: conn.id, rev: 0, channels: [] },
      { connId: conn.id, rev: 1, channels: ["notifications"] },
      { connId: conn.id, rev: 1 },
      { connId: conn.id, channels: [] },
      {
        connId: conn.id,
        rev: 1,
        channels: Array.from({ length: 101 }, (_, i) => `announcement:${i}`),
      },
      { connId: conn.id, add: ["announcements"] },
    ]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("still takes the previous client's add/remove body", async () => {
    const conn = connection(1);
    let res = await post({ connId: conn.id, add: ["announcement:a", "announcement:b"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    res = await post({ connId: conn.id, remove: ["announcement:a"] });
    expect(res.status).toBe(200);
    expect(conn.receives()).toEqual(["announcement:b"]);
    const other = connection(2);
    expect((await post({ connId: other.id, add: ["announcement:a"] })).status).toBe(404);
  });
});
