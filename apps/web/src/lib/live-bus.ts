/**
 * In-memory fan-out bus between the CMS emit webhook (/api/live/emit)
 * and the per-tab SSE streams (/live/stream). Events are content-free
 * pings; clients refetch through their own session, so nothing here
 * needs to re-check content visibility — but comment/reaction channel
 * delivery is subscription-based, NOT broadcast: documentIds double as
 * capability tokens in this repo (see docs/architecture.md §5.17), so a
 * connection only receives pings for channels it explicitly subscribed
 * to, and it can only know channel ids the policy-filtered pages already
 * served it. Notification pings are filtered by the session-bound user
 * id; the coarse `announcements` channel goes to everyone.
 *
 * Pinned on globalThis (same Turbopack-layer caveat as
 * login-rate-limit.ts: the emit route and the SSE route compile into
 * different layer chunks with separate module registries — a plain
 * module-scope singleton would give each layer its own, empty bus).
 *
 * Sizing (200-employee profile, plan §7): 500 connections total,
 * 5 per user with oldest-first eviction.
 */

import {
  MAX_EVENTS_PER_EMIT,
  channelFor,
  type ByeReason,
  type LiveEvent,
  type LiveFrame,
} from "@/lib/live-contract";

// Event and frame shapes, channel names and the batch limit live in the live
// contract (LF04), shared byte for byte with the cms emitter.
export type { LiveEvent, LiveFrame } from "@/lib/live-contract";

type Connection = {
  id: string;
  userId: number;
  channels: Set<string>;
  openedAt: number;
  /** Returns false when the underlying stream rejected the frame. */
  enqueue: (frame: LiveFrame) => boolean;
  /**
   * Ends the stream. With a reason, a terminal `bye` event goes out first
   * (LF05), so the client neither retries natively nor evicts the next tab.
   */
  close: (reason?: ByeReason) => void;
};

const MAX_CONNECTIONS_TOTAL = 500;
const MAX_CONNECTIONS_PER_USER = 5;
const MAX_CHANNELS_PER_CONNECTION = 200;

class LiveBus {
  private connections = new Map<string, Connection>();
  private counters = { emitsReceived: 0, pingsSent: 0, evictions: 0 };
  private statsTimer: NodeJS.Timeout | null = null;

  register(conn: Connection): void {
    // Per-user cap: evict the OLDEST connection instead of rejecting the
    // new one — reconnecting tabs must always win over stale streams. The
    // evicted stream says `bye evicted`: its tab waits for its next
    // visibility regain instead of reconnecting and evicting the next one.
    const mine = [...this.connections.values()]
      .filter((c) => c.userId === conn.userId)
      .sort((a, b) => a.openedAt - b.openedAt);
    while (mine.length >= MAX_CONNECTIONS_PER_USER) {
      this.evict(mine.shift()!);
    }
    if (this.connections.size >= MAX_CONNECTIONS_TOTAL) {
      const oldest = [...this.connections.values()].sort((a, b) => a.openedAt - b.openedAt)[0];
      if (oldest) this.evict(oldest);
    }
    this.connections.set(conn.id, conn);
    this.ensureBackgroundTasks();
  }

  private evict(conn: Connection): void {
    this.drop(conn.id);
    this.counters.evictions += 1;
    try {
      conn.close("evicted");
    } catch {
      /* stream already dead */
    }
  }

  drop(connId: string): void {
    this.connections.delete(connId);
  }

  /**
   * Update a connection's channel subscriptions. The caller (the
   * session-gated /live/subscribe route) must pass the session's userId —
   * a connId alone is NOT proof of ownership.
   */
  subscribe(connId: string, userId: number, add: string[], remove: string[]): boolean {
    const conn = this.connections.get(connId);
    if (!conn || conn.userId !== userId) return false;
    for (const ch of remove) conn.channels.delete(ch);
    for (const ch of add) {
      if (conn.channels.size >= MAX_CHANNELS_PER_CONNECTION) break;
      conn.channels.add(ch);
    }
    return true;
  }

