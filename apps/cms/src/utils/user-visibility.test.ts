import { describe, expect, it } from "vitest";

import { USER_UID } from "./sanitize-user-contact";
import { ACTIVE_USER_FILTER, hideBlockedUsers, type VisibilityModel } from "./user-visibility";

/**
 * Blocked people hidden from the directory (v0.28): the pure query rewrite
 * the sanitize.query wrapper applies. The real-HTTP proof is
 * integration/blocked-users.integration.test.ts.
 */

const DEPARTMENT = "api::department.department";
const TEAM = "api::team.team";
const ANNOUNCEMENT = "api::announcement.announcement";
const WIKI_PAGE = "api::wiki-page.wiki-page";

const MODELS: Record<string, VisibilityModel> = {
  [USER_UID]: {
    uid: USER_UID,
    attributes: {
      username: { type: "string" },
      email: { type: "email" },
      phone: { type: "string" },
      jobTitle: { type: "string" },
      displayName: { type: "string" },
      blocked: { type: "boolean" },
      password: { type: "password", private: true },
      role: { type: "relation", target: "plugin::users-permissions.role" },
      department: { type: "relation", target: DEPARTMENT },
      teams: { type: "relation", target: TEAM },
      manager: { type: "relation", target: USER_UID },
      directReports: { type: "relation", target: USER_UID },
      avatar: { type: "media" },
      createdBy: { type: "relation", target: "admin::user", private: true },
    },
  },
  [DEPARTMENT]: {
    uid: DEPARTMENT,
    attributes: {
      name: { type: "string" },
      head: { type: "relation", target: USER_UID },
      members: { type: "relation", target: USER_UID },
      pages: { type: "relation", target: WIKI_PAGE },
    },
  },
  [TEAM]: {
    uid: TEAM,
    attributes: {
      name: { type: "string" },
      lead: { type: "relation", target: USER_UID },
      members: { type: "relation", target: USER_UID },
      department: { type: "relation", target: DEPARTMENT },
    },
  },
  [ANNOUNCEMENT]: {
    uid: ANNOUNCEMENT,
    attributes: {
      title: { type: "string" },
      author: { type: "relation", target: USER_UID },
      department: { type: "relation", target: DEPARTMENT },
    },
  },
  "plugin::upload.file": { uid: "plugin::upload.file", attributes: { url: { type: "string" } } },
  "plugin::users-permissions.role": {
    uid: "plugin::users-permissions.role",
    attributes: { type: { type: "string" } },
  },
};
const getModel = (uid: string) => MODELS[uid];
const hide = (query: Record<string, unknown>, uid: string) =>
  hideBlockedUsers(query, MODELS[uid], getModel);
const ACTIVE = ACTIVE_USER_FILTER;

describe("hideBlockedUsers: the user model's root", () => {
  it("lists active users only, ANDed with the caller's filters", () => {
    expect(hide({}, USER_UID)).toEqual({ filters: ACTIVE });
    expect(hide({ filters: { username: { $eq: "ada" } } }, USER_UID)).toEqual({
      filters: { $and: [{ username: { $eq: "ada" } }, ACTIVE] },
    });
  });

  it("returns any other query as it came, same reference", () => {
    const query = { filters: { title: "x" }, populate: { author: true } };
    expect(hide(query, ANNOUNCEMENT)).toBe(query);
    const plain = { fields: ["title"] };
    expect(hide(plain, ANNOUNCEMENT)).toBe(plain);
  });
});

describe("hideBlockedUsers: the directory relations", () => {
  it("filters department head and members, keeps other relations as they are", () => {
    expect(hide({ populate: { members: true, head: "true", pages: true } }, DEPARTMENT)).toEqual({
      populate: { members: { filters: ACTIVE }, head: { filters: ACTIVE }, pages: true },
    });
  });

  it("ANDs an existing populate filter and keeps the count form", () => {
    expect(
      hide({ populate: { members: { count: true, filters: { username: "a" } } } }, DEPARTMENT),
    ).toEqual({
      populate: { members: { count: true, filters: { $and: [{ username: "a" }, ACTIVE] } } },
    });
  });

  it("rewrites comma strings, dotted paths and lists into the object form", () => {
    expect(hide({ populate: "head,members.avatar,name" }, DEPARTMENT)).toEqual({
      populate: {
        head: { filters: ACTIVE },
        members: { filters: ACTIVE, populate: "avatar" },
        name: true,
      },
    });
    expect(hide({ populate: ["department.members", "teams"] }, USER_UID)).toEqual({
      filters: ACTIVE,
      populate: {
        department: { populate: { members: { filters: ACTIVE } } },
        teams: true,
      },
    });
  });

  it("expands * where a directory relation lives, minus private and admin attributes", () => {
    expect(hide({ populate: "*" }, DEPARTMENT)).toEqual({
      populate: { head: { filters: ACTIVE }, members: { filters: ACTIVE }, pages: true },
    });
    const users = hide({ populate: { department: { populate: "*" } } }, USER_UID);
    expect(users.populate).toEqual({
      department: {
        populate: { head: { filters: ACTIVE }, members: { filters: ACTIVE }, pages: true },
      },
    });
    expect(hide({ populate: "*" }, USER_UID).populate).toEqual({
      role: true,
      department: true,
      teams: true,
      manager: { filters: ACTIVE },
      directReports: { filters: ACTIVE },
      avatar: true,
    });
  });

  it("reaches the directory at any depth, through any relation", () => {
    expect(hide({ populate: { author: { populate: { manager: true } } } }, ANNOUNCEMENT)).toEqual({
      populate: { author: { populate: { manager: { filters: ACTIVE } } } },
    });
    expect(hide({ populate: "author.directReports" }, ANNOUNCEMENT)).toEqual({
      populate: { author: { populate: { directReports: { filters: ACTIVE } } } },
    });
    expect(
      hide(
        { populate: { department: { populate: { members: { count: "true" } } } } },
        ANNOUNCEMENT,
      ),
    ).toEqual({
      populate: {
        department: { populate: { members: { count: "true", filters: ACTIVE } } },
      },
    });
  });
});

