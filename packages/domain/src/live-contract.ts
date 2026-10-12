/**
 * The live-event contract (LF04): what the cms emits, what the web bus
 * delivers and what the browser receives. One module, so event kinds and
 * channel names cannot drift between the emitter, the bus, the SSE stream,
 * the subscribe route and the client provider.
 *
 * Events are content-free pings; clients refetch through their own session,
 * so every visibility policy applies to what they then see.
 *   - `content`: a comment or reaction of one target changed. Delivered only
 *     to connections subscribed to that target's CHANNEL (`channelFor`,
 *     "<targetType>:<targetDocumentId>"), never broadcast: documentIds double
 *     as capability tokens (docs/architecture.md §5.17), and a tab can only
 *     know the ids the policy-filtered pages served it.
 *   - `notification`: the recipient's notifications changed. Delivered to the
 *     recipient's own connections only.
 *   - `announcements`: the announcement list changed. Broadcast.
 * A frame names the channel the client refetches. The stream's own events
 * (hello, the heartbeat, the terminal `bye`) are described here too, so
 * the stream route and the browser client read the same shapes. The two GLOBAL channels
 * ("notifications", "announcements") never contain ':', and every content
 * channel does, so a global channel can never be mistaken for, or
 * subscribed as, a content channel: `isContentChannel` is the one test for
 * "needs a server-side subscription".
 *
 * Content channels exist for the comment target types only.
 * LIVE_TARGET_TYPES must list exactly `CommentTargetType` of the sibling
 * comment-target.ts (a compile-time check below; the cms test
 * apps/cms/src/utils/live-contract.test.ts also compares it with the cms's
 * TARGET_UIDS), and CHANNEL_RE is built from it.
 *
 * No runtime imports and no process access: one module for the cms emitter
 * and the web bus, stream, subscribe route and client provider (SH01);
 * apps/cms/src/utils/live-contract.ts and apps/web/src/lib/live-contract.ts
 * re-export it.
 */
import type { CommentTargetType } from "./comment-target.js";

/** The target types that have content channels: the comment target types. */
export const LIVE_TARGET_TYPES = ["announcement", "wiki-page"] as const;

export type LiveTargetType = (typeof LIVE_TARGET_TYPES)[number];

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
/** Fails to compile when LIVE_TARGET_TYPES and CommentTargetType differ. */
export type LiveTargetTypesMatchCommentTargets = AssertTrue<
  Same<LiveTargetType, CommentTargetType>
>;

/** "<targetType>:<targetDocumentId>" of a comment/reaction target. */
export type ContentChannel = `${LiveTargetType}:${string}`;

export const NOTIFICATIONS_CHANNEL = "notifications";
export const ANNOUNCEMENTS_CHANNEL = "announcements";

/** Channels without a subscription; none contains ':'. */
export const GLOBAL_CHANNELS = [NOTIFICATIONS_CHANNEL, ANNOUNCEMENTS_CHANNEL] as const;

export type GlobalChannel = (typeof GLOBAL_CHANNELS)[number];

export type LiveChannel = ContentChannel | GlobalChannel;

/**
 * What the cms POSTs to the web's /api/live/emit, in `{ events: LiveEvent[] }`.
 * `keepalive` (LF05) changes nothing and pings nobody: the cms sends it every
 * LIVE_KEEPALIVE_MS, so the web knows its emit leg is alive even when nobody
 * writes (see EMIT_FRESH_MS).
 */
export type LiveEvent =
  | { kind: "content"; targetType: string; targetDocumentId: string }
  | { kind: "notification"; recipientId: number }
  | { kind: "announcements" }
  | { kind: "keepalive" };

/** How often the cms proves that its emits reach the web (LF05). */
export const LIVE_KEEPALIVE_MS = 20_000;

/**
 * The web calls the cms leg fresh while its last emit (a keepalive or any
 * event) is at most this old: two keepalives and some slack, so one slow or
 * lost keepalive does not flap the clients. A web that has heard nothing
 * since it started is not fresh.
 */
export const EMIT_FRESH_MS = 2 * LIVE_KEEPALIVE_MS + 5_000;

/** What the SSE stream sends as the data of a `ping` event. */
export type LiveFrame =
  | { type: "content"; channel: ContentChannel }
  | { type: "notification" }
  | { type: "announcements" };

/**
 * Most events in one POST to /api/live/emit: the web answers a longer list
 * with 400, so the cms sends a bigger burst in several POSTs (LF01).
 */
export const MAX_EVENTS_PER_EMIT = 1000;

/**
 * Most channels in one POST /live/subscribe: a bigger set goes out in
 * several POSTs of the same revision (LiveSubscribeRequest).
 */
export const MAX_SUBSCRIBE_LIST = 100;

/** The documentId part of a content channel (Strapi's are 24 characters). */
const CHANNEL_ID_PATTERN = "[A-Za-z0-9_-]{1,64}";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A content channel: a comment target type, ':', a documentId. */
export const CHANNEL_RE = new RegExp(
  `^(?:${LIVE_TARGET_TYPES.map(escapeRegExp).join("|")}):${CHANNEL_ID_PATTERN}$`,
);

/** True for a content channel, the only kind a connection subscribes to. */
export function isContentChannel(channel: unknown): channel is ContentChannel {
  return typeof channel === "string" && CHANNEL_RE.test(channel);
}

/**
 * The content channel of a comment/reaction target, or null when the target
 * cannot have one (unknown type, missing or malformed documentId): nobody
 * can subscribe to such a channel, so nothing is sent or listened for.
 */
