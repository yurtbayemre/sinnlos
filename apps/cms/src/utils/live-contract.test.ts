import { describe, expect, it } from "vitest";

import { TARGET_UIDS } from "./comment-target";
import { CHANNEL_RE, LIVE_TARGET_TYPES, channelFor } from "./live-contract";

/**
 * The cms copy of the live contract (LF04). It is byte-identical to the web
 * copy (apps/web/src/lib/live-contract-mirror.test.ts), which carries the
 * behaviour tests; this suite ties the channel types to the cms's own list
 * of comment targets.
 */
describe("live contract (cms)", () => {
  it("has a content channel for exactly the comment target types", () => {
    expect([...LIVE_TARGET_TYPES].sort()).toEqual(Object.keys(TARGET_UIDS).sort());
  });

  it("builds a channel every subscribe route accepts for each target type", () => {
    for (const targetType of Object.keys(TARGET_UIDS)) {
      const channel = channelFor({ targetType, targetDocumentId: "a0000000000000000000000b" });
      expect(channel).toBe(`${targetType}:a0000000000000000000000b`);
      expect(CHANNEL_RE.test(channel ?? "")).toBe(true);
    }
  });
});
