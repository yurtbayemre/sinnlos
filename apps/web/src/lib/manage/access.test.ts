import { describe, expect, it } from "vitest";
import * as roles from "@/lib/roles";
import { areaAccess, canDo, lacksDepartment, manageAreasFor } from "./access";
import {
  AREA_NEW_PATH,
  AREA_PATH,
  AREA_TYPE,
  areaItemPath,
  hasDrafts,
  MANAGE_AREAS,
} from "./areas";
import { k8Capabilities } from "./k8-capabilities.test.helper";

/**
 * What a role may do in /manage (decision 06 §L1, §L2, §N7), read from the
 * capabilities only. With batch 15's values (K8): moderators author the
 * four areas, department heads announcements and events of their own
 * department (no documents tile before 16C), everyone else nothing. With
 * this branch's own values (before 15A merges), the same functions follow
 * whatever lib/roles.ts says.
 */

const ENG = { documentId: "deptengineering000000000" };

describe("areaAccess with batch 15's capabilities (K8)", () => {
  it("moderators: every area, any item, the full verbs of each", () => {
    for (const role of ["admin_role", "editor"]) {
      const caps = k8Capabilities(roles, role);
      expect(manageAreasFor(caps), role).toEqual([
        "announcements",
        "events",
        "polls",
        "quickLinks",
      ]);
      const announcements = areaAccess(caps, "announcements");
      expect(announcements).toEqual({
        area: "announcements",
        verbs: ["create", "edit", "publish", "unpublish", "schedule", "discard", "delete"],
        scope: "any",
        roleClass: "moderator",
      });
      expect(areaAccess(caps, "polls")?.verbs).toEqual(["create", "edit", "delete"]);
    }
  });

  it("department heads: announcements and events of their department, no schedule or delete", () => {
    const caps = k8Capabilities(roles, "department_head");
    expect(manageAreasFor(caps)).toEqual(["announcements", "events"]);
    for (const area of ["announcements", "events"] as const) {
      expect(areaAccess(caps, area)).toEqual({
        area,
        verbs: ["create", "edit", "publish", "unpublish", "discard"],
        scope: "ownDepartment",
        roleClass: "departmentAuthor",
      });
    }
    expect(areaAccess(caps, "polls")).toBeNull();
    expect(areaAccess(caps, "quickLinks")).toBeNull();
    const access = areaAccess(caps, "announcements");
    expect(canDo(access, "schedule")).toBe(false);
    expect(canDo(access, "delete")).toBe(false);
  });

  it.each(["team_lead", "member", "guest", "authenticated", null, "Editor"])(
    "%s authors nothing",
    (role) => {
      expect(manageAreasFor(k8Capabilities(roles, role))).toEqual([]);
    },
  );

  it("a department author without a department authors nothing (§N1); moderators need none", () => {
    const head = areaAccess(k8Capabilities(roles, "department_head"), "events");
    expect(lacksDepartment(head, null)).toBe(true);
    expect(lacksDepartment(head, ENG)).toBe(false);
    const editor = areaAccess(k8Capabilities(roles, "editor"), "events");
    expect(lacksDepartment(editor, null)).toBe(false);
    expect(lacksDepartment(null, null)).toBe(false);
    expect(canDo(null, "create")).toBe(false);
  });
});

describe("areaAccess with this branch's capabilities (before 15A's values)", () => {
  it("follows lib/roles.ts: moderators' current verbs, nobody else", () => {
    const editor = roles.capabilitiesFor("editor");
    expect(manageAreasFor(editor)).toEqual(["announcements", "events", "polls", "quickLinks"]);
    expect(areaAccess(editor, "announcements")?.verbs).toEqual(
      ["create", "edit", "publish", "unpublish", "schedule", "discard", "delete"].filter((verb) =>
        editor.author.announcements.has(verb as roles.AuthoringVerb),
      ),
    );
    expect(manageAreasFor(roles.capabilitiesFor("member"))).toEqual([]);
  });
});

describe("the areas", () => {
  it("map to the K7 types and their pages", () => {
    expect(MANAGE_AREAS.map((area) => AREA_TYPE[area])).toEqual([
      "announcement",
      "event",
      "poll",
      "quickLink",
    ]);
    expect(AREA_PATH.quickLinks).toBe("/manage/quick-links");
    expect(AREA_NEW_PATH.polls).toBe("/manage/polls/new");
    expect(areaItemPath("events", "evnt00000000000000000001")).toBe(
      "/manage/events/evnt00000000000000000001",
    );
    expect(hasDrafts("polls")).toBe(false);
    expect(hasDrafts("quickLinks")).toBe(true);
  });
});
