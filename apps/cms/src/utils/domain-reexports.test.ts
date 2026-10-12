import * as domain from "@sinnlos/domain";
import { describe, expect, it } from "vitest";

import * as roles from "../bootstrap/roles";
import * as announcementAudience from "./announcement-audience";
import * as classifiedExpiry from "./classified-expiry";
import * as commentTarget from "./comment-target";
import * as entryId from "./entry-id";
import * as liveContract from "./live-contract";
import * as plainDate from "./plain-date";
import * as pollClose from "./poll-close";
import * as trainingValidation from "./training-validation";
import * as uploadGuard from "./upload-guard";

/**
 * The cms modules that used to be mirrored by hand in the web (SH01) are
 * re-exports of @sinnlos/domain now: importers kept their paths and names.
 * Pinned here, per module, which names come from the package (the very same
 * function or value, not a local copy that could drift again) and which the
 * cms keeps for itself (database lookups, the Strapi uids, the role seed,
 * the lifecycle payload check). The package's own tests cover the rules.
 */
const CASES: Array<{
  module: string;
  exports: Record<string, unknown>;
  /** local name -> @sinnlos/domain name */
  fromDomain: Record<string, keyof typeof domain>;
  own: string[];
}> = [
  {
    module: "utils/announcement-audience",
    exports: announcementAudience,
    fromDomain: { isAnnouncementVisible: "isAnnouncementTargetedTo" },
    own: [],
  },
  {
    module: "utils/comment-target",
    exports: commentTarget,
    fromDomain: {
      anchorFromTargetRow: "anchorFromTargetRow",
      isCommentTargetType: "isCommentTargetType",
      targetAnchor: "targetAnchor",
      targetMatchWhere: "targetMatchWhere",
    },
    own: [
      "TARGET_UIDS",
      "WRITE_TARGET_ERRORS",
      "findCommentTarget",
      "resolveWriteTarget",
      "targetUid",
    ],
  },
  {
    module: "utils/entry-id",
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
    module: "utils/live-contract",
    exports: liveContract,
    fromDomain: {
      ANNOUNCEMENTS_CHANNEL: "ANNOUNCEMENTS_CHANNEL",
      CHANNEL_RE: "CHANNEL_RE",
      GLOBAL_CHANNELS: "GLOBAL_CHANNELS",
      LIVE_TARGET_TYPES: "LIVE_TARGET_TYPES",
      MAX_EVENTS_PER_EMIT: "MAX_EVENTS_PER_EMIT",
      MAX_SUBSCRIBE_LIST: "MAX_SUBSCRIBE_LIST",
      NOTIFICATIONS_CHANNEL: "NOTIFICATIONS_CHANNEL",
      channelFor: "channelFor",
      frameChannel: "frameChannel",
      isContentChannel: "isContentChannel",
      parseLiveFrame: "parseLiveFrame",
    },
    own: [],
  },
  {
    module: "utils/plain-date",
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
    module: "utils/poll-close",
    exports: pollClose,
    fromDomain: { isPollClosed: "isPollClosed" },
    own: [],
  },
  {
    module: "utils/training-validation",
    exports: trainingValidation,
    fromDomain: { validateQuiz: "validateQuiz", youtubeVideoId: "youtubeVideoId" },
    own: ["QUIZ_NOT_JSON_ERROR", "validateLessonData"],
  },
  {
    module: "bootstrap/roles",
    exports: roles,
    fromDomain: {
      ADMIN: "ADMIN",
      AUTHENTICATED: "AUTHENTICATED",
      GUEST: "GUEST",
      MODERATORS: "MODERATORS",
      ROLE_PRIVILEGE_ORDER: "ROLE_PRIVILEGE_ORDER",
      STAFF_ROLES: "STAFF_ROLES",
      hasRole: "hasRole",
      isRoleType: "isRoleType",
    },
    own: ["ROLES"],
  },
];

describe("cms modules backed by @sinnlos/domain", () => {
  it.each(CASES)("$module: hands out the package's own values", ({ exports, fromDomain }) => {
    for (const [local, name] of Object.entries(fromDomain)) {
      expect(exports[local], local).toBeDefined();
      expect(exports[local], local).toBe(domain[name]);
    }
  });

  it.each(CASES)("$module: exports nothing else but its own", ({ exports, fromDomain, own }) => {
    expect(Object.keys(exports).sort()).toEqual([...Object.keys(fromDomain), ...own].sort());
  });

  it("enforces the package's marketplace limits", () => {
    expect(uploadGuard.MAX_FILES_PER_REQUEST).toBe(domain.CLASSIFIED_MAX_IMAGES);
    expect(uploadGuard.MAX_FILE_BYTES).toBe(domain.CLASSIFIED_MAX_IMAGE_BYTES);
    expect(Object.keys(uploadGuard.CANONICAL_EXTENSION).sort()).toEqual(
      [...domain.CLASSIFIED_IMAGE_TYPES].sort(),
    );
    expect(classifiedExpiry.DEFAULT_LIFETIME_DAYS).toBe(domain.CLASSIFIED_DEFAULT_LIFETIME_DAYS);
    expect(classifiedExpiry.MAX_LIFETIME_DAYS).toBe(domain.CLASSIFIED_MAX_LIFETIME_DAYS);
  });
});