export function channelFor(target: {
  targetType: unknown;
  targetDocumentId: unknown;
}): ContentChannel | null {
  const { targetType, targetDocumentId } = target;
  if (typeof targetType !== "string" || typeof targetDocumentId !== "string") return null;
  const channel = `${targetType}:${targetDocumentId}`;
  return isContentChannel(channel) ? channel : null;
}

/**
 * The body of POST /live/subscribe (LF05): the FULL set of content channels
 * the tab wants on connection `connId` (from the stream's hello), at
 * revision `rev`. The client counts `rev` up by one for every set it
 * sends, across all its connections, so a POST that arrives late (after a
 * newer set) is recognised and ignored instead of undoing the newer one. A
 * set of more than MAX_SUBSCRIBE_LIST channels goes out in several POSTs
 * with the same `rev`: the first of them to arrive replaces the
 * connection's set, the others add to it, in whatever order they arrive.
 * The empty set is one POST with no channels.
 */
export type LiveSubscribeRequest = {
  connId: string;
  rev: number;
  channels: ContentChannel[];
};

/** A subscribe body, or null when malformed (the route answers 400). */
export function parseSubscribeRequest(value: unknown): LiveSubscribeRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const { connId, rev, channels } = value as Record<string, unknown>;
  if (typeof connId !== "string" || connId === "" || connId.length > 100) return null;
  if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 1) return null;
  if (!Array.isArray(channels) || channels.length > MAX_SUBSCRIBE_LIST) return null;
  if (!channels.every(isContentChannel)) return null;
  return { connId, rev, channels: [...new Set(channels)] };
}

/** The channel a client refetches when `frame` arrives. */
export function frameChannel(frame: LiveFrame): LiveChannel {
  switch (frame.type) {
    case "content":
      return frame.channel;
    case "notification":
      return NOTIFICATIONS_CHANNEL;
    case "announcements":
      return ANNOUNCEMENTS_CHANNEL;
  }
}

/**
 * The data of the stream's first event, `hello`: the connection id the
 * subscribe POSTs name, and whether the cms leg is fresh (EMIT_FRESH_MS).
 */
export type HelloFrame = { connId: string; emitFresh: boolean };

/**
 * The data of the heartbeat, `hb`, sent every 25 s and at once when the cms
 * leg recovers: whether the cms leg is fresh. A stream whose cms leg is not
 * fresh is up but gets no pings, so the client counts as degraded (its
 * owners poll at the short intervals).
 */
export type HeartbeatFrame = { emitFresh: boolean };

/**
 * A `hello` event's data, or null without a connection id. A hello without
 * `emitFresh` (a web from before LF05) counts as fresh.
 */
export function parseHelloFrame(value: unknown): HelloFrame | null {
  if (typeof value !== "object" || value === null) return null;
  const { connId, emitFresh } = value as { connId?: unknown; emitFresh?: unknown };
  if (typeof connId !== "string" || connId === "") return null;
  return { connId, emitFresh: emitFresh !== false };
}

/**
 * An `hb` event's data. Only an explicit `emitFresh: false` is stale: the
 * heartbeat of a web from before LF05 (the data `1`) counts as fresh.
 */
export function parseHeartbeatFrame(value: unknown): HeartbeatFrame {
  const emitFresh =
    typeof value === "object" && value !== null
      ? (value as { emitFresh?: unknown }).emitFresh
      : undefined;
  return { emitFresh: emitFresh !== false };
}

/**
 * Why the server ends a stream with a terminal `bye` event (LF05). Without
 * it the browser's native retry (3 s) reopened every server-closed stream,
 * so an evicted tab evicted the next one, round after round, and a deploy
 * hit the stopping container. The client acts on the reason:
 *   - `evicted`: a newer stream of the same user took this one's place (the
 *     per-user or total cap); reconnecting would evict the next tab, so the
 *     client waits for the tab's next visibility regain (the poll backstop
 *     covers meanwhile);
 *   - `shutdown`: the web process is stopping (deploy); reconnect with the
 *     fleet spread, not at once;
 *   - `rotate`: the planned lifetime rotation (a reconnect re-runs the
 *     session check); reconnect after the normal short backoff;
 *   - `expired`: the session ends now; a reconnect would be refused, so the
 *     client waits for the next visibility regain like `evicted`.
 */
export const BYE_REASONS = ["evicted", "shutdown", "rotate", "expired"] as const;

export type ByeReason = (typeof BYE_REASONS)[number];

/** What the stream sends as the data of its last event, `bye`. */
export type ByeFrame = { reason: ByeReason };

/** A `bye` event's data, or null when malformed. */
export function parseByeFrame(value: unknown): ByeFrame | null {
  if (typeof value !== "object" || value === null) return null;
  const reason = (value as { reason?: unknown }).reason;
  return (BYE_REASONS as readonly unknown[]).includes(reason)
    ? { reason: reason as ByeReason }
    : null;
}

/** A frame as it arrives in a `ping` event's data, or null when malformed. */
export function parseLiveFrame(value: unknown): LiveFrame | null {
  if (typeof value !== "object" || value === null) return null;
  const frame = value as { type?: unknown; channel?: unknown };
  switch (frame.type) {
    case "content":
      return isContentChannel(frame.channel) ? { type: "content", channel: frame.channel } : null;
    case "notification":
      return { type: "notification" };
    case "announcements":
      return { type: "announcements" };
    default:
      return null;
  }
}
