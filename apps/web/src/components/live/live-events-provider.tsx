"use client";

/**
 * Owns the ONE multiplexed EventSource per visible tab (issue #17/#27)
 * and fans content-free pings out to registered channel listeners, who
 * react by refetching through their own session (LiveCommentSection,
 * LiveNotificationBell, …).
 *
 * Hard-won rules encoded here — change with care:
 *  - Native EventSource retry only covers mid-stream NETWORK drops. Any
 *    HTTP error/redirect (deploy 404/502, expired-session 307) closes it
 *    PERMANENTLY, so this provider owns reconnection with jittered
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
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
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

// Channel names, frames and "which channels need a subscription" come from
// the live contract (LF04): content channels "<targetType>:<documentId>" and
// the global "notifications" / "announcements".
export type { LiveChannel } from "@/lib/live-contract";

type Listener = () => void | Promise<void>;

export type LiveContextValue = {
  /** Adds a listener on `channel`; returns its removal. */
  register: (channel: LiveChannel, listener: Listener) => () => void;
  healthy: boolean;
  /**
   * Whether a push stream runs at all: false with live events off
   * (LIVE_EVENTS_DISABLED=1, DEMO_MODE) and outside a provider. Without
   * one, no hello runs a catch-up when the tab comes back, so an owner
   * refetches on visibility regain itself (the page-level comment
   * provider does, WD04).
   */
  streaming: boolean;
};

const LiveEventsContext = createContext<LiveContextValue>({
  register: () => () => {},
  healthy: false,
  streaming: false,
});

const HEARTBEAT_TIMEOUT_MS = 65_000;
const WATCHDOG_TICK_MS = 20_000;
const BACKOFF_BASE_MS = 1_500;
const BACKOFF_CAP_MS = 60_000;
const STABLE_STREAM_MS = 60_000;
const REOPEN_SPREAD_MS = 15_000;
const INSTANT_CLOSE_MS = 2_000;
const TERMINAL_INSTANT_CLOSES = 5;
const STOPPED_RETRY_MS = 5 * 60_000;
const COALESCE_CONTENT_MS = 400;
const COALESCE_NOTIFICATIONS_JITTER_MS = 3_000;
const COALESCE_ANNOUNCEMENTS_JITTER_MS = 10_000;
const CATCHUP_CONCURRENCY = 2;

function coalesceDelay(channel: LiveChannel): number {
  if (channel === ANNOUNCEMENTS_CHANNEL) {
    return COALESCE_CONTENT_MS + Math.random() * COALESCE_ANNOUNCEMENTS_JITTER_MS;
  }
  if (channel === NOTIFICATIONS_CHANNEL) {
    return COALESCE_CONTENT_MS + Math.random() * COALESCE_NOTIFICATIONS_JITTER_MS;
  }
  return COALESCE_CONTENT_MS;
}

