import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getLiveBus, type LiveFrame } from "./live-bus";
import { LIVE_EMIT_SECRET_HEADER, handleLiveEmit, secretMatches } from "./live-emit";
import { POST } from "@/app/api/live/emit/route";

/**
 * The /api/live/emit receiver (S06): the only session-less web endpoint, so
 * its shared-secret check is the whole barrier inside the frontend network.
 * Pinned through lib/live-emit.ts and through the route's POST export (the
 * route only delegates):
 *   - 503 while REVALIDATE_SECRET is unset or empty, before anything else,
 *   - 401 for a missing, wrong or length-mismatched x-revalidate-secret
 *     (a length mismatch must not reach timingSafeEqual, which would throw),
 *   - 204 plus a publish on the in-process bus for the right secret,
 *   - LIVE_EVENTS_DISABLED=1: 204 without publishing, the secret still checked,
 *   - 400 for a body that is not an event batch.
 */

const SECRET = "s3cr3t-live-emit";
const BATCH = {
  events: [
    { kind: "content", targetType: "announcement", targetDocumentId: "k3m9x0000000000000000000" },
    { kind: "notification", recipientId: 7 },
    { kind: "announcements" },
  ],
};

function emitRequest(options: { secret?: string | null; body?: unknown; rawBody?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const secret = options.secret === undefined ? SECRET : options.secret;
  if (secret !== null) headers.set(LIVE_EMIT_SECRET_HEADER, secret);
  return new NextRequest("http://web:3000/api/live/emit", {
    method: "POST",
    headers,
    body: options.rawBody ?? JSON.stringify(options.body ?? BATCH),
  });
}

/** A connection on the real bus that records what reaches user 7. */
function listen() {
  const frames: LiveFrame[] = [];
  getLiveBus().register({
    id: "conn-1",
    userId: 7,
    channels: new Set(["announcement:k3m9x0000000000000000000"]),
    openedAt: Date.now(),
    enqueue: (frame) => {
      frames.push(frame);
      return true;
    },
    close: () => undefined,
  });
  return frames;
}

beforeEach(() => {
  vi.stubEnv("REVALIDATE_SECRET", SECRET);
  vi.stubEnv("LIVE_EVENTS_DISABLED", "");
});

afterEach(() => {
  getLiveBus().closeAll();
  Reflect.deleteProperty(globalThis, "__sinnlosLiveBus");
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.each([
  ["lib/live-emit handleLiveEmit", (req: NextRequest) => handleLiveEmit(req)],
  ["app/api/live/emit POST", (req: NextRequest) => POST(req)],
])("%s", (_label, emit) => {
  it("answers 503 while REVALIDATE_SECRET is unset or empty, whatever the request", async () => {
    for (const value of [undefined, ""]) {
      vi.stubEnv("REVALIDATE_SECRET", value);
      const publish = vi.spyOn(getLiveBus(), "publish");
      const res = await emit(emitRequest({ secret: "" }));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "REVALIDATE_SECRET is not configured" });
      expect(publish).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["wrong, same length", "s3cr3t-live-emiX"],
    ["shorter", "s3cr3t"],
    ["longer", `${SECRET}!`],
    ["same characters, more bytes", "s3cr3t-live-emï"],
    ["different case", SECRET.toUpperCase()],
  ])("answers 401 for a %s secret and publishes nothing", async (_case, secret) => {
    const publish = vi.spyOn(getLiveBus(), "publish");
    const res = await emit(emitRequest({ secret }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("answers 204 and publishes the parsed batch for the right secret", async () => {
    const frames = listen();
    const publish = vi.spyOn(getLiveBus(), "publish");
    const res = await emit(emitRequest());
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(BATCH.events);
    expect(frames).toEqual([
      { type: "content", channel: "announcement:k3m9x0000000000000000000" },
      { type: "notification" },
      { type: "announcements" },
    ]);
  });

  it("LIVE_EVENTS_DISABLED=1: 204 without publishing, but the secret is still checked first", async () => {
    vi.stubEnv("LIVE_EVENTS_DISABLED", "1");
    const frames = listen();
    const publish = vi.spyOn(getLiveBus(), "publish");
    expect((await emit(emitRequest())).status).toBe(204);
    expect((await emit(emitRequest({ secret: "nope" }))).status).toBe(401);
    expect(publish).not.toHaveBeenCalled();
    expect(frames).toEqual([]);
  });

  it("only '1' switches live events off", async () => {
    vi.stubEnv("LIVE_EVENTS_DISABLED", "true");
    const publish = vi.spyOn(getLiveBus(), "publish");
    expect((await emit(emitRequest())).status).toBe(204);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["not JSON", { rawBody: "{nope" }],
    ["no events", { body: {} }],
    ["an empty batch", { body: { events: [] } }],
    ["an unknown kind", { body: { events: [{ kind: "wipe" }] } }],
    [
      "a content event without an anchor",
      { body: { events: [{ kind: "content", targetType: "announcement" }] } },
    ],
  ])("answers 400 for %s", async (_case, request) => {
    const publish = vi.spyOn(getLiveBus(), "publish");
    const res = await emit(emitRequest(request));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid events payload" });
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("secretMatches", () => {
  it("matches only the exact secret and never throws on a length mismatch", () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(null, SECRET)).toBe(false);
    expect(secretMatches("", SECRET)).toBe(false);
    expect(secretMatches("x", SECRET)).toBe(false);
    expect(secretMatches(`${SECRET}${SECRET}`, SECRET)).toBe(false);
    expect(secretMatches("ä", "a")).toBe(false);
  });
});