  publish(events: LiveEvent[]): void {
    this.counters.emitsReceived += 1;
    for (const event of events) {
      for (const conn of this.connections.values()) {
        let frame: LiveFrame | null = null;
        if (event.kind === "content") {
          // A target without a valid channel cannot have a subscriber.
          const channel = channelFor(event);
          if (channel && conn.channels.has(channel)) frame = { type: "content", channel };
        } else if (event.kind === "notification") {
          if (conn.userId === event.recipientId) frame = { type: "notification" };
        } else {
          frame = { type: "announcements" };
        }
        if (!frame) continue;
        if (conn.enqueue(frame)) {
          this.counters.pingsSent += 1;
        } else {
          // Stream is gone (aborted/errored); GC it now rather than at
          // the next heartbeat.
          this.drop(conn.id);
        }
      }
    }
  }

  connectionCount(): number {
    return this.connections.size;
  }

  /**
   * SIGTERM/SIGINT: close every stream so Next's server.close() drains.
   * Each says `bye shutdown` first: the clients reconnect with the fleet
   * spread instead of hitting the stopping process after 3 s.
   */
  closeAll(): void {
    for (const conn of [...this.connections.values()]) {
      this.drop(conn.id);
      try {
        conn.close("shutdown");
      } catch {
        /* stream already dead */
      }
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private ensureBackgroundTasks(): void {
    if (!this.statsTimer) {
      this.statsTimer = setInterval(() => {
        if (this.connections.size > 0 || this.counters.emitsReceived > 0) {
          const evicted = this.counters.evictions > 0 ? ` evicted=${this.counters.evictions}` : "";
          console.log(
            `[live] conns=${this.connections.size} emitsRx=${this.counters.emitsReceived} pingsTx=${this.counters.pingsSent}${evicted}`,
          );
          this.counters.emitsReceived = 0;
          this.counters.pingsSent = 0;
          this.counters.evictions = 0;
        }
      }, 60_000);
      this.statsTimer.unref?.();
    }
    registerShutdownOnce();
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __sinnlosLiveBus: LiveBus | undefined;
  // eslint-disable-next-line no-var
  var __sinnlosLiveBusShutdown: boolean | undefined;
}

/**
 * Next 16's production SIGTERM handler awaits server.close(), which never
 * resolves while SSE streams are open — without this hook every deploy
 * would hang for the full stop_grace_period and die by SIGKILL. Once per
 * process (pinned on globalThis like the bus), closing whichever bus is
 * current: a bus replaced in a test leaves no listener behind.
 */
function registerShutdownOnce(): void {
  if (globalThis.__sinnlosLiveBusShutdown) return;
  globalThis.__sinnlosLiveBusShutdown = true;
  const shutdown = () => globalThis.__sinnlosLiveBus?.closeAll();
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export function getLiveBus(): LiveBus {
  if (!globalThis.__sinnlosLiveBus) {
    globalThis.__sinnlosLiveBus = new LiveBus();
  }
  return globalThis.__sinnlosLiveBus;
}

export function liveEventsDisabled(): boolean {
  return process.env.LIVE_EVENTS_DISABLED === "1";
}

/** Shared shape guard for the emit route. */
export function parseLiveEvents(body: unknown): LiveEvent[] | null {
  if (!body || typeof body !== "object") return null;
  const events = (body as { events?: unknown }).events;
  // The cms sends at most MAX_EVENTS_PER_EMIT per POST and splits a bigger
  // burst (LF01), so a longer list is refused as malformed.
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS_PER_EMIT) {
    return null;
  }
  const parsed: LiveEvent[] = [];
  for (const e of events) {
    if (!e || typeof e !== "object") return null;
    const ev = e as Record<string, unknown>;
    if (
      ev.kind === "content" &&
      typeof ev.targetType === "string" &&
      typeof ev.targetDocumentId === "string"
    ) {
      parsed.push({
        kind: "content",
        targetType: ev.targetType,
        targetDocumentId: ev.targetDocumentId,
      });
    } else if (ev.kind === "notification" && typeof ev.recipientId === "number") {
      parsed.push({ kind: "notification", recipientId: ev.recipientId });
    } else if (ev.kind === "announcements") {
      parsed.push({ kind: "announcements" });
    } else {
      return null;
    }
  }
  return parsed;
}