describe("hideBlockedUsers: explicit user fields", () => {
  it("adds blocked to an author's field list (the output cut needs it), without filtering", () => {
    expect(hide({ populate: { author: { fields: ["displayName"] } } }, ANNOUNCEMENT)).toEqual({
      populate: { author: { fields: ["displayName", "blocked"] } },
    });
    expect(
      hide({ populate: { author: { fields: "displayName,username" } } }, ANNOUNCEMENT),
    ).toEqual({ populate: { author: { fields: ["displayName", "username", "blocked"] } } });
    const star = { populate: { author: { fields: "*" } } };
    expect(hide(star, ANNOUNCEMENT)).toEqual(star);
  });

  it("does both on a directory relation with fields", () => {
    expect(
      hide(
        { populate: { members: { fields: ["displayName"], populate: { avatar: true } } } },
        TEAM,
      ),
    ).toEqual({
      populate: {
        members: {
          fields: ["displayName", "blocked"],
          filters: ACTIVE,
          populate: { avatar: true },
        },
      },
    });
  });
});

describe("hideBlockedUsers: probes through withheld fields (Codex review)", () => {
  it("narrows a relation filter on a withheld user field to active users, at the root and nested", () => {
    expect(hide({ filters: { author: { email: { $startsWith: "a" } } } }, ANNOUNCEMENT)).toEqual({
      filters: { author: { $and: [{ email: { $startsWith: "a" } }, ACTIVE] } },
    });
    expect(
      hide(
        { filters: { $or: [{ department: { members: { phone: { $eq: "1" } } } }] } },
        ANNOUNCEMENT,
      ),
    ).toEqual({
      filters: {
        $or: [{ department: { members: { $and: [{ phone: { $eq: "1" } }, ACTIVE] } } }],
      },
    });
    // From the user root: the manager clause, then the root filter.
    expect(hide({ filters: { manager: { jobTitle: "x" } } }, USER_UID)).toEqual({
      filters: { $and: [{ manager: { $and: [{ jobTitle: "x" }, ACTIVE] } }, ACTIVE] },
    });
  });

  it("narrows every filter through a directory relation, ids included (whole-release review)", () => {
    expect(hide({ filters: { members: { id: { $eq: 7 } } } }, DEPARTMENT)).toEqual({
      filters: { members: { $and: [{ id: { $eq: 7 } }, ACTIVE] } },
    });
    expect(hide({ filters: { lead: { documentId: "d" } } }, TEAM)).toEqual({
      filters: { lead: { $and: [{ documentId: "d" }, ACTIVE] } },
    });
    expect(hide({ filters: { directReports: { id: 7 } } }, USER_UID)).toEqual({
      filters: { $and: [{ directReports: { $and: [{ id: 7 }, ACTIVE] } }, ACTIVE] },
    });
    // Nested: through an announcement's department to its head.
    expect(hide({ filters: { department: { head: { id: { $eq: 7 } } } } }, ANNOUNCEMENT)).toEqual({
      filters: { department: { head: { $and: [{ id: { $eq: 7 } }, ACTIVE] } } },
    });
    // Inside a populate filter.
    expect(
      hide({ populate: { department: { filters: { members: { id: 7 } } } } }, ANNOUNCEMENT),
    ).toEqual({
      populate: { department: { filters: { members: { $and: [{ id: 7 }, ACTIVE] } } } },
    });
  });

  it("leaves attribution filters alone (a blocked author's content stays findable)", () => {
    const query = { filters: { author: { id: { $eq: 42 }, displayName: { $eq: "Ada" } } } };
    expect(hide(query, ANNOUNCEMENT)).toBe(query);
  });

  it("narrows a populate filter on a withheld field, also inside a nested populate", () => {
    expect(
      hide({ populate: { author: { filters: { email: { $eq: "x" } } } } }, ANNOUNCEMENT),
    ).toEqual({
      populate: { author: { filters: { $and: [{ email: { $eq: "x" } }, ACTIVE] } } },
    });
    expect(
      hide({ populate: { department: { filters: { head: { phone: "1" } } } } }, ANNOUNCEMENT),
    ).toEqual({
      populate: { department: { filters: { head: { $and: [{ phone: "1" }, ACTIVE] } } } },
    });
  });

  it("refuses a root sort through a relation onto a withheld user field", () => {
    expect(() => hide({ sort: "author.email:asc" }, ANNOUNCEMENT)).toThrow(
      /Invalid key email at author\.email/,
    );
    expect(() => hide({ sort: { author: { jobTitle: "desc" } } }, ANNOUNCEMENT)).toThrow(
      /Invalid key jobTitle/,
    );
    expect(() =>
      hide({ sort: ["title:asc", "author.displayName:asc"] }, ANNOUNCEMENT),
    ).not.toThrow();
    // The user root lists active users only: its own fields sort freely.
    expect(() => hide({ sort: "jobTitle:asc" }, USER_UID)).not.toThrow();
  });
});
