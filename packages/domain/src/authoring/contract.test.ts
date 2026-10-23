import { describe, expect, it } from "vitest";
import { DEPARTMENT_AUTHOR_ROLES_OF } from "../roles.js";

import {
  AUTHORING_CODES,
  AUTHORING_FIELD_CODES,
  AUTHORING_FORM_CODES,
  FORM_KEY,
  STATUS_KEY,
  isAuthoringCode,
} from "./codes.js";
import {
  ANNOUNCEMENT_DEPARTMENT_AUTHOR_FIELDS,
  ANNOUNCEMENT_MODERATOR_FIELDS,
  AUTHORING_FIELDS,
  AUTHORING_TYPES,
  DEPARTMENT_AUTHORED_TYPES,
  DOCUMENT_DEPARTMENT_AUTHOR_FIELDS,
  DOCUMENT_MODERATOR_FIELDS,
  EVENT_DEPARTMENT_AUTHOR_FIELDS,
  EVENT_MODERATOR_FIELDS,
  TARGETING_KEYS,
} from "./fields.js";
import {
  AUTHORING_INTENTS,
  AUTHORING_PATHS,
  AUTHORING_STATUS_MODES,
  authoringPath,
  authoringRoute,
  ifMatch,
  versionFromEtag,
} from "./http.js";
import { ICON_KEYS, isIconKey } from "./icons.js";
import {
  MAX_POLL_OPTIONS,
  MAX_POLL_OPTION_LENGTH,
  MIN_POLL_OPTIONS,
  pollOptionsCode,
  samePollOptions,
  validatePollOptions,
} from "./poll-options.js";

/**
 * Contract K7 of batch 15 (decision 06 §B1-§B3, §N6): the codes, the field
 * lists per class, the route table and the poll-option bounds the cms and
 * the web share. A change here is a contract change for both apps.
 */

describe("codes", () => {
  it("lists the field codes of §B1.4 plus the poll and acknowledgement codes", () => {
    expect([...AUTHORING_FIELD_CODES].sort()).toEqual(
      [
        "invalid",
        "required",
        "tooLong",
        "invalidInstant",
        "invalidDate",
        "invalidUrl",
        "endBeforeStart",
        "notMidnight",
        "scheduleInPast",
        "unpublishBeforePublish",
        "expiresBeforePublish",
        "ackDeadlineWithoutAck",
        "notPublishable",
        "videoUrlNotYoutube",
        "quizInvalid",
        "frozenAfterVotes",
        "visibilityTarget",
        "optionCount",
        "optionDuplicate",
        "fileType",
        "fileTooLarge",
        "parentCycle",
        "taken",
        // User administration (v0.23).
        "selfChange",
        "entraManaged",
        "managerCycle",
      ].sort(),
    );
    expect([...AUTHORING_FORM_CODES]).toEqual([
      "neverPublished",
      "spaceNotEmpty",
      "notEntraBound",
      "anonymised",
    ]);
    expect(AUTHORING_CODES).toHaveLength(
      AUTHORING_FIELD_CODES.length + AUTHORING_FORM_CODES.length,
    );
    expect(new Set(AUTHORING_CODES).size).toBe(AUTHORING_CODES.length);
  });

  it("names the two non-attribute keys", () => {
    expect(FORM_KEY).toBe("_form");
    expect(STATUS_KEY).toBe("status");
    expect(isAuthoringCode("neverPublished")).toBe(true);
    expect(isAuthoringCode("fileType")).toBe(true);
    expect(isAuthoringCode("notACode")).toBe(false);
  });
});

