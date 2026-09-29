import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getLiveBus } from "@/lib/live-bus";

/**
 * The per-tab SSE stream (/live/stream) on the real in-memory bus. Pinned:
 *   1. no session → 401, LIVE_EVENTS_DISABLED=1 → 404, both before a
 *      connection exists;
 *   2. the stream opens with `retry` and the hello naming the connection,
 *      and carries the headers the edge relies on;
 *   3. every close the server decides on ends with a terminal
 *      `bye {reason}` (LF05): `evicted` when the bus's per-user cap takes
 *      the place, `shutdown` on the bus's closeAll (SIGTERM), `rotate` at
 *      the lifetime rotation, `expired` when the session ends first; the
 *      client's abort ends it without one.
 *
 * `@/lib/session` is mocked (the real module pulls in next-auth).
 */
const session = vi.hoisted(() => ({ current: null as Session | null }));
vi.mock("@/lib/session", () => ({ getSession: async () => session.current }));

const { GET } = await import("./route");

const signedIn = (id: number, expiresInMs = 7 * 24 * 60 * 60_000): Session => ({
  user: { id, name: `user ${id}` },
  expires: new Date(Date.now() + expiresInMs).toISOString(),
});

/** Opens a stream; `read()` returns everything that arrived since the last read. */
async function open(abort?: AbortController) {
  const res = await GET(new Request("http://web.test/live/stream", { signal: abort?.signal }));
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let done = false;
  let pending: Promise<void> | null = null;
  let buffer = "";
  const pump = () => {
    pending ??= (async () => {
      while (reader && !done) {
        const chunk = await reader.read();
        if (chunk.done) done = true;
        else buffer += decoder.decode(chunk.value);
      }
    })();
  };
  return {
    res,
    async read() {
      pump();
      // Let the stream's queued chunks through.
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      const out = buffer;
      buffer = "";
      return out;
    },
    get done() {
      return done;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  session.current = signedIn(1);
  delete process.env.LIVE_EVENTS_DISABLED;
});

afterEach(() => {
  getLiveBus().closeAll();
  delete globalThis.__sinnlosLiveBus;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("GET /live/stream", () => {
  it("refuses a request without a session (401) and answers 404 while live events are off", async () => {
    session.current = null;
    expect((await GET(new Request("http://web.test/live/stream"))).status).toBe(401);
    session.current = signedIn(1);
    process.env.LIVE_EVENTS_DISABLED = "1";
    expect((await GET(new Request("http://web.test/live/stream"))).status).toBe(404);
    expect(getLiveBus().connectionCount()).toBe(0);
  });

  it("opens with retry and the hello, as an uncompressed, unbuffered event stream", async () => {
    const stream = await open();
    expect(stream.res.headers.get("content-type")).toBe("text/event-stream");
    expect(stream.res.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(stream.res.headers.get("x-accel-buffering")).toBe("no");
    expect(await stream.read()).toMatch(
      /^retry: 3000\nevent: hello\ndata: \{"connId":"[^"]+"\}\n\n$/,
    );
    expect(getLiveBus().connectionCount()).toBe(1);
  });

  it("says bye evicted to the stream the per-user cap evicts, then ends it", async () => {
    const first = await open();
    await first.read();
    for (let i = 0; i < 5; i += 1) await open();
    expect(await first.read()).toBe('event: bye\ndata: {"reason":"evicted"}\n\n');
    expect(first.done).toBe(true);
    expect(getLiveBus().connectionCount()).toBe(5);
  });

  it("says bye shutdown to every stream on the bus's closeAll (SIGTERM)", async () => {
    const a = await open();
    session.current = signedIn(2);
    const b = await open();
    await a.read();
    await b.read();
    getLiveBus().closeAll();
    expect(await a.read()).toBe('event: bye\ndata: {"reason":"shutdown"}\n\n');
    expect(await b.read()).toBe('event: bye\ndata: {"reason":"shutdown"}\n\n');
    expect([a.done, b.done]).toEqual([true, true]);
  });

  it("rotates after 15 to 30 minutes with bye rotate", async () => {
    const stream = await open();
    await stream.read();
    // random 0: the 15-minute end of the range; heartbeats until then.
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(stream.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const tail = await stream.read();
    expect(tail.endsWith('event: bye\ndata: {"reason":"rotate"}\n\n')).toBe(true);
    expect(stream.done).toBe(true);
    expect(getLiveBus().connectionCount()).toBe(0);
  });

  it("says bye expired when the session ends before the rotation", async () => {
    session.current = signedIn(1, 5 * 60_000);
    const stream = await open();
    await stream.read();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect((await stream.read()).endsWith('event: bye\ndata: {"reason":"expired"}\n\n')).toBe(true);
    expect(stream.done).toBe(true);
  });

  it("ends without a bye when the client goes away", async () => {
    const abort = new AbortController();
    const stream = await open(abort);
    await stream.read();
    abort.abort();
    expect(await stream.read()).toBe("");
    expect(stream.done).toBe(true);
    expect(getLiveBus().connectionCount()).toBe(0);
  });

  it("beats every 25 s", async () => {
    const stream = await open();
    await stream.read();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await stream.read()).toBe("event: hb\ndata: 1\n\n");
  });
});
