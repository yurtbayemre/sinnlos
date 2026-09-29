/**
 * The browser side of the live pipeline as a plain state machine (LF05):
 * ONE multiplexed EventSource per visible tab (issue #17/#27), fanning
 * content-free pings out to registered channel listeners, who react by
 * refetching through their own session (LiveCommentSection,
 * LiveNotificationBell, …). The React provider
 * (components/live/live-events-provider.tsx) only creates one, starts and
 * stops it with its effect and mirrors the health flag into state.
 *
 * Everything the machine reads from the browser is injected (LiveClientDeps:
 * the EventSource, the clock, the random source, the tab visibility and the
 * subscribe POST), so live-client.test.ts drives it with fakes; timers are
 * the global ones (fake timers in the tests).
 *
 * Hard-won rules encoded here — change with care:
 *  - Native EventSource retry only covers mid-stream NETWORK drops. Any
 *    HTTP error/redirect (deploy 404/502, expired-session 307) closes it
 *    PERMANENTLY, so this client owns reconnection with jittered
 *    exponential backoff. Stable streams that die (deploy, server-side
 *    rotation) reopen with an extra 0–15s spread so a fleet of tabs
 *    doesn't stampede a cold container (200-employee profile, plan §7).
 *  - Heartbeat watchdog: the server sends an `hb` event every 25s; ~65s
 *    without one means the connection is half-open → force reopen. (A
 *    `: comment` heartbeat would be invisible to the EventSource API.)
 *  - Pings are coalesced per channel (content 400ms; notifications +
 *    announcements get extra 0–3s/0–10s jitter — those fan out to every
 *    user at once) and refetches are single-flight with a dirty flag:
 *    the CMS lifecycle fires inside the write transaction, so an instant
 *    refetch could still read the pre-commit state.
 *  - Hidden tabs hold NO connection at all; visibility regain reopens
 *    and runs one catch-up refetch per channel through a small queue
 *    (concurrency 2, notifications first) — deduped with the reopen
 *    catch-up so it's one refetch per channel, not two.
 *  - Repeated instant closes (5×) mean a terminal condition (kill
 *    switch, auth) → stop retrying until the next visibility regain;
 *    polling fallback covers from t=0.
 *  - Subscriptions are synced in one POST per tick (WD04): every channel
 *    registered or dropped in the same commit (a page mounting 20 comment
 *    sections) goes out together, at most MAX_SUBSCRIBE_LIST per list.
 */
import {
  ANNOUNCEMENTS_CHANNEL,
  MAX_SUBSCRIBE_LIST,
  NOTIFICATIONS_CHANNEL,
  frameChannel,
  isContentChannel,
  parseLiveFrame,
  type ContentChannel,
  type LiveChannel,
  type LiveFrame,
} from "@/lib/live-contract";

/** A channel listener: a refetch; errors are its own business. */
export type LiveListener = () => void | Promise<void>;

