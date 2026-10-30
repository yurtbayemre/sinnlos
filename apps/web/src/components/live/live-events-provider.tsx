"use client";

/**
 * Owns the ONE multiplexed EventSource per visible tab (issue #17/#27)
 * and fans content-free pings out to registered channel listeners, who
 * react by refetching through their own session (LiveCommentSection,
 * LiveNotificationBell, …).
 *
 * The connection state machine lives in lib/live-client.ts (LF05: backoff,
 * terminal stop and self-heal, heartbeat watchdog, hidden-tab teardown,
 * ping coalescing, catch-up queue, subscription sync — its header has the
 * rules). This component only creates one client per mount, starts it
 * while live events are enabled, and mirrors its health flag into state,
 * and whether a hello came from another web build (#214).
 * The hooks below are the API every consumer uses; keep them unchanged.
 */

import { createContext, useContext, useEffect, useEffectEvent, useState } from "react";
import { LiveClient, browserLiveClientDeps, type LiveListener } from "@/lib/live-client";
import type { LiveChannel } from "@/lib/live-contract";

// Channel names, frames and "which channels need a subscription" come from
// the live contract (LF04): content channels "<targetType>:<documentId>" and
// the global "notifications" / "announcements".
export type { LiveChannel } from "@/lib/live-contract";

export type LiveContextValue = {
  /** Adds a listener on `channel`; returns its removal. */
  register: (channel: LiveChannel, listener: LiveListener) => () => void;
  healthy: boolean;
  /**
   * Whether a push stream runs at all: false with live events off
   * (LIVE_EVENTS_DISABLED=1, DEMO_MODE) and outside a provider. Without
   * one, no hello runs a catch-up when the tab comes back, so an owner
   * refetches on visibility regain itself (the page-level comment
   * provider does, WD04).
   */
  streaming: boolean;
  /**
   * A stream hello came from another web build than the one that rendered
   * this tab (#214): after a deploy the tab's Server Actions are gone, so
   * the header offers a reload.
   */
  newVersion: boolean;
};

const LiveEventsContext = createContext<LiveContextValue>({
  register: () => () => {},
  healthy: false,
  streaming: false,
  newVersion: false,
});

export function LiveEventsProvider({
  enabled,
  revision = null,
  children,
}: {
  enabled: boolean;
  /** The build revision of the server that rendered the tab (layout). */
  revision?: string | null;
  children: React.ReactNode;
}) {
  const [healthy, setHealthy] = useState(false);
  // The tab's own revision, taken once: a later render (router.refresh, a
  // navigation) never replaces it, and a hello is compared, never adopted.
  const [ownRevision] = useState(revision);
  const [newVersion, setNewVersion] = useState(false);
  // One client per mount. Its constructor touches no browser API, so this
  // also runs during the server render; start() runs only in the effect.
  // A hello without a revision counts as another build once the tab has
  // one (a web rolled back to before v0.33.3).
  const [client] = useState(
    () =>
      new LiveClient(browserLiveClientDeps, setHealthy, (helloRevision) => {
        if (ownRevision !== null && helloRevision !== ownRevision) setNewVersion(true);
      }),
  );

  useEffect(() => {
    if (!enabled) return;
    client.start();
    return () => client.stop();
  }, [enabled, client]);

  return (
    <LiveEventsContext
      value={{ register: client.register, healthy, streaming: enabled, newVersion }}
    >
      {children}
    </LiveEventsContext>
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
export function useLiveChannel(channel: LiveChannel | null, refetch: LiveListener): boolean {
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
