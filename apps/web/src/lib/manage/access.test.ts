import { describe, expect, it } from "vitest";
import * as roles from "@/lib/roles";
import { areaAccess, canDo, lacksDepartment, manageAreasFor } from "./access";
import {
  AREA_CAPABILITY,
  AREA_NEW_PATH,
  AREA_PATH,
  AREA_TYPE,
  areaItemPath,
  hasDrafts,
  hasOwnerDepartment,
  MANAGE_AREAS,
  SCHEDULE_FIELDS,
} from "./areas";
import { k8Capabilities } from "./k8-capabilities.test.helper";

/**
 * What a role may do in /manage (decision 06 §L1, §L2, §N7), read from the
 * capabilities only. With batch 15's values (K8): moderators author the
 * six areas (the wiki through `wikiSpaces`), department heads
 * announcements, events and documents of their own department (§L1: their
 * three areas, never the wiki), everyone else nothing. The same functions
 * follow whatever lib/roles.ts says.
 */

const AREAS = ["announcements", "events", "polls", "quickLinks", "documents", "wiki", "courses"];

const ENG = { documentId: "deptengineering000000000" };

describe("areaAccess with batch 15's capabilities (K8)", () => {
  it("moderators: every area, any item, the full verbs of each", () => {
    for (const role of ["admin_role", "editor"]) {
      const caps = k8Capabilities(roles, role);
      expect(manageAreasFor(caps), role).toEqual(AREAS);
      const announcements = areaAccess(caps, "announcements");
      expect(announcements).toEqual({
        area: "announcements",
        verbs: ["create", "edit", "publish", "unpublish", "schedule", "discard", "delete"],
        scope: "any",
        roleClass: "moderator",
      });
      expect(areaAccess(caps, "polls")?.verbs).toEqual(["create", "edit", "delete"]);
      expect(areaAccess(caps, "documents")?.verbs).toEqual(announcements?.verbs);
      expect(areaAccess(caps, "wiki")).toEqual({
        area: "wiki",
        verbs: ["create", "edit", "delete"],
        scope: "any",
        roleClass: "moderator",
      });
    }
  });

  it("department heads: announcements, events and documents of their department, no schedule or delete", () => {
    const caps = k8Capabilities(roles, "department_head");
    expect(manageAreasFor(caps)).toEqual(["announcements", "events", "documents"]);
    for (const area of ["announcements", "events", "documents"] as const) {
      expect(areaAccess(caps, area)).toEqual({
        area,
        verbs: ["create", "edit", "publish", "unpublish", "discard"],
        scope: "ownDepartment",
        roleClass: "departmentAuthor",
      });
    }
    expect(areaAccess(caps, "polls")).toBeNull();
    expect(areaAccess(caps, "quickLinks")).toBeNull();
    expect(areaAccess(caps, "wiki")).toBeNull();
    const access = areaAccess(caps, "documents");
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

describe("the K8 helper and lib/roles.ts (15A's values)", () => {
  it.each([...roles.KNOWN_ROLES, null, "Editor"])(
    "%s: the same authoring verbs and scopes as capabilitiesFor",
    (role) => {
      const helper = k8Capabilities(roles, role);
      const real = roles.capabilitiesFor(role);
      for (const area of roles.AUTHORING_AREAS) {
        expect([...helper.author[area]].sort(), `${role} ${area}`).toEqual(
          [...real.author[area]].sort(),
        );
        expect(helper.authorScope[area], `${role} ${area}`).toBe(real.authorScope[area]);
      }
    },
  );
});

describe("areaAccess with lib/roles.ts's own values", () => {
  it("follows lib/roles.ts: moderators' verbs, nobody else", () => {
    const editor = roles.capabilitiesFor("editor");
    expect(manageAreasFor(editor)).toEqual(AREAS);
    expect(manageAreasFor(roles.capabilitiesFor("department_head"))).toEqual([
      "announcements",
      "events",
      "documents",
    ]);
    expect(manageAreasFor(roles.capabilitiesFor("team_lead"))).toEqual([]);
    expect(areaAccess(editor, "announcements")?.verbs).toEqual(
      ["create", "edit", "publish", "unpublish", "schedule", "discard", "delete"].filter((verb) =>
        editor.author.announcements.has(verb as roles.AuthoringVerb),
      ),
    );
    expect(manageAreasFor(roles.capabilitiesFor("member"))).toEqual([]);
  });
});

describe("the areas", () => {
  it("map to the K7 types, their capability areas and their pages", () => {
    const typed = MANAGE_AREAS.filter((area) => area !== "wiki");
    expect(typed.map((area) => AREA_TYPE[area])).toEqual([
      "announcement",
      "event",
      "poll",
      "quickLink",
      "document",
      "course",
    ]);
    expect(MANAGE_AREAS.map((area) => AREA_CAPABILITY[area])).toEqual([
      "announcements",
      "events",
      "polls",
      "quickLinks",
      "documents",
      "wikiSpaces",
      "courses",
    ]);
    for (const area of MANAGE_AREAS) {
      expect(roles.AUTHORING_AREAS).toContain(AREA_CAPABILITY[area]);
    }
    expect(AREA_PATH.documents).toBe("/manage/documents");
    expect(AREA_PATH.wiki).toBe("/manage/wiki");
    expect(AREA_NEW_PATH.wiki).toBe("/manage/wiki/new");
    expect(areaItemPath("wiki", "spce00000000000000000001")).toBe(
      "/manage/wiki/spce00000000000000000001",
    );
    expect(hasDrafts("documents")).toBe(true);
    expect(SCHEDULE_FIELDS.documents).toEqual(["publishAt", "unpublishAt"]);
    expect(SCHEDULE_FIELDS.wiki).toEqual(["publishAt"]);
    expect(hasOwnerDepartment("documents")).toBe(true);
    expect(hasOwnerDepartment("quickLinks")).toBe(false);
    expect(AREA_PATH.quickLinks).toBe("/manage/quick-links");
    expect(AREA_NEW_PATH.polls).toBe("/manage/polls/new");
    expect(areaItemPath("events", "evnt00000000000000000001")).toBe(
      "/manage/events/evnt00000000000000000001",
    );
    expect(hasDrafts("polls")).toBe(false);
    expect(hasDrafts("quickLinks")).toBe(true);
  });
});
