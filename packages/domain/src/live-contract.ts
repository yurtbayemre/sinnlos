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

/** What the cms POSTs to the web's /api/live/emit, in `{ events: LiveEvent[] }`. */
export type LiveEvent =
  | { kind: "content"; targetType: string; targetDocumentId: string }
  | { kind: "notification"; recipientId: number }
  | { kind: "announcements" };

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

/** Most channels in one `add` or `remove` list of POST /live/subscribe. */
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