describe("field lists per class (§N6)", () => {
  it("covers the seven types; department authors only on announcement, event, document, duty plan, kpi", () => {
    expect([...AUTHORING_TYPES]).toEqual([
      "announcement",
      "event",
      "quickLink",
      "document",
      "poll",
      "dutyPlan",
      "kpi",
    ]);
    for (const type of AUTHORING_TYPES) {
      expect(AUTHORING_FIELDS[type].moderator, type).toBeDefined();
      expect(AUTHORING_FIELDS[type].departmentAuthor !== undefined, type).toBe(
        DEPARTMENT_AUTHORED_TYPES.includes(type),
      );
    }
  });

  it("keeps department authors off pinning, acknowledgements and schedules", () => {
    const moderatorOnly = ["pinned", "requiresAck", "ackDeadline", "publishAt", "unpublishAt"];
    for (const type of DEPARTMENT_AUTHORED_TYPES) {
      const fields = AUTHORING_FIELDS[type].departmentAuthor ?? [];
      expect(
        fields.filter((field) => moderatorOnly.includes(field)),
        type,
      ).toEqual([]);
      // Every department-author field is a moderator field too.
      const moderator = AUTHORING_FIELDS[type].moderator ?? [];
      expect(
        fields.filter((field) => !moderator.includes(field)),
        type,
      ).toEqual([]);
    }
    expect([...ANNOUNCEMENT_DEPARTMENT_AUTHOR_FIELDS]).toEqual(
      ANNOUNCEMENT_MODERATOR_FIELDS.filter(
        (field) => !["pinned", "requiresAck", "ackDeadline", "publishAt"].includes(field),
      ),
    );
    expect([...EVENT_DEPARTMENT_AUTHOR_FIELDS]).toEqual(
      EVENT_MODERATOR_FIELDS.filter((field) => field !== "publishAt"),
    );
    expect([...DOCUMENT_DEPARTMENT_AUTHOR_FIELDS]).toEqual(
      DOCUMENT_MODERATOR_FIELDS.filter(
        (field) => !["requiresAck", "publishAt", "unpublishAt"].includes(field),
      ),
    );
  });

  it("never lists a derived or bookkeeping attribute", () => {
    const never = [
      "audience",
      "notifyAudience",
      "retargetRequired",
      "author",
      "organizer",
      "uploadedBy",
      "ownerDepartment",
      "scheduleError",
      "id",
      "documentId",
      "publishedAt",
      "locale",
    ];
    for (const type of AUTHORING_TYPES) {
      for (const fields of Object.values(AUTHORING_FIELDS[type])) {
        expect(
          (fields ?? []).filter((field) => never.includes(field)),
          type,
        ).toEqual([]);
      }
    }
  });

  it("lists the document file for both classes (batch 16, K18)", () => {
    expect(DOCUMENT_MODERATOR_FIELDS).toContain("file");
    expect(DOCUMENT_DEPARTMENT_AUTHOR_FIELDS).toContain("file");
    for (const type of ["announcement", "event", "quickLink", "poll"] as const) {
      for (const fields of Object.values(AUTHORING_FIELDS[type])) {
        expect(fields ?? [], type).not.toContain("file");
      }
    }
  });

  it("names each type's targeting keys", () => {
    expect(TARGETING_KEYS.announcement).toEqual(["department", "team", "audienceRoles"]);
    for (const type of ["event", "quickLink", "document", "poll"] as const) {
      expect(TARGETING_KEYS[type]).toEqual(["departments"]);
    }
  });
});