/** The slice of the browser's EventSource the client uses. */
export interface EventSourceLike {
  readonly readyState: number;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

/** What the client reads from the browser (fakes in live-client.test.ts). */
export interface LiveClientDeps {
  /** Opens the stream: `new EventSource(url)` in the browser. */
  createEventSource(url: string): EventSourceLike;
  /** Epoch milliseconds: Date.now in the browser. */
  now(): number;
  /** [0, 1): Math.random in the browser; every jitter draws from it. */
  random(): number;
  /** The tab's visibility and its change event. */
  visibility: {
    visible(): boolean;
    /** Calls `listener` on every change; returns the removal. */
    subscribe(listener: () => void): () => void;
  };
  /** POSTs a JSON body (the subscribe route); the answer is not read. */
  post(url: string, body: unknown): Promise<unknown>;
}

/** EventSource.CLOSED: the connection is gone and the browser will not retry. */
const EVENT_SOURCE_CLOSED = 2;

export const STREAM_URL = "/live/stream";
export const SUBSCRIBE_URL = "/live/subscribe";

export const HEARTBEAT_TIMEOUT_MS = 65_000;
export const WATCHDOG_TICK_MS = 20_000;
export const BACKOFF_BASE_MS = 1_500;
export const BACKOFF_CAP_MS = 60_000;
const BACKOFF_MAX_ATTEMPT = 8;
export const STABLE_STREAM_MS = 60_000;
export const REOPEN_SPREAD_MS = 15_000;
export const INSTANT_CLOSE_MS = 2_000;
export const TERMINAL_INSTANT_CLOSES = 5;
export const STOPPED_RETRY_MS = 5 * 60_000;
export const COALESCE_CONTENT_MS = 400;
export const COALESCE_NOTIFICATIONS_JITTER_MS = 3_000;
export const COALESCE_ANNOUNCEMENTS_JITTER_MS = 10_000;
export const CATCHUP_CONCURRENCY = 2;

type Timer = ReturnType<typeof setTimeout>;

export class LiveClient {
  private readonly listeners = new Map<LiveChannel, Set<LiveListener>>();
  private source: EventSourceLike | null = null;
  private connId: string | null = null;
  private lastBeat = 0;
  private openedAt = 0;
  private attempt = 0;
  private instantCloses = 0;
  private stopped = false;
  private stoppedAt = 0;
  private reconnectTimer: Timer | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private unsubscribeVisibility: (() => void) | null = null;
  private everOpened = false;
  private started = false;
  private readonly coalesceTimers = new Map<LiveChannel, Timer>();
  private readonly inflight = new Map<LiveChannel, { dirty: boolean }>();
  private readonly catchupQueue: LiveChannel[] = [];
  private catchupActive = 0;
  private readonly pendingSync = {
    add: new Set<ContentChannel>(),
    remove: new Set<ContentChannel>(),
    scheduled: false,
  };

  /** `onHealth` gets every health change (the provider's state setter). */
  constructor(
    private readonly deps: LiveClientDeps,
    private readonly onHealth: (healthy: boolean) => void,
  ) {}

  /**
   * Starts the machine: watches the tab's visibility, runs the watchdog
   * and opens the stream when the tab is visible. The provider calls it
   * from its effect while live events are enabled.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribeVisibility = this.deps.visibility.subscribe(() => this.onVisibilityChange());
    this.watchdog = setInterval(() => this.watchdogTick(), WATCHDOG_TICK_MS);
    this.connect();
  }

  /** Stops everything start() set up (the provider's effect cleanup). */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.clearReconnect();
    this.clearCoalescing();
    this.teardown();
  }

