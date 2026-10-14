import { describe, expect, it } from "vitest";

import { AUTHORING_FIELD_CODES, AUTHORING_FORM_CODES } from "./codes.js";
import {
  WIKI_EDITOR_CLASSES,
  WIKI_FIELDS,
  WIKI_PAGE_AUTHOR_CREATE_FIELDS,
  WIKI_PAGE_CONTENT_FIELDS,
  WIKI_PAGE_INTENTS,
  WIKI_PAGE_MODERATOR_CREATE_FIELDS,
  WIKI_PAGE_MODERATOR_UPDATE_FIELDS,
  WIKI_PAGE_ROW_EDIT_FIELDS,
  WIKI_PATHS,
  WIKI_SPACE_INTENTS,
  WIKI_SPACE_MODERATOR_FIELDS,
  WIKI_SPACE_VISIBILITIES,
  wikiPageRoute,
  wikiRequestPath,
  wikiSpaceRoute,
} from "./wiki.js";

/**
 * Contract K18 of batch 16 (decision 06 §J1, §J2): the wiki's fields per
 * class and its route table. A change here is a contract change for the cms
 * (authoring-routes.test.ts, write-allowlist.test.ts) and the web.
 */

describe("wiki codes", () => {
  it("has parentCycle on fields and spaceNotEmpty on the form", () => {
    expect(AUTHORING_FIELD_CODES).toContain("parentCycle");
    expect(AUTHORING_FIELD_CODES).toContain("visibilityTarget");
    expect(AUTHORING_FORM_CODES).toContain("spaceNotEmpty");
  });
});

describe("wiki fields per class", () => {
  it("gives spaces one moderator list for create and update", () => {
    expect([...WIKI_SPACE_MODERATOR_FIELDS]).toEqual([
      "name",
      "icon",
      "description",
      "visibility",
      "allowedRoles",
      "department",
      "team",
    ]);
    expect(WIKI_FIELDS.wikiSpace.create.moderator).toBe(WIKI_SPACE_MODERATOR_FIELDS);
    expect(WIKI_FIELDS.wikiSpace.update.moderator).toBe(WIKI_SPACE_MODERATOR_FIELDS);
    expect([...WIKI_SPACE_VISIBILITIES]).toEqual(["public", "role", "department", "team"]);
  });

  it("keeps the author classes to content and parent; space only on create", () => {
    expect([...WIKI_PAGE_CONTENT_FIELDS]).toEqual([
      "title",
      "body",
      "summary",
      "tags",
      "tocEnabled",
      "order",
    ]);
    expect([...WIKI_PAGE_AUTHOR_CREATE_FIELDS]).toEqual([
      ...WIKI_PAGE_CONTENT_FIELDS,
      "space",
      "parent",
    ]);
    expect([...WIKI_PAGE_ROW_EDIT_FIELDS]).toEqual([
      ...WIKI_PAGE_CONTENT_FIELDS,
      "parent",
      "revisionSummary",
    ]);
    for (const roleClass of ["author", "departmentHead", "teamLead"] as const) {
      expect(WIKI_FIELDS.wikiPage.update[roleClass]).toBe(WIKI_PAGE_ROW_EDIT_FIELDS);
    }
    expect(WIKI_FIELDS.wikiPage.create.author).toBe(WIKI_PAGE_AUTHOR_CREATE_FIELDS);
  });

  it("gives moderators department, team and the schedule, but no space move or slug", () => {
    expect([...WIKI_PAGE_MODERATOR_UPDATE_FIELDS]).toEqual(
      WIKI_PAGE_MODERATOR_CREATE_FIELDS.filter((field) => field !== "space"),
    );
    for (const fields of [WIKI_PAGE_MODERATOR_CREATE_FIELDS, WIKI_PAGE_MODERATOR_UPDATE_FIELDS]) {
      expect(fields).toEqual(expect.arrayContaining(["department", "team", "publishAt"]));
      expect(fields).not.toContain("slug");
    }
    // Wiki authors never schedule (owner answer 11) and never set targeting.
    for (const fields of [WIKI_PAGE_AUTHOR_CREATE_FIELDS, WIKI_PAGE_ROW_EDIT_FIELDS]) {
      for (const key of ["publishAt", "department", "team", "slug", "author", "lastEditor"]) {
        expect(fields as readonly string[], key).not.toContain(key);
      }
    }
    expect([...WIKI_EDITOR_CLASSES]).toEqual(["moderator", "author", "departmentHead", "teamLead"]);
  });
});

describe("wiki route table (§J2, §B3)", () => {
  it("maps the types to the schemas' plural paths", () => {
    expect(WIKI_PATHS).toEqual({ wikiSpace: "wiki-spaces", wikiPage: "wiki-pages" });
  });

  it("gives spaces the poll shape: no publish, unpublish or discard", () => {
    expect([...WIKI_SPACE_INTENTS]).toEqual([
      "create",
      "update",
      "delete",
      "authoringList",
      "editable",
    ]);
    expect(wikiSpaceRoute("delete")).toEqual({
      method: "DELETE",
      path: "/wiki-spaces/:documentId",
      ifMatch: true,
    });
    expect(wikiSpaceRoute("authoringList")).toEqual({
      method: "GET",
      path: "/wiki-spaces/authoring",
      ifMatch: false,
    });
  });

  it("serves the eleven page actions of §J2 plus the generic create, update and delete", () => {
    expect(
      WIKI_PAGE_INTENTS.map((intent) => {
        const route = wikiPageRoute(intent);
        return `${intent} ${route.method} ${route.path}${route.ifMatch ? " If-Match" : ""}`;
      }),
    ).toEqual([
      "create POST /wiki-pages",
      "update PUT /wiki-pages/:documentId If-Match",
      "delete DELETE /wiki-pages/:documentId If-Match",
      "createDraft POST /wiki-pages/drafts",
      "myDrafts GET /wiki-pages/drafts/mine",
      "editable GET /wiki-pages/:documentId/editable",
      "saveDraft PUT /wiki-pages/:documentId/draft If-Match",
      "publish POST /wiki-pages/:documentId/publish If-Match",
      "discardDraft POST /wiki-pages/:documentId/discard-draft If-Match",
      "unpublish POST /wiki-pages/:documentId/unpublish If-Match",
      "authoringList GET /wiki-pages/authoring",
      "revisions GET /wiki-pages/:documentId/revisions",
      "revision GET /wiki-pages/:documentId/revisions/:revisionId",
      "restore POST /wiki-pages/:documentId/restore If-Match",
    ]);
    expect(
      WIKI_PAGE_INTENTS.filter((i) => !["create", "update", "delete"].includes(i)),
    ).toHaveLength(11);
  });

  it("builds request paths with encoded ids", () => {
    expect(wikiRequestPath(wikiPageRoute("revision"), { documentId: "a/b", revisionId: 7 })).toBe(
      "/api/wiki-pages/a%2Fb/revisions/7",
    );
    expect(wikiRequestPath(wikiSpaceRoute("authoringList"))).toBe("/api/wiki-spaces/authoring");
    expect(() => wikiRequestPath(wikiPageRoute("publish"))).toThrow(/documentId/);
    expect(() => wikiRequestPath(wikiPageRoute("revision"), { documentId: "x" })).toThrow(
      /revisionId/,
    );
  });
});