export function LiveEventsProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  const [healthy, setHealthy] = useState(false);

  const listenersRef = useRef(new Map<LiveChannel, Set<Listener>>());
  const sourceRef = useRef<EventSource | null>(null);
  const connIdRef = useRef<string | null>(null);
  const lastBeatRef = useRef(0);
  const openedAtRef = useRef(0);
  const attemptRef = useRef(0);
  const instantClosesRef = useRef(0);
  const stoppedRef = useRef(false);
  const stoppedAtRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const everOpenedRef = useRef(false);
  const coalesceTimersRef = useRef(new Map<LiveChannel, ReturnType<typeof setTimeout>>());
  const inflightRef = useRef(new Map<LiveChannel, { dirty: boolean }>());
  const catchupQueueRef = useRef<LiveChannel[]>([]);
  const catchupActiveRef = useRef(0);
  const pendingSyncRef = useRef({
    add: new Set<ContentChannel>(),
    remove: new Set<ContentChannel>(),
    scheduled: false,
  });

  /** Single-flight refetch with dirty-flag per channel. */
  const runChannel = useCallback(async (channel: LiveChannel) => {
    const inflight = inflightRef.current.get(channel);
    if (inflight) {
      inflight.dirty = true;
      return;
    }
    const state = { dirty: false };
    inflightRef.current.set(channel, state);
    try {
      do {
        state.dirty = false;
        const listeners = listenersRef.current.get(channel);
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
      inflightRef.current.delete(channel);
    }
  }, []);

  const scheduleChannel = useCallback(
    (channel: LiveChannel) => {
      const timers = coalesceTimersRef.current;
      if (timers.has(channel)) return; // already coalescing — later pings fold in
      timers.set(
        channel,
        setTimeout(() => {
          timers.delete(channel);
          void runChannel(channel);
        }, coalesceDelay(channel)),
      );
    },
    [runChannel],
  );

  const pumpCatchup = useCallback(() => {
    // Hoisted declaration so the completion callback can re-enter the
    // pump without the useCallback const referencing itself.
    function pump() {
      while (catchupActiveRef.current < CATCHUP_CONCURRENCY && catchupQueueRef.current.length > 0) {
        const channel = catchupQueueRef.current.shift()!;
        catchupActiveRef.current += 1;
        void runChannel(channel).finally(() => {
          catchupActiveRef.current -= 1;
          pump();
        });
      }
    }
    pump();
  }, [runChannel]);

  /** One refetch per registered channel, notifications first, bounded. */
  const enqueueCatchup = useCallback(() => {
    const channels = [...listenersRef.current.keys()].filter(
      (ch) => (listenersRef.current.get(ch)?.size ?? 0) > 0,
    );
    channels.sort((a, b) =>
      a === NOTIFICATIONS_CHANNEL ? -1 : b === NOTIFICATIONS_CHANNEL ? 1 : 0,
    );
    const queue = catchupQueueRef.current;
    for (const ch of channels) if (!queue.includes(ch)) queue.push(ch);
    pumpCatchup();
  }, [pumpCatchup]);

  const syncSubscriptions = useCallback((add: LiveChannel[], remove: LiveChannel[] = []) => {
    // Only content channels are subscribed on the bus; the global ones
    // reach every connection that may receive them. Changes of one tick
    // are merged (the last one per channel wins) and sent together.
    const pending = pendingSyncRef.current;
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
      const connId = connIdRef.current;
      if (!connId) return;
      for (let i = 0; i < Math.max(wanted.length, dropped.length); i += MAX_SUBSCRIBE_LIST) {
        void fetch("/live/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            connId,
            add: wanted.slice(i, i + MAX_SUBSCRIBE_LIST),
            remove: dropped.slice(i, i + MAX_SUBSCRIBE_LIST),
          }),
        }).catch(() => {
          // Stream eviction/rotation races are resolved by the next hello.
        });
      }
    });
  }, []);

  const connectRef = useRef<() => void>(() => {});

  const scheduleReconnect = useCallback((extraSpreadMs = 0) => {
    if (stoppedRef.current || reconnectTimerRef.current) return;
    const attempt = attemptRef.current;
    attemptRef.current = Math.min(attempt + 1, 8);
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
    const delay = base / 2 + Math.random() * base + Math.random() * extraSpreadMs;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectRef.current();
    }, delay);
  }, []);

  const teardown = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    connIdRef.current = null;
    setHealthy(false);
  }, []);

  const connect = useCallback(() => {
    if (!enabled || stoppedRef.current) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (sourceRef.current) return;

    const source = new EventSource("/live/stream");
    sourceRef.current = source;
    openedAtRef.current = Date.now();
    lastBeatRef.current = Date.now();

    source.addEventListener("hello", (ev) => {
      attemptRef.current = 0;
      instantClosesRef.current = 0;
      lastBeatRef.current = Date.now();
      try {
        connIdRef.current = (JSON.parse((ev as MessageEvent).data) as { connId: string }).connId;
      } catch {
        connIdRef.current = null;
      }
      setHealthy(true);
      syncSubscriptions([...listenersRef.current.keys()]);
      // Catch-up covers the gap since the last stream (missed pings have
      // no replay). Skipped on the very first open — that data was just
      // server-rendered.
      if (everOpenedRef.current) enqueueCatchup();
      everOpenedRef.current = true;
    });

    source.addEventListener("hb", () => {
      lastBeatRef.current = Date.now();
      setHealthy(true);
    });

    source.addEventListener("ping", (ev) => {
      lastBeatRef.current = Date.now();
      let frame: LiveFrame | null = null;
      try {
        frame = parseLiveFrame(JSON.parse((ev as MessageEvent).data));
      } catch {
        // Not JSON: handled like any malformed frame below.
      }
      // Malformed frame: ignore it; the poll backstop covers.
      if (frame) scheduleChannel(frameChannel(frame));
    });

    source.onerror = () => {
      // CONNECTING = native retry is handling a network drop; leave it.
      if (source.readyState !== EventSource.CLOSED) {
        setHealthy(false);
        return;
      }
      const lifetime = Date.now() - openedAtRef.current;
      teardown();
      if (lifetime < INSTANT_CLOSE_MS) {
        instantClosesRef.current += 1;
        if (instantClosesRef.current >= TERMINAL_INSTANT_CLOSES) {
          // Kill switch / auth wall / long deploy window: stop burning
          // retries. Visibility regain resets this immediately; the
          // watchdog additionally retries after STOPPED_RETRY_MS so a
          // tab that stays visible through a long deploy recovers on its
          // own. Polling fallback is active throughout.
          stoppedRef.current = true;
          stoppedAtRef.current = Date.now();
          return;
        }
      } else {
        instantClosesRef.current = 0;
      }
      // A previously stable stream dying usually means deploy or server
      // rotation — spread the fleet's reopen instead of stampeding.
      scheduleReconnect(lifetime > STABLE_STREAM_MS ? REOPEN_SPREAD_MS : 0);
    };
  }, [enabled, enqueueCatchup, scheduleChannel, scheduleReconnect, syncSubscriptions, teardown]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    if (!enabled) return;

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        stoppedRef.current = false;
        instantClosesRef.current = 0;
        attemptRef.current = 0;
        if (!sourceRef.current) {
          connect();
          // The hello handler runs the catch-up. If the stream can't open,
          // the owners' poll backstop covers: the page-level comment
          // provider's next tick (WD04, 10 s while degraded) and the
          // bell's own visibility refetch.
        }
      } else {
        // Zero background load: no stream, no pending reconnects, no
        // pending dispatches while hidden.
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        for (const timer of coalesceTimersRef.current.values()) clearTimeout(timer);
        coalesceTimersRef.current.clear();
        teardown();
      }
    };

    const watchdog = setInterval(() => {
      // Self-heal a terminal stop (deploy outlasted the retry budget while
      // the tab stayed visible): one fresh attempt every STOPPED_RETRY_MS.
      if (stoppedRef.current) {
        if (
          document.visibilityState === "visible" &&
          Date.now() - stoppedAtRef.current > STOPPED_RETRY_MS
        ) {
          stoppedRef.current = false;
          instantClosesRef.current = 0;
          attemptRef.current = 0;
          connectRef.current();
        }
        return;
      }
      if (!sourceRef.current) return;
      if (Date.now() - lastBeatRef.current > HEARTBEAT_TIMEOUT_MS) {
        // Half-open connection: TCP is up but nothing flows. Force a
        // clean reopen (jittered — herds of frozen laptops wake together).
        teardown();
        scheduleReconnect(REOPEN_SPREAD_MS);
      }
    }, WATCHDOG_TICK_MS);

    document.addEventListener("visibilitychange", onVisibility);
    connect();

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(watchdog);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      for (const timer of coalesceTimersRef.current.values()) clearTimeout(timer);
      coalesceTimersRef.current.clear();
      teardown();
    };
  }, [enabled, connect, scheduleReconnect, teardown]);

  const register = useCallback(
    (channel: LiveChannel, listener: Listener) => {
      const listeners = listenersRef.current;
      let set = listeners.get(channel);
      const isNewChannel = !set || set.size === 0;
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(listener);
      if (isNewChannel) syncSubscriptions([channel]);
      return () => {
        set!.delete(listener);
        if (set!.size === 0) {
          listeners.delete(channel);
          syncSubscriptions([], [channel]);
        }
      };
    },
    [syncSubscriptions],
  );

  return (
    <LiveEventsContext.Provider value={{ register, healthy, streaming: enabled }}>
      {children}
    </LiveEventsContext.Provider>
  );
}

/**
 * The provider itself, for a component that listens on many channels at
 * once (the page-level comment provider, WD04): `register` per channel,
 * `healthy` for its poll interval, `streaming` for its own tab-regain
 * refetch when there is no stream.
 */
export function useLiveRegistry(): LiveContextValue {
  return useContext(LiveEventsContext);
}

/**
 * Subscribe a refetch callback to a live channel. Returns the stream
 * health flag so callers can stretch their fallback poll interval while
 * the push path is alive (see plan: healthy 60s/120s, degraded = today's
 * 10s/30s).
 */
export function useLiveChannel(channel: LiveChannel | null, refetch: Listener): boolean {
  const { register, healthy } = useContext(LiveEventsContext);
  // Effect Event instead of the latest-ref pattern (issue #36): always
  // calls the latest refetch without re-registering, and without the
  // ref write during render the useRef docs forbid. Wrapped in a plain
  // closure at registration — Effect Events must not be passed around.
  const onLiveEvent = useEffectEvent(refetch);

  useEffect(() => {
    // No channel (e.g. a target without a documentId): nothing to listen to.
    if (channel === null) return;
    return register(channel, () => onLiveEvent());
  }, [register, channel]);

  return healthy;
}
