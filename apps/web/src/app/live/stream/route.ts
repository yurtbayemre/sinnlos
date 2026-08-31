/**
 * Per-tab SSE stream (issue #17/#27): one multiplexed EventSource per
 * visible tab, fed by the in-memory live bus. Deliberately OUTSIDE
 * /api/* — Traefik's prio-50 rule swallows /api/* into the cms router,
 * while /live/* falls through to the sinnlos-web catch-all (same
 * pattern as /events/[id]/ics). Keep it that way; the routing-parity
 * test pins it.
 *
 * Edge prerequisite: the websecure entrypoint carries
 * respondingTimeouts.readTimeout=0 (host traefik.yaml) — the Traefik
 * default of 60s kills idle streaming responses. Never put this route
 * behind a buffering middleware or a writeTimeout.
 *
 * Frames are content-free pings; all data flows through the existing
 * session-authenticated server actions on refetch.
 */
import { auth } from "@/auth";

import { getLiveBus, liveEventsDisabled, type LiveFrame } from "@/lib/live-bus";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;
/**
 * Hard stream rotation. Second GC path for half-open connections the
 * enqueue error can't detect, AND the upper bound on how long a blocked/
 * demoted user keeps receiving pings (JWT sessions have no revocation —
 * reconnect re-runs auth(), so stream lifetime is a security parameter,
 * not a tuning knob). Randomized so post-deploy herds don't re-rotate in
 * lockstep.
 */
const MAX_LIFETIME_MS_MIN = 15 * 60_000;
const MAX_LIFETIME_MS_MAX = 30 * 60_000;
const SESSION_CLOSE_CAP_MS = 4 * 60 * 60_000;

const encoder = new TextEncoder();

export async function GET(req: Request) {
  const session = await auth();
  const userId = session?.user && "id" in session.user ? session.user.id : undefined;
  if (typeof userId !== "number") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (liveEventsDisabled()) {
    return Response.json({ error: "live events disabled" }, { status: 404 });
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

      const cleanup = () => {
        if (closed) return;
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

      bus.register({
        id: connId,
        userId,
        channels: new Set(),
        openedAt: Date.now(),
        enqueue: (frame: LiveFrame) => write(`event: ping\ndata: ${JSON.stringify(frame)}\n\n`),
        close: cleanup,
      });

      // retry: native EventSource reconnect hint for mid-stream network
      // drops (HTTP errors close it permanently — the provider owns that).
      write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ connId })}\n\n`);

      heartbeat = setInterval(() => {
        // A real event, not an SSE comment line: comment frames are
        // invisible to the EventSource API, and the client watchdog
        // (~60s without a beat → force reopen) needs to see these.
        if (!write("event: hb\ndata: 1\n\n")) {
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
      const sessionMs = session?.expires
        ? new Date(session.expires).getTime() - Date.now()
        : Number.POSITIVE_INFINITY;
      lifetimeTimer = setTimeout(
        cleanup,
        Math.max(60_000, Math.min(lifetime, sessionMs, SESSION_CLOSE_CAP_MS)),
      );
      lifetimeTimer.unref?.();

      req.signal.addEventListener("abort", cleanup);
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
      // this response entirely.
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