  /** Adds a listener on `channel`; returns its removal. */
  readonly register = (channel: LiveChannel, listener: LiveListener): (() => void) => {
    let set = this.listeners.get(channel);
    const isNewChannel = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    if (isNewChannel) this.syncSubscriptions([channel]);
    const listeners = set;
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(channel);
        this.syncSubscriptions([], [channel]);
      }
    };
  };

  // --- Stream ----------------------------------------------------------------

  private connect(): void {
    if (!this.started || this.stopped) return;
    if (!this.deps.visibility.visible()) return;
    if (this.source) return;

    const source = this.deps.createEventSource(STREAM_URL);
    this.source = source;
    this.openedAt = this.deps.now();
    this.lastBeat = this.deps.now();

    source.addEventListener("hello", (event) => {
      this.attempt = 0;
      this.instantCloses = 0;
      this.lastBeat = this.deps.now();
      try {
        this.connId = (JSON.parse(String(event.data)) as { connId: string }).connId;
      } catch {
        this.connId = null;
      }
      this.onHealth(true);
      this.syncSubscriptions([...this.listeners.keys()]);
      // Catch-up covers the gap since the last stream (missed pings have
      // no replay). Skipped on the very first open — that data was just
      // server-rendered.
      if (this.everOpened) this.enqueueCatchup();
      this.everOpened = true;
    });

    source.addEventListener("hb", () => {
      this.lastBeat = this.deps.now();
      this.onHealth(true);
    });

    source.addEventListener("ping", (event) => {
      this.lastBeat = this.deps.now();
      let frame: LiveFrame | null = null;
      try {
        frame = parseLiveFrame(JSON.parse(String(event.data)));
      } catch {
        // Not JSON: handled like any malformed frame below.
      }
      // Malformed frame: ignore it; the poll backstop covers.
      if (frame) this.scheduleChannel(frameChannel(frame));
    });

    source.onerror = () => {
      // CONNECTING = native retry is handling a network drop; leave it.
      if (source.readyState !== EVENT_SOURCE_CLOSED) {
        this.onHealth(false);
        return;
      }
      const lifetime = this.deps.now() - this.openedAt;
      this.teardown();
      if (lifetime < INSTANT_CLOSE_MS) {
        this.instantCloses += 1;
        if (this.instantCloses >= TERMINAL_INSTANT_CLOSES) {
          // Kill switch / auth wall / long deploy window: stop burning
          // retries. Visibility regain resets this immediately; the
          // watchdog additionally retries after STOPPED_RETRY_MS so a
          // tab that stays visible through a long deploy recovers on its
          // own. Polling fallback is active throughout.
          this.stopped = true;
          this.stoppedAt = this.deps.now();
          return;
        }
      } else {
        this.instantCloses = 0;
      }
      // A previously stable stream dying usually means deploy or server
      // rotation — spread the fleet's reopen instead of stampeding.
      this.scheduleReconnect(lifetime > STABLE_STREAM_MS ? REOPEN_SPREAD_MS : 0);
    };
  }

  private teardown(): void {
    this.source?.close();
    this.source = null;
    this.connId = null;
    this.onHealth(false);
  }

  private scheduleReconnect(extraSpreadMs = 0): void {
    if (this.stopped || this.reconnectTimer) return;
    const attempt = this.attempt;
    this.attempt = Math.min(attempt + 1, BACKOFF_MAX_ATTEMPT);
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
    const delay = base / 2 + this.deps.random() * base + this.deps.random() * extraSpreadMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private onVisibilityChange(): void {
    if (this.deps.visibility.visible()) {
      this.stopped = false;
      this.instantCloses = 0;
      this.attempt = 0;
      if (!this.source) {
        this.connect();
        // The hello handler runs the catch-up. If the stream can't open,
        // the owners' poll backstop covers: the page-level comment
        // provider's next tick (WD04, 10 s while degraded) and the
        // bell's own visibility refetch.
      }
    } else {
      // Zero background load: no stream, no pending reconnects, no
      // pending dispatches while hidden.
      this.clearReconnect();
      this.clearCoalescing();
      this.teardown();
    }
  }

  private watchdogTick(): void {
    // Self-heal a terminal stop (deploy outlasted the retry budget while
    // the tab stayed visible): one fresh attempt every STOPPED_RETRY_MS.
    if (this.stopped) {
      if (this.deps.visibility.visible() && this.deps.now() - this.stoppedAt > STOPPED_RETRY_MS) {
        this.stopped = false;
        this.instantCloses = 0;
        this.attempt = 0;
        this.connect();
      }
      return;
    }
    if (!this.source) return;
    if (this.deps.now() - this.lastBeat > HEARTBEAT_TIMEOUT_MS) {
      // Half-open connection: TCP is up but nothing flows. Force a
      // clean reopen (jittered — herds of frozen laptops wake together).
      this.teardown();
      this.scheduleReconnect(REOPEN_SPREAD_MS);
    }
  }

  // --- Dispatch ------------------------------------------------------------

  private coalesceDelay(channel: LiveChannel): number {
    if (channel === ANNOUNCEMENTS_CHANNEL) {
      return COALESCE_CONTENT_MS + this.deps.random() * COALESCE_ANNOUNCEMENTS_JITTER_MS;
    }
    if (channel === NOTIFICATIONS_CHANNEL) {
      return COALESCE_CONTENT_MS + this.deps.random() * COALESCE_NOTIFICATIONS_JITTER_MS;
    }
    return COALESCE_CONTENT_MS;
  }

  private scheduleChannel(channel: LiveChannel): void {
    const timers = this.coalesceTimers;
    if (timers.has(channel)) return; // already coalescing — later pings fold in
    timers.set(
      channel,
      setTimeout(() => {
        timers.delete(channel);
        void this.runChannel(channel);
      }, this.coalesceDelay(channel)),
    );
  }

  private clearCoalescing(): void {
    for (const timer of this.coalesceTimers.values()) clearTimeout(timer);
    this.coalesceTimers.clear();
  }

  /** Single-flight refetch with dirty-flag per channel. */
  private async runChannel(channel: LiveChannel): Promise<void> {
    const inflight = this.inflight.get(channel);
    if (inflight) {
      inflight.dirty = true;
      return;
    }
    const state = { dirty: false };
    this.inflight.set(channel, state);
    try {
      do {
        state.dirty = false;
        const listeners = this.listeners.get(channel);
        if (!listeners || listeners.size === 0) break;
        await Promise.all(
          [...listeners].map(async (fn) => {
            try {
              await fn();
            } catch {
              // Listener refetches swallow their own errors; anything that
              // escapes must not kill the dispatch loop.
            }
          }),
        );
      } while (state.dirty);
    } finally {
      this.inflight.delete(channel);
    }
  }

  private pumpCatchup(): void {
    while (this.catchupActive < CATCHUP_CONCURRENCY && this.catchupQueue.length > 0) {
      const channel = this.catchupQueue.shift()!;
      this.catchupActive += 1;
      void this.runChannel(channel).finally(() => {
        this.catchupActive -= 1;
        this.pumpCatchup();
      });
    }
  }

  /** One refetch per registered channel, notifications first, bounded. */
  private enqueueCatchup(): void {
    const channels = [...this.listeners.keys()].filter(
      (channel) => (this.listeners.get(channel)?.size ?? 0) > 0,
    );
    channels.sort((a, b) =>
      a === NOTIFICATIONS_CHANNEL ? -1 : b === NOTIFICATIONS_CHANNEL ? 1 : 0,
    );
    for (const channel of channels) {
      if (!this.catchupQueue.includes(channel)) this.catchupQueue.push(channel);
    }
    this.pumpCatchup();
  }

  // --- Subscriptions -------------------------------------------------------

  private syncSubscriptions(add: LiveChannel[], remove: LiveChannel[] = []): void {
    // Only content channels are subscribed on the bus; the global ones
    // reach every connection that may receive them. Changes of one tick
    // are merged (the last one per channel wins) and sent together.
    const pending = this.pendingSync;
    for (const channel of add) {
      if (!isContentChannel(channel)) continue;
      pending.remove.delete(channel);
      pending.add.add(channel);
    }
    for (const channel of remove) {
      if (!isContentChannel(channel)) continue;
      pending.add.delete(channel);
      pending.remove.add(channel);
    }
    if (pending.scheduled || (pending.add.size === 0 && pending.remove.size === 0)) return;
    pending.scheduled = true;
    queueMicrotask(() => {
      pending.scheduled = false;
      const wanted = [...pending.add];
      const dropped = [...pending.remove];
      pending.add.clear();
      pending.remove.clear();
      // No stream yet: the next hello subscribes every registered channel.
      const connId = this.connId;
      if (!connId) return;
      for (let i = 0; i < Math.max(wanted.length, dropped.length); i += MAX_SUBSCRIBE_LIST) {
        this.deps
          .post(SUBSCRIBE_URL, {
            connId,
            add: wanted.slice(i, i + MAX_SUBSCRIBE_LIST),
            remove: dropped.slice(i, i + MAX_SUBSCRIBE_LIST),
          })
          .catch(() => {
            // Stream eviction/rotation races are resolved by the next hello.
          });
      }
    });
  }
}

/** The browser's implementations of LiveClientDeps, read at call time (SSR-safe). */
export const browserLiveClientDeps: LiveClientDeps = {
  createEventSource: (url) => new EventSource(url),
  now: () => Date.now(),
  random: () => Math.random(),
  visibility: {
    visible: () => document.visibilityState === "visible",
    subscribe(listener) {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  },
  post: (url, body) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
};
