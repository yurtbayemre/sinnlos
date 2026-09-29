/**
 * The live-event contract (LF04): what the cms emits, what the web bus
 * delivers and what the browser receives. One module for both apps, in
 * @sinnlos/domain (SH01, packages/domain/src/live-contract.ts), so event
 * kinds and channel names cannot drift between the emitter, the bus, the SSE
 * stream, the subscribe route and the client provider.
 */
export {
  ANNOUNCEMENTS_CHANNEL,
  BYE_REASONS,
  CHANNEL_RE,
  GLOBAL_CHANNELS,
  LIVE_TARGET_TYPES,
  MAX_EVENTS_PER_EMIT,
  MAX_SUBSCRIBE_LIST,
  NOTIFICATIONS_CHANNEL,
  channelFor,
  frameChannel,
  isContentChannel,
  parseByeFrame,
  parseLiveFrame,
  parseSubscribeRequest,
  type ByeFrame,
  type ByeReason,
  type ContentChannel,
  type GlobalChannel,
  type LiveChannel,
  type LiveEvent,
  type LiveFrame,
  type LiveSubscribeRequest,
  type LiveTargetType,
  type LiveTargetTypesMatchCommentTargets,
} from "@sinnlos/domain";
