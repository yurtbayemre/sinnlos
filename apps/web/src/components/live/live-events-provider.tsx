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
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export type LiveChannel = string; // "announcement:<docId>" | "wiki-page:<docId>" | "notifications" | "announcements"

type Listener = () => void | Promise<void>;

type LiveContextValue = {
  register: (channel: LiveChannel, listener: Listener) => () => void;
  healthy: boolean;
};

const LiveEventsContext = createContext<LiveContextValue>({
  register: () => () => {},
  healthy: false,
});

const HEARTBEAT_TIMEOUT_MS = 65_000;
const WATCHDOG_TICK_MS = 20_000;
const BACKOFF_BASE_MS = 1_500;
const BACKOFF_CAP_MS = 60_000;
const STABLE_STREAM_MS = 60_000;
const REOPEN_SPREAD_MS = 15_000;
const INSTANT_CLOSE_MS = 2_000;
const TERMINAL_INSTANT_CLOSES = 5;
const COALESCE_CONTENT_MS = 400;
const COALESCE_NOTIFICATIONS_JITTER_MS = 3_000;
const COALESCE_ANNOUNCEMENTS_JITTER_MS = 10_000;
const CATCHUP_CONCURRENCY = 2;

/** Channels that require a server-side subscription on the bus. */
function isSubscribedChannel(channel: string): boolean {
  return channel.includes(":");
}

function coalesceDelay(channel: LiveChannel): number {
  if (channel === "announcements") {
    return COALESCE_CONTENT_MS + Math.random() * COALESCE_ANNOUNCEMENTS_JITTER_MS;
  }
  if (channel === "notifications") {
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
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const everOpenedRef = useRef(false);
  const coalesceTimersRef = useRef(new Map<LiveChannel, ReturnType<typeof setTimeout>>());
  const inflightRef = useRef(new Map<LiveChannel, { dirty: boolean }>());
  const catchupQueueRef = useRef<LiveChannel[]>([]);
  const catchupActiveRef = useRef(0);

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
    while (
      catchupActiveRef.current < CATCHUP_CONCURRENCY &&
      catchupQueueRef.current.length > 0
    ) {
      const channel = catchupQueueRef.current.shift()!;
      catchupActiveRef.current += 1;
      void runChannel(channel).finally(() => {
        catchupActiveRef.current -= 1;
        pumpCatchup();
      });
    }
  }, [runChannel]);

  /** One refetch per registered channel, notifications first, bounded. */
  const enqueueCatchup = useCallback(() => {
    const channels = [...listenersRef.current.keys()].filter(
      (ch) => (listenersRef.current.get(ch)?.size ?? 0) > 0,
    );
    channels.sort((a, b) => (a === "notifications" ? -1 : b === "notifications" ? 1 : 0));
    const queue = catchupQueueRef.current;
    for (const ch of channels) if (!queue.includes(ch)) queue.push(ch);
    pumpCatchup();
  }, [pumpCatchup]);

  const syncSubscriptions = useCallback((add: LiveChannel[], remove: LiveChannel[] = []) => {
    const connId = connIdRef.current;
    const wanted = add.filter(isSubscribedChannel);
    const dropped = remove.filter(isSubscribedChannel);
    if (!connId || (wanted.length === 0 && dropped.length === 0)) return;
    void fetch("/live/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connId, add: wanted, remove: dropped }),
    }).catch(() => {
      // Stream eviction/rotation races are resolved by the next hello.
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
      try {
        const frame = JSON.parse((ev as MessageEvent).data) as
          | { type: "content"; channel: string }
          | { type: "notification" }
          | { type: "announcements" };
        if (frame.type === "content") scheduleChannel(frame.channel);
        else if (frame.type === "notification") scheduleChannel("notifications");
        else scheduleChannel("announcements");
      } catch {
        // Malformed frame — ignore; the poll backstop covers.
      }
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
          // Kill switch / auth wall: stop burning retries. Visibility
          // regain resets this; polling fallback is active throughout.
          stoppedRef.current = true;
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
          // The hello handler runs the catch-up; if the stream can't open,
          // the wrappers' own visibilitychange tick already refetched.
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
    <LiveEventsContext.Provider value={{ register, healthy }}>
      {children}
    </LiveEventsContext.Provider>
  );
}

/**
 * Subscribe a refetch callback to a live channel. Returns the stream
 * health flag so callers can stretch their fallback poll interval while
 * the push path is alive (see plan: healthy 60s/120s, degraded = today's
 * 10s/30s).
 */
export function useLiveChannel(channel: LiveChannel, refetch: Listener): boolean {
  const { register, healthy } = useContext(LiveEventsContext);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    return register(channel, () => refetchRef.current());
  }, [register, channel]);

  return healthy;
}
