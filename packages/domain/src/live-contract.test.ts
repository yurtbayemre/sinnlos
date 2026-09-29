import { describe, expect, it } from "vitest";

import {
  ANNOUNCEMENTS_CHANNEL,
  BYE_REASONS,
  CHANNEL_RE,
  GLOBAL_CHANNELS,
  LIVE_TARGET_TYPES,
  MAX_EVENTS_PER_EMIT,
  NOTIFICATIONS_CHANNEL,
  channelFor,
  frameChannel,
  isContentChannel,
  parseByeFrame,
  parseLiveFrame,
  type LiveFrame,
} from "./live-contract.js";
import { COMMENT_TARGET_TYPES } from "./comment-target.js";

/**
 * The live contract (LF04), one module for the cms emitter and the web bus,
 * stream, subscribe route and client provider. The cms suite
 * (apps/cms/src/utils/live-contract.test.ts) ties the channel types to the
 * cms's TARGET_UIDS.
 */
const DOC = "a0000000000000000000000b";

describe("channels", () => {
  it("names a content channel <targetType>:<documentId> for every comment target type", () => {
    expect(LIVE_TARGET_TYPES).toEqual(["announcement", "wiki-page"]);
    expect([...LIVE_TARGET_TYPES]).toEqual([...COMMENT_TARGET_TYPES]);
    for (const targetType of LIVE_TARGET_TYPES) {
      expect(channelFor({ targetType, targetDocumentId: DOC })).toBe(`${targetType}:${DOC}`);
    }
  });

  it("keeps the channel pattern of the subscribe route", () => {
    // The regex the route used before the contract, character for character.
    const legacy = /^(announcement|wiki-page):[A-Za-z0-9_-]{1,64}$/;
    const samples = [
      `announcement:${DOC}`,
      "wiki-page:demo-wiki-page-1",
      `announcement:${"x".repeat(64)}`,
      `announcement:${"x".repeat(65)}`,
      "announcement:",
      "announcement:a b",
      "announcement:a:b",
      "event:abc",
      "Announcement:abc",
      " announcement:abc",
      "notifications",
      "announcements",
    ];
    for (const sample of samples) expect(CHANNEL_RE.test(sample), sample).toBe(legacy.test(sample));
  });

  it("gives no channel to a target that cannot have one", () => {
    for (const target of [
      { targetType: "event", targetDocumentId: DOC },
      { targetType: "announcement", targetDocumentId: "" },
      { targetType: "announcement", targetDocumentId: "a/b" },
      { targetType: "announcement", targetDocumentId: null },
      { targetType: "announcement", targetDocumentId: 7 },
      { targetType: null, targetDocumentId: DOC },
      { targetType: "constructor", targetDocumentId: DOC },
    ]) {
      expect(channelFor(target), JSON.stringify(target)).toBeNull();
    }
  });

  it("global channel names never contain ':' and are never content channels", () => {
    expect(GLOBAL_CHANNELS).toEqual([NOTIFICATIONS_CHANNEL, ANNOUNCEMENTS_CHANNEL]);
    for (const channel of GLOBAL_CHANNELS) {
      expect(channel).not.toContain(":");
      expect(isContentChannel(channel)).toBe(false);
    }
  });

  it("isContentChannel refuses anything but a string content channel", () => {
    expect(isContentChannel(`wiki-page:${DOC}`)).toBe(true);
    for (const value of [undefined, null, 7, {}, [`announcement:${DOC}`], "announcement"]) {
      expect(isContentChannel(value)).toBe(false);
    }
  });
});

describe("frames", () => {
  it("maps every frame to the channel the client refetches", () => {
    const content: LiveFrame = { type: "content", channel: `announcement:${DOC}` };
    expect(frameChannel(content)).toBe(`announcement:${DOC}`);
    expect(frameChannel({ type: "notification" })).toBe(NOTIFICATIONS_CHANNEL);
    expect(frameChannel({ type: "announcements" })).toBe(ANNOUNCEMENTS_CHANNEL);
  });

  it("parses the three frames and nothing else", () => {
    expect(parseLiveFrame({ type: "content", channel: `wiki-page:${DOC}` })).toEqual({
      type: "content",
      channel: `wiki-page:${DOC}`,
    });
    expect(parseLiveFrame({ type: "notification", extra: 1 })).toEqual({ type: "notification" });
    expect(parseLiveFrame({ type: "announcements" })).toEqual({ type: "announcements" });
    for (const value of [
      null,
      "ping",
      { type: "content" },
      { type: "content", channel: "notifications" },
      { type: "content", channel: "event:abc" },
      { type: "unknown" },
    ]) {
      expect(parseLiveFrame(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("stream events (LF05)", () => {
  it("parses a bye with one of the four reasons and nothing else", () => {
    expect(BYE_REASONS).toEqual(["evicted", "shutdown", "rotate", "expired"]);
    for (const reason of BYE_REASONS) {
      expect(parseByeFrame({ reason, extra: 1 })).toEqual({ reason });
    }
    for (const value of [null, "evicted", {}, { reason: "gone" }, { reason: ["evicted"] }]) {
      expect(parseByeFrame(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("limits", () => {
  it("caps one emit POST at 1000 events (the web's parser limit)", () => {
    expect(MAX_EVENTS_PER_EMIT).toBe(1000);
  });
});