describe("route table (§B3)", () => {
  it("maps the types to their plural paths and status modes", () => {
    expect(AUTHORING_PATHS).toEqual({
      announcement: "announcements",
      event: "events",
      quickLink: "quick-links",
      document: "documents",
      poll: "polls",
      dutyPlan: "duty-plans",
      kpi: "kpis",
    });
    expect(AUTHORING_STATUS_MODES.poll).toBe("alwaysPublished");
    for (const type of [
      "announcement",
      "event",
      "quickLink",
      "document",
      "dutyPlan",
      "kpi",
    ] as const) {
      expect(AUTHORING_STATUS_MODES[type]).toBe("explicit");
    }
  });

  it("lets team leads author duty plans only, next to department heads (owner decision 2026-10-20)", () => {
    expect([...DEPARTMENT_AUTHOR_ROLES_OF.dutyPlan]).toEqual(["department_head", "team_lead"]);
    for (const type of ["announcement", "event", "document", "kpi"] as const) {
      expect([...DEPARTMENT_AUTHOR_ROLES_OF[type]], type).toEqual(["department_head"]);
    }
    for (const type of AUTHORING_TYPES) {
      expect(DEPARTMENT_AUTHOR_ROLES_OF[type].length > 0, type).toBe(
        DEPARTMENT_AUTHORED_TYPES.includes(type),
      );
    }
  });

  it("gives polls no publish, unpublish or discard", () => {
    expect([...AUTHORING_INTENTS.poll]).toEqual([
      "create",
      "update",
      "delete",
      "authoringList",
      "editable",
    ]);
  });

  it("builds the paths and preconditions", () => {
    expect(authoringRoute("announcement", "create")).toEqual({
      method: "POST",
      path: "/announcements",
      ifMatch: false,
    });
    expect(authoringRoute("quickLink", "discardDraft")).toEqual({
      method: "POST",
      path: "/quick-links/:documentId/discard-draft",
      ifMatch: true,
    });
    expect(authoringRoute("event", "authoringList")).toEqual({
      method: "GET",
      path: "/events/authoring",
      ifMatch: false,
    });
    expect(authoringRoute("document", "delete").ifMatch).toBe(true);
    expect(authoringRoute("poll", "editable").ifMatch).toBe(false);
    expect(authoringPath("event", "publish", "abc123")).toBe("/api/events/abc123/publish");
    expect(authoringPath("poll", "authoringList")).toBe("/api/polls/authoring");
    expect(() => authoringPath("event", "update")).toThrow();
  });

  it("formats If-Match and reads an ETag back", () => {
    expect(ifMatch("7")).toBe('"7"');
    expect(ifMatch(12)).toBe('"12"');
    expect(versionFromEtag('"7"')).toBe("7");
    expect(versionFromEtag('W/"7"')).toBe("7");
    expect(versionFromEtag("7")).toBe("7");
    expect(versionFromEtag('"x"')).toBeNull();
    expect(versionFromEtag(null)).toBeNull();
  });
});

describe("icons", () => {
  it("lists unique names, exact case", () => {
    expect(new Set(ICON_KEYS).size).toBe(ICON_KEYS.length);
    expect(isIconKey("Megaphone")).toBe(true);
    expect(isIconKey("megaphone")).toBe(false);
    expect(isIconKey("toString")).toBe(false);
  });
});

describe("poll options (batch 15 plan item 2b)", () => {
  const options = (count: number) => Array.from({ length: count }, (_, i) => `Answer ${i + 1}`);

  it("bounds a poll at 2 to 20 answers of at most 200 characters", () => {
    expect([MIN_POLL_OPTIONS, MAX_POLL_OPTIONS, MAX_POLL_OPTION_LENGTH]).toEqual([2, 20, 200]);
    for (const count of [2, 10, 11, 20]) {
      expect(validatePollOptions(options(count)), String(count)).toEqual({
        options: options(count),
      });
      expect(pollOptionsCode(options(count), { maxLength: 200 }), String(count)).toBeNull();
    }
    for (const count of [0, 1, 21]) {
      expect("error" in validatePollOptions(options(count)), String(count)).toBe(true);
      expect(pollOptionsCode(options(count)), String(count)).toBe("optionCount");
    }
  });

  it("answers a code per kind of refusal", () => {
    expect(pollOptionsCode("Yes,No")).toBe("invalid");
    expect(pollOptionsCode(["Yes", 2])).toBe("invalid");
    expect(pollOptionsCode(["Yes", " "])).toBe("required");
    expect(pollOptionsCode(["Yes", " Yes"])).toBe("optionDuplicate");
    expect(pollOptionsCode(["x".repeat(201), "No"], { maxLength: 200 })).toBe("tooLong");
    expect(pollOptionsCode([` ${"x".repeat(200)} `, "No"], { maxLength: 200 })).toBeNull();
    // Without maxLength (the lifecycle's view) the length is not checked.
    expect(pollOptionsCode(["x".repeat(201), "No"])).toBeNull();
  });

  it("compares options index by index after trimming", () => {
    expect(samePollOptions(["A", "B"], [" A", "B "])).toBe(true);
    expect(samePollOptions(["A", "B"], ["B", "A"])).toBe(false);
    expect(samePollOptions(["A", "B"], ["A", "B", "C"])).toBe(false);
    expect(samePollOptions(["A", "B"], ["A", "C"])).toBe(false);
    expect(samePollOptions(null, null)).toBe(true);
    expect(samePollOptions(["A"], null)).toBe(false);
  });
});
