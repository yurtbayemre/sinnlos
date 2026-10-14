import { describe, expect, it } from "vitest";

import {
  WIKI_PAGE_CREATOR_ROLES,
  WIKI_ROW_EDITOR_ROLES,
  canCreateWikiPages,
  classifyWikiEditor,
  type WikiEditPage,
  type WikiEditViewer,
} from "./wiki-edit.js";

/**
 * The one wiki row rule (contract K17), as one table the cms gate
 * (can-edit-wiki.test.ts) and the web buttons share: viewer x page → class.
 */

const PAGE: WikiEditPage = { authorId: 10, departmentId: 3, teamLeadId: 20 };

const viewer = (
  role: string | null,
  userId: number | null,
  departmentId: number | null = null,
): WikiEditViewer => ({ role, userId, departmentId });

describe("classifyWikiEditor", () => {
  it.each([
    // [who, viewer, expected]
    ["admin_role on any page", viewer("admin_role", 99), "moderator"],
    ["editor on any page", viewer("editor", 99), "moderator"],
    ["the author (member)", viewer("member", 10), "author"],
    ["the author (team_lead) before the team-lead match", viewer("team_lead", 10), "author"],
    ["the author (department_head)", viewer("department_head", 10, 9), "author"],
    ["the head of the page's department", viewer("department_head", 11, 3), "departmentHead"],
    ["a head of another department", viewer("department_head", 11, 4), null],
    ["a head without a department", viewer("department_head", 11, null), null],
    ["the lead of the page's team", viewer("team_lead", 20), "teamLead"],
    ["another team lead", viewer("team_lead", 21), null],
    ["a member who is not the author", viewer("member", 11, 3), null],
    ["a member in the page's department", viewer("member", 12, 3), null],
    ["a team lead who is the page's department member", viewer("team_lead", 21, 3), null],
    ["a guest author", viewer("guest", 10), null],
    ["an `authenticated` author", viewer("authenticated", 10), null],
    ["no role", viewer(null, 10), null],
    ["no user id", viewer("member", null), null],
  ] as const)("%s", (_who, who, expected) => {
    expect(classifyWikiEditor(who, PAGE)).toBe(expected);
  });

  it("never matches on missing ids", () => {
    const empty: WikiEditPage = { authorId: null, departmentId: null, teamLeadId: undefined };
    expect(classifyWikiEditor(viewer("department_head", 11, null), empty)).toBeNull();
    expect(classifyWikiEditor(viewer("team_lead", 0), { ...empty, teamLeadId: 0 })).toBeNull();
    expect(classifyWikiEditor(viewer("member", 10), { ...PAGE, authorId: undefined })).toBeNull();
    expect(classifyWikiEditor(viewer("editor", null), empty)).toBe("moderator");
  });

  it("matches the roles exactly", () => {
    expect(classifyWikiEditor(viewer("Editor", 1), PAGE)).toBeNull();
    expect(classifyWikiEditor(viewer(" member", 10), PAGE)).toBeNull();
  });
});

describe("the wiki roles", () => {
  it("lists the row editors and the creators", () => {
    expect([...WIKI_ROW_EDITOR_ROLES]).toEqual(["department_head", "team_lead", "member"]);
    expect([...WIKI_PAGE_CREATOR_ROLES]).toEqual([
      "admin_role",
      "editor",
      "department_head",
      "team_lead",
    ]);
    expect(canCreateWikiPages("team_lead")).toBe(true);
    expect(canCreateWikiPages("member")).toBe(false);
    expect(canCreateWikiPages(undefined)).toBe(false);
  });
});
