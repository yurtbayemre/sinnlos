/**
 * Per-tab SSE stream (issue #17/#27): one multiplexed EventSource per
 * visible tab, fed by the in-memory live bus. Deliberately OUTSIDE
 * /api/* — Traefik's prio-50 rule swallows /api/* into the cms router.
 * /live/* has a Traefik router of its own, sinnlos-live (priority 10,
 * above the sinnlos-web catch-all; batch 10, FX34): the security headers
 * only, no compression and no rate limit. Keep it that way; the
 * routing-parity test pins it.
 *
 * Edge note: the websecure entrypoint pins
 * respondingTimeouts.readTimeout=0 (host traefik.yaml) as a DEFENSIVE
 * measure — measured 2026-09-01, the 60s default only kills idle
 * connections without a request; active streams with the 25s heartbeat
 * survived >10min on the default. Never put this route behind a
 * buffering middleware or a writeTimeout.
 *
 * Frames are content-free pings; all data flows through the existing
 * session-authenticated server actions on refetch.
 *
 * Every close the server decides on ends with a terminal `bye {reason}`
 * event (LF05, live contract): `evicted` (the bus's per-user or total
 * cap), `shutdown` (SIGTERM, the bus's closeAll), `rotate` (the lifetime
 * below) or `expired` (the session ends first: at its Strapi JWT's exp,
 * which is what ends the session, D-SESSION-01). The client closes its
 * EventSource on it, so the browser's native 3 s retry no longer reopens a
 * stream the server ended on purpose. A stream that died (a failed write,
 * backpressure, the client's abort) gets no bye: nobody would read it.
 *
 * The hello and every heartbeat carry `emitFresh` (LF05): whether the cms
 * reached the bus within the last 45 s (its keepalive runs every 20 s). A
 * stream without a fresh cms leg is up but gets no pings; the client then
 * counts as degraded, and its owners poll at the short intervals.
 *
 * Admission needs more than the Auth.js cookie: the session's Strapi JWT
 * must still be accepted by the cms (the cached /api/users/me check of
 * /uploads, lib/upload-block-cache.ts, 60 s per JWT). A password change
 * (FX40), a block or a deleted account makes the cms refuse that JWT, so
 * the stream answers 401 and the client's instant-close stop ends the
 * retries; without that check the same cookie kept receiving the user's
 * notification and channel pings until the JWT's exp. A cms that cannot
 * say (an outage) does not keep a stream from opening: `emitFresh` already
 * reports that leg as degraded.
 */
import { STRAPI_URL } from "@/lib/config";
import { getSession, getStrapiToken } from "@/lib/session";
import { strapiJwtExp } from "@/lib/strapi-jwt";
import { checkUploadAccess } from "@/lib/upload-block-cache";

import { getLiveBus, liveEventsDisabled, type LiveFrame } from "@/lib/live-bus";
import type { ByeReason, HeartbeatFrame, HelloFrame } from "@/lib/live-contract";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;
/**
 * Hard stream rotation. Second GC path for half-open connections the
 * enqueue error can't detect, AND the upper bound on how long an open
 * stream outlives its session's revocation: a revoked JWT (password change,
 * block, deleted account) is only refused when a stream opens, and every
 * reconnect re-runs the session and JWT check, so an open stream ends at
 * the latest with its rotation (plus the check's 60 s cache). A demoted
 * user's role is read per refetch, not here. So the stream lifetime is a
 * security parameter, not a tuning knob. Randomized so post-deploy herds
 * don't re-rotate in lockstep.
 */
const MAX_LIFETIME_MS_MIN = 15 * 60_000;
const MAX_LIFETIME_MS_MAX = 30 * 60_000;
const SESSION_CLOSE_CAP_MS = 4 * 60 * 60_000;

const encoder = new TextEncoder();

