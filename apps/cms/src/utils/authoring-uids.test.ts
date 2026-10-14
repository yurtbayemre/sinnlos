import { describe, expect, it } from "vitest";

import {
  AUDITED_UIDS,
  AUTHORED_UIDS,
  DEPARTMENT_AUTHORED_UIDS,
  GUARDED_UIDS,
  SCHEDULED_UIDS,
  UNPUBLISH_SCHEDULED_UIDS,
  isGuardedUid,
  isScheduledUid,
} from "./authoring-uids";
import { loadContentTypeSchemas } from "../test/strapi-stub.test.helper";

/**
 * The uid lists of v2 authoring (contract K1), pinned entry by entry: a
 * change here changes who is locked, scheduled, audited or gated.
 */
const SCHEMAS = loadContentTypeSchemas();
const attributesOf = (uid: string) => SCHEMAS[uid]?.attributes ?? {};

describe("authoring uid lists (K1)", () => {
  it("names the lists exactly", () => {
    expect(AUTHORED_UIDS).toEqual([
      "api::announcement.announcement",
      "api::event.event",
      "api::quick-link.quick-link",
      "api::document.document",
      "api::poll.poll",
      "api::wiki-space.wiki-space",
      "api::wiki-page.wiki-page",
    ]);
    expect(DEPARTMENT_AUTHORED_UIDS).toEqual([
      "api::announcement.announcement",
      "api::event.event",
      "api::document.document",
    ]);
    expect(SCHEDULED_UIDS).toEqual([
      "api::announcement.announcement",
      "api::event.event",
      "api::document.document",
      "api::quick-link.quick-link",
      "api::wiki-page.wiki-page",
      "api::course.course",
      "api::lesson.lesson",
    ]);
    expect(UNPUBLISH_SCHEDULED_UIDS).toEqual([
      "api::document.document",
      "api::quick-link.quick-link",
    ]);
    expect(GUARDED_UIDS).toEqual([
      ...SCHEDULED_UIDS,
      "api::poll.poll",
      "api::wiki-space.wiki-space",
      "api::department.department",
      "api::team.team",
    ]);
    expect(AUDITED_UIDS).toEqual(GUARDED_UIDS);
  });

  it("schedules no poll", () => {
    expect(SCHEDULED_UIDS).not.toContain("api::poll.poll");
    expect(isScheduledUid("api::poll.poll")).toBe(false);
    expect(isGuardedUid("api::poll.poll")).toBe(true);
    expect(isGuardedUid("plugin::users-permissions.user")).toBe(false);
    expect(isGuardedUid(undefined)).toBe(false);
  });

  it("every listed uid has a schema; the nested lists are subsets", () => {
    for (const uid of GUARDED_UIDS) expect(SCHEMAS[uid], uid).toBeDefined();
    for (const uid of [...AUTHORED_UIDS, ...DEPARTMENT_AUTHORED_UIDS]) {
      expect(GUARDED_UIDS, uid).toContain(uid);
    }
    for (const uid of UNPUBLISH_SCHEDULED_UIDS) expect(SCHEDULED_UIDS, uid).toContain(uid);
  });

  it("matches the schema fields (K4): schedule fields exactly on the scheduled types", () => {
    for (const [uid, schema] of Object.entries(SCHEMAS)) {
      const attributes = schema.attributes ?? {};
      expect("publishAt" in attributes, uid).toBe(SCHEDULED_UIDS.includes(uid));
      expect("scheduleError" in attributes, uid).toBe(SCHEDULED_UIDS.includes(uid));
      expect("unpublishAt" in attributes, uid).toBe(UNPUBLISH_SCHEDULED_UIDS.includes(uid));
      expect("ownerDepartment" in attributes, uid).toBe(DEPARTMENT_AUTHORED_UIDS.includes(uid));
    }
    for (const uid of SCHEDULED_UIDS) {
      expect(attributesOf(uid).publishAt, uid).toEqual({ type: "datetime" });
      expect(attributesOf(uid).scheduleError, uid).toEqual({ type: "string" });
    }
    for (const uid of UNPUBLISH_SCHEDULED_UIDS) {
      expect(attributesOf(uid).unpublishAt, uid).toEqual({ type: "datetime" });
    }
    for (const uid of DEPARTMENT_AUTHORED_UIDS) {
      // manyToOne without an inverse: a department delete cascades the link.
      expect(attributesOf(uid).ownerDepartment, uid).toEqual({
        type: "relation",
        relation: "manyToOne",
        target: "api::department.department",
      });
    }
    expect(attributesOf("api::event.event").notifyAudience).toEqual({
      type: "enumeration",
      enum: ["all", "departments"],
      default: "all",
    });
    expect(attributesOf("api::announcement.announcement").retargetRequired).toEqual({
      type: "boolean",
      default: false,
    });
  });
});
