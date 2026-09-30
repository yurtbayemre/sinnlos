import type { Session } from "next-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getLiveBus } from "@/lib/live-bus";
import { uploadBlockCache } from "@/lib/upload-block-cache";

/**
 * The per-tab SSE stream (/live/stream) on the real in-memory bus. Pinned:
 *   1. no session → 401, LIVE_EVENTS_DISABLED=1 → 404, both before a
 *      connection exists; a session whose Strapi JWT is missing or refused
 *      by the cms (revoked by a password change, blocked, deleted) → 401,
 *      while a cms that cannot say (an outage) still gets its stream;
 *   2. the stream opens with `retry` and the hello naming the connection,
 *      and carries the headers the edge relies on;
 *   3. every close the server decides on ends with a terminal
 *      `bye {reason}` (LF05): `evicted` when the bus's per-user cap takes
 *      the place, `shutdown` on the bus's closeAll (SIGTERM), `rotate` at
 *      the lifetime rotation, `expired` when the session ends first (the
 *      exp of its Strapi JWT, never Auth.js's sliding `expires`); the
 *      client's abort ends it without one;
 *   4. the hello and the 25 s heartbeat carry the cms leg's freshness
 *      (`emitFresh`, LF05), and a recovering cms leg is announced at once.
 *
 * `@/lib/session` is mocked (the real module pulls in next-auth), as are
 * `@/lib/config` and global fetch (the cms's /api/users/me); the JWT check's
 * status map is the real one.
 */
const session = vi.hoisted(() => ({
  current: null as Session | null,
  jwt: null as string | null,
}));
vi.mock("@/lib/session", () => ({
  getSession: async () => session.current,
  getStrapiToken: async () => session.jwt,
}));
vi.mock("@/lib/config", () => ({ STRAPI_URL: "http://cms.test" }));

/** What the cms answers the JWT check (GET /api/users/me) with. */
const cms = vi.hoisted(() => ({ me: (): Response => Response.json({ id: 1, blocked: false }) }));
const fetchMock = vi.fn(async (url: string) => {
  if (url === "http://cms.test/api/users/me?fields[0]=blocked") return cms.me();
  throw new Error(`unexpected fetch ${url}`);
});
vi.stubGlobal("fetch", fetchMock);

const { GET } = await import("./route");

/** A Strapi-shaped JWT (the web decodes, never verifies it). */
const strapiJwt = (id: number, exp = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60) => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ id, exp })}.sig-${id}`;
};

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
  session.jwt = strapiJwt(1);
  cms.me = () => Response.json({ id: 1, blocked: false });
  fetchMock.mockClear();
  uploadBlockCache.clear();
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
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a session whose Strapi JWT is gone or no longer accepted by the cms (401)", async () => {
    session.jwt = null;
    expect((await GET(new Request("http://web.test/live/stream"))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    // Revoked by a password change (FX40), blocked or deleted: Strapi's 401.
    session.jwt = strapiJwt(1);
    cms.me = () => new Response("Unauthorized", { status: 401 });
    expect((await GET(new Request("http://web.test/live/stream"))).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://cms.test/api/users/me?fields[0]=blocked",
      expect.objectContaining({ headers: { Authorization: `Bearer ${session.jwt}` } }),
    );
    expect(getLiveBus().connectionCount()).toBe(0);
  });

  it("opens while the cms cannot say (an outage is emitFresh's business, not a refusal)", async () => {
    cms.me = () => new Response("Bad Gateway", { status: 502 });
    const stream = await open();
    expect(stream.res.status).toBe(200);
    expect(await stream.read()).toMatch(/^retry: 3000\nevent: hello\n/);
    expect(getLiveBus().connectionCount()).toBe(1);
  });

  it("asks the cms once per JWT and minute, not per stream", async () => {
    await open();
    await open();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A reconnect after the check's 60 s asks again: a revocation reaches
    // the next rotation.
    await vi.advanceTimersByTimeAsync(60_000);
    cms.me = () => new Response("Unauthorized", { status: 401 });
    expect((await GET(new Request("http://web.test/live/stream"))).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("opens with retry and the hello, as an uncompressed, unbuffered event stream", async () => {
    const stream = await open();
    expect(stream.res.headers.get("content-type")).toBe("text/event-stream");
    expect(stream.res.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(stream.res.headers.get("x-accel-buffering")).toBe("no");
    expect(await stream.read()).toMatch(
      /^retry: 3000\nevent: hello\ndata: \{"connId":"[^"]+","emitFresh":false\}\n\n$/,
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

  it("says bye expired when the session's Strapi JWT expires before the rotation", async () => {
    // Auth.js's session.expires slides (now + 7 days on every read); the
    // Strapi JWT's exp is what ends the session.
    session.jwt = strapiJwt(1, Math.floor(Date.now() / 1000) + 5 * 60);
    const stream = await open();
    await stream.read();
    // exp has whole seconds: the end falls within the last second.
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1_000);
    expect(stream.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await stream.read()).endsWith('event: bye\ndata: {"reason":"expired"}\n\n')).toBe(true);
    expect(stream.done).toBe(true);
  });

  it("does not read Auth.js's session.expires: a near one still rotates", async () => {
    session.current = signedIn(1, 5 * 60_000);
    const stream = await open();
    await stream.read();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(stream.done).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect((await stream.read()).endsWith('event: bye\ndata: {"reason":"rotate"}\n\n')).toBe(true);
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

  it("beats every 25 s with the cms leg's freshness", async () => {
    const stream = await open();
    await stream.read();
    await vi.advanceTimersByTimeAsync(25_000);
    // Nothing from the cms since the web started: not fresh.
    expect(await stream.read()).toBe('event: hb\ndata: {"emitFresh":false}\n\n');
    getLiveBus().publish([{ kind: "keepalive" }]);
    await stream.read();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await stream.read()).toBe('event: hb\ndata: {"emitFresh":true}\n\n');
    // No keepalive for more than 45 s: stale again at the next beat.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await stream.read()).toBe('event: hb\ndata: {"emitFresh":false}\n\n');
  });

  it("says in the hello whether the cms leg is fresh", async () => {
    getLiveBus().publish([{ kind: "keepalive" }]);
    const stream = await open();
    expect(await stream.read()).toMatch(
      /event: hello\ndata: \{"connId":"[^"]+","emitFresh":true\}/,
    );
  });

  it("beats at once when the cms leg comes back, not at the next tick", async () => {
    const stream = await open();
    await stream.read();
    getLiveBus().publish([{ kind: "keepalive" }]);
    expect(await stream.read()).toBe('event: hb\ndata: {"emitFresh":true}\n\n');
    // Still fresh: the next keepalive adds nothing to the stream.
    await vi.advanceTimersByTimeAsync(20_000);
    getLiveBus().publish([{ kind: "keepalive" }]);
    expect(await stream.read()).toBe("");
  });
});