export async function GET(req: Request) {
  const session = await getSession();
  const userId = session?.user && "id" in session.user ? session.user.id : undefined;
  if (typeof userId !== "number") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (liveEventsDisabled()) {
    return Response.json({ error: "live events disabled" }, { status: 404 });
  }
  // No Strapi JWT, or one the cms refuses (revoked, blocked, deleted,
  // invalid): 401, like a missing session. "unavailable" admits.
  const jwt = await getStrapiToken();
  if (!jwt || (await checkUploadAccess({ userId, jwt, strapiUrl: STRAPI_URL })) === "blocked") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const bus = getLiveBus();
  const connId = crypto.randomUUID();

  let heartbeat: NodeJS.Timeout | null = null;
  let lifetimeTimer: NodeJS.Timeout | null = null;
  let lowWatermarkStrikes = 0;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(text));
          return true;
        } catch {
          return false;
        }
      };

      const cleanup = (reason?: ByeReason) => {
        if (closed) return;
        if (reason) write(`event: bye\ndata: ${JSON.stringify({ reason })}\n\n`);
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (lifetimeTimer) clearTimeout(lifetimeTimer);
        bus.drop(connId);
        try {
          controller.close();
        } catch {
          /* already closed by the runtime */
        }
      };

      // The heartbeat carries the cms leg's freshness (LF05, HeartbeatFrame).
      const beat = (emitFresh: boolean) =>
        write(`event: hb\ndata: ${JSON.stringify({ emitFresh } satisfies HeartbeatFrame)}\n\n`);

      bus.register({
        id: connId,
        userId,
        channels: new Set(),
        openedAt: Date.now(),
        enqueue: (frame: LiveFrame) => write(`event: ping\ndata: ${JSON.stringify(frame)}\n\n`),
        beat,
        close: cleanup,
      });

      // retry: native EventSource reconnect hint for mid-stream network
      // drops (HTTP errors close it permanently — the provider owns that).
      const hello: HelloFrame = { connId, emitFresh: bus.emitFresh() };
      write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify(hello)}\n\n`);

      heartbeat = setInterval(() => {
        // A real event, not an SSE comment line: comment frames are
        // invisible to the EventSource API, and the client watchdog
        // (~60s without a beat → force reopen) needs to see these.
        if (!beat(bus.emitFresh())) {
          cleanup();
          return;
        }
        // Backpressure eviction: a client that stopped reading (half-open
        // TCP, frozen renderer) accumulates negative desiredSize. Two
        // consecutive strikes → treat as dead.
        if ((controller.desiredSize ?? 1) < 0) {
          lowWatermarkStrikes += 1;
          if (lowWatermarkStrikes >= 2) cleanup();
        } else {
          lowWatermarkStrikes = 0;
        }
      }, HEARTBEAT_MS);
      heartbeat.unref?.();

      const lifetime =
        MAX_LIFETIME_MS_MIN + Math.random() * (MAX_LIFETIME_MS_MAX - MAX_LIFETIME_MS_MIN);
      // The session ends with its Strapi JWT (D-SESSION-01: the jwt
      // callback ends it at the JWT's exp). Auth.js's own session.expires
      // is no end at all: it slides to now + maxAge (7 days) on every read.
      const exp = strapiJwtExp(jwt);
      const sessionMs = exp !== undefined ? exp * 1000 - Date.now() : Number.POSITIVE_INFINITY;
      // `expired` when the session is what ends the stream: the client then
      // waits for its next visibility regain instead of reconnecting into a
      // refusal; otherwise the planned `rotate`.
      const reason: ByeReason = sessionMs <= lifetime ? "expired" : "rotate";
      lifetimeTimer = setTimeout(
        () => cleanup(reason),
        Math.max(60_000, Math.min(lifetime, sessionMs, SESSION_CLOSE_CAP_MS)),
      );
      lifetimeTimer.unref?.();

      req.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      // Client went away without an abort event (runtime-dependent).
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (lifetimeTimer) clearTimeout(lifetimeTimer);
      bus.drop(connId);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      // no-transform is load-bearing: Next's standalone server ships
      // compress:true, and the compression middleware would pipe the
      // stream through zlib (text/* matches its filter). no-transform
      // makes it — and Caddy's encode in the fallback profile — skip
      // this response entirely. Traefik's compress ignores no-transform
      // (3.7), hence the sinnlos-live router without it, and both
      // compress middlewares exclude text/event-stream as well.
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
