import * as domain from "@sinnlos/domain";
import { describe, expect, it } from "vitest";

import * as audience from "./audience";
import * as classifiedShared from "./classified-shared";
import * as commentTarget from "./comment-target";
import * as entryId from "./entry-id";
import * as liveContract from "./live-contract";
import * as plainDate from "./plain-date";
import * as pollClose from "./poll-close";
import * as trainingShared from "./training-shared";

/**
 * The web modules that used to mirror cms code by hand are re-exports of
 * @sinnlos/domain now (SH01): importers kept their paths and names. Pinned
 * here, per module, which names come from the package (the very same
 * function or value the cms uses, not a local copy that could drift again)
 * and which the web keeps for itself. The package's own tests cover the
 * rules; the byte-identical mirror tests are gone with the copies.
 */
const CASES: Array<{
  module: string;
  exports: Record<string, unknown>;
  /** local name -> @sinnlos/domain name */
  fromDomain: Record<string, keyof typeof domain>;
  own: string[];
}> = [
  {
    module: "audience",
    exports: audience,
    fromDomain: {
      isAnnouncementVisibleTo: "isAnnouncementTargetedTo",
      teamIdsByUser: "teamIdsByUser",
    },
    own: [],
  },
  {
    module: "comment-target",
    exports: commentTarget,
    fromDomain: {
      anchorOf: "targetAnchor",
      matchesTarget: "matchesTarget",
      targetFilterQuery: "targetFilterQuery",
    },
    own: [],
  },
  {
    module: "entry-id",
    exports: entryId,
    fromDomain: {
      MAX_ROW_ID: "MAX_ROW_ID",
      isDocumentId: "isDocumentId",
      isRowId: "isRowId",
      parseEntryRef: "parseEntryRef",
      parseRowId: "parseRowId",
    },
    own: [],
  },
  {
    module: "live-contract",
    exports: liveContract,
    fromDomain: {
      ANNOUNCEMENTS_CHANNEL: "ANNOUNCEMENTS_CHANNEL",
      BYE_REASONS: "BYE_REASONS",
      CHANNEL_RE: "CHANNEL_RE",
      GLOBAL_CHANNELS: "GLOBAL_CHANNELS",
      LIVE_TARGET_TYPES: "LIVE_TARGET_TYPES",
      MAX_EVENTS_PER_EMIT: "MAX_EVENTS_PER_EMIT",
      MAX_SUBSCRIBE_LIST: "MAX_SUBSCRIBE_LIST",
      NOTIFICATIONS_CHANNEL: "NOTIFICATIONS_CHANNEL",
      channelFor: "channelFor",
      frameChannel: "frameChannel",
      isContentChannel: "isContentChannel",
      parseByeFrame: "parseByeFrame",
      parseLiveFrame: "parseLiveFrame",
    },
    own: [],
  },
  {
    module: "plain-date",
    exports: plainDate,
    fromDomain: {
      DEFAULT_APP_TIME_ZONE: "DEFAULT_APP_TIME_ZONE",
      addDaysToKey: "addDaysToKey",
      canonicalTimeZone: "canonicalTimeZone",
      daysBetweenKeys: "daysBetweenKeys",
      formatPlainDate: "formatPlainDate",
      instantEpochMs: "instantEpochMs",
      isPlainDate: "isPlainDate",
      isValidTimeZone: "isValidTimeZone",
      isoWeekdayOfKey: "isoWeekdayOfKey",
      resolveAppTimeZone: "resolveAppTimeZone",
      zonedDateKey: "zonedDateKey",
      zonedDayStart: "zonedDayStart",
      zonedHour: "zonedHour",
      zonedWallTimeToInstant: "zonedWallTimeToInstant",
    },
    own: [],
  },
  {
    module: "poll-close",
    exports: pollClose,
    fromDomain: {
      POLL_CLOSING_TIME: "POLL_CLOSING_TIME",
      isPollClosed: "isPollClosed",
      pollClosesAtForDay: "pollClosesAtForDay",
    },
    own: [],
  },
  {
    module: "training-shared",
    exports: trainingShared,
    fromDomain: {
      parseQuiz: "parseQuiz",
      youtubeEmbedUrl: "youtubeEmbedUrl",
      youtubeVideoId: "youtubeVideoId",
    },
    own: ["courseCompletion", "evaluateQuiz", "sortLessons"],
  },
];

describe("web modules backed by @sinnlos/domain", () => {
  it.each(CASES)("$module: hands out the package's own values", ({ exports, fromDomain }) => {
    for (const [local, name] of Object.entries(fromDomain)) {
      expect(exports[local], local).toBeDefined();
      expect(exports[local], local).toBe(domain[name]);
    }
  });

  it.each(CASES)("$module: exports nothing else but its own", ({ exports, fromDomain, own }) => {
    expect(Object.keys(exports).sort()).toEqual([...Object.keys(fromDomain), ...own].sort());
  });

  it("classified-shared takes its limits from the package", () => {
    expect(classifiedShared.MAX_AD_IMAGES).toBe(domain.CLASSIFIED_MAX_IMAGES);
    expect(classifiedShared.MAX_AD_IMAGE_MB).toBe(domain.CLASSIFIED_MAX_IMAGE_MB);
    expect(classifiedShared.MAX_AD_IMAGE_BYTES).toBe(domain.CLASSIFIED_MAX_IMAGE_BYTES);
    expect(classifiedShared.AD_IMAGE_TYPES).toEqual([...domain.CLASSIFIED_IMAGE_TYPES]);
    expect(classifiedShared.AD_DEFAULT_DURATION_DAYS).toBe(domain.CLASSIFIED_DEFAULT_LIFETIME_DAYS);
    expect(Math.max(...classifiedShared.AD_DURATION_DAYS)).toBeLessThanOrEqual(
      domain.CLASSIFIED_MAX_LIFETIME_DAYS,
    );
  });
});
