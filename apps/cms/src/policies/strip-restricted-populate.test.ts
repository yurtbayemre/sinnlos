import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelSchema } from "../utils/sanitize-user-contact";
import stripRestrictedPopulate from "./strip-restricted-populate";

/**
 * Wiring + shape test for the populate side-channel guard (FX05).
 *
 * department/team own the inverse relation `pages` into wiki-page, and their
 * reads carry no wiki-visibility filter — so `populate[pages]` (in any of the
 * shapes the core accepts) returned the pages of hidden wiki spaces. The
 * models come from the REAL schema.json files (plus a stub of the upload
 * plugin's file model), so a schema change that opens a new path (e.g. a new
 * relation into wiki-page) shows up here.
 *
 * Pinned traps (same set as the sibling policy tests):
 *   1. the rewrite lands on `policyContext.request.query` (Koa getter trap),
 *   2. strict boolean results (undefined counts as PASS),
 *   3. admin_role/editor bypass without touching the query,
 *   4. every wildcard form (`*`, `[0]=*`, `{"*":…}`, nested `populate=*`)
 *      is expanded instead of passed on.
 */

const API_DIR = join(__dirname, "..", "api");
const readSchema = (file: string): ModelSchema => JSON.parse(readFileSync(file, "utf8"));
const apiSchema = (name: string) =>
  readSchema(join(API_DIR, name, "content-types", name, "schema.json"));

const DEPARTMENT = "api::department.department";
const TEAM = "api::team.team";
const WIKI_PAGE = "api::wiki-page.wiki-page";

const MODELS: Record<string, ModelSchema> = {
  [DEPARTMENT]: apiSchema("department"),
  [TEAM]: apiSchema("team"),
  [WIKI_PAGE]: apiSchema("wiki-page"),
  "api::wiki-space.wiki-space": apiSchema("wiki-space"),
  "plugin::users-permissions.user": readSchema(
    join(
      __dirname,
      "..",
      "extensions",
      "users-permissions",
      "content-types",
      "user",
      "schema.json",
    ),
  ),
  // @strapi/upload 5.49 content-types/file.js (relations only).
  "plugin::upload.file": {
    attributes: {
      name: { type: "string" },
      related: { type: "relation" }, // morphToMany — no static target
      folder: { type: "relation", target: "plugin::upload.folder" },
    },
  },
};

const strapi = { getModel: (uid: string) => MODELS[uid] };
const CONFIG = (uid: string) => ({ uid, targets: [WIKI_PAGE] });

const MEMBER = { id: 5, role: { type: "member" } };

function context(user: unknown, query: Record<string, unknown>) {
  return { state: user ? { user } : {}, request: { query: { ...query } } };
}

/** Runs the policy as `user` on `uid` and returns the rewritten populate. */
function run(populate: unknown, uid = DEPARTMENT, user: unknown = MEMBER) {
  const ctx = context(user, { populate });
  const result = stripRestrictedPopulate(ctx, CONFIG(uid), { strapi });
  expect(result).toBe(true);
  return ctx.request.query.populate;
}

/** Every populatable attribute of department except `pages`. */
const DEPARTMENT_WITHOUT_PAGES = ["headerImage", "head", "members", "teams"];
const TEAM_WITHOUT_PAGES = ["avatar", "department", "lead", "members"];

describe("strip-restricted-populate policy", () => {
  describe("bypass and wiring", () => {
    it.each(["admin_role", "editor"])("leaves %s's populate untouched", (type) => {
      const ctx = context({ id: 1, role: { type } }, { populate: { pages: "true" } });
      expect(stripRestrictedPopulate(ctx, CONFIG(DEPARTMENT), { strapi })).toBe(true);
      expect(ctx.request.query.populate).toEqual({ pages: "true" });
    });

    it("strips for a member and for an anonymous caller alike", () => {
      expect(run({ pages: "true", teams: "true" })).toEqual({ teams: "true" });
      expect(run({ pages: "true", teams: "true" }, DEPARTMENT, null)).toEqual({ teams: "true" });
    });

    it("writes to request.query, never to the throw-away policyContext.query", () => {
      const ctx = { ...context(MEMBER, { populate: "pages" }), query: { populate: "pages" } };
      stripRestrictedPopulate(ctx, CONFIG(DEPARTMENT), { strapi });
      expect(ctx.request.query.populate).toEqual([]);
      expect(ctx.query.populate).toBe("pages");
    });

    it("leaves a query without populate (and every other param) alone", () => {
      const ctx = context(MEMBER, { filters: { slug: { $eq: "eng" } }, status: "draft" });
      expect(stripRestrictedPopulate(ctx, CONFIG(DEPARTMENT), { strapi })).toBe(true);
      expect(ctx.request.query).toEqual({ filters: { slug: { $eq: "eng" } }, status: "draft" });
    });

    it.each([
      ["no config", undefined],
      ["no targets", { uid: DEPARTMENT }],
      ["empty targets", { uid: DEPARTMENT, targets: [] }],
      ["no uid", { targets: [WIKI_PAGE] }],
      ["unknown uid", { uid: "api::nope.nope", targets: [WIKI_PAGE] }],
    ])("fails closed on a misconfigured route (%s) — even for admin", (_label, config) => {
      const admin = { id: 1, role: { type: "admin_role" } };
      expect(stripRestrictedPopulate(context(admin, {}), config, { strapi })).toBe(false);
    });
  });

  describe("object shapes", () => {
    it("drops the relation with everything nested under it", () => {
      expect(
        run({ pages: { populate: { author: "true" }, fields: ["title"] }, head: "true" }),
      ).toEqual({ head: "true" });
    });

    it("drops a count populate", () => {
      expect(run({ pages: { count: "true" } })).toEqual({});
    });

    it("keeps harmless populate untouched", () => {
      const populate = { head: "true", teams: { fields: ["name"], populate: { lead: "true" } } };
      expect(run(populate)).toEqual(populate);
    });

    it("strips nested paths through teams and through users", () => {
      expect(run({ teams: { populate: { pages: "true", lead: "true" } } })).toEqual({
        teams: { populate: { lead: "true" } },
      });
      expect(
        run({ members: { populate: { department: { populate: { pages: "true" } } } } }),
      ).toEqual({ members: { populate: { department: { populate: {} } } } });
    });

    it("strips on the team route, including the way back through department", () => {
      expect(run({ pages: "true", department: { populate: { pages: "true" } } }, TEAM)).toEqual({
        department: { populate: {} },
      });
    });

    it("drops a dotted object key that would reach pages", () => {
      expect(run({ "teams.pages": "true", head: "true" })).toEqual({ head: "true" });
    });

    it("drops morph relations (no static target) below media", () => {
      expect(run({ headerImage: { populate: { related: "true", folder: "true" } } })).toEqual({
        headerImage: { populate: { folder: "true" } },
      });
    });
  });

  describe("string and array shapes", () => {
    it("filters comma lists and arrays", () => {
      expect(run("pages")).toEqual([]);
      expect(run("pages,teams")).toEqual(["teams"]);
      expect(run(["pages", "teams"])).toEqual(["teams"]);
      expect(run(["pages,head", "members"])).toEqual(["head", "members"]);
    });

    it("keeps a harmless string as the same value", () => {
      expect(run("head,teams")).toBe("head,teams");
    });

    it("truncates dotted paths before the restricted segment", () => {
      expect(run("teams.pages")).toEqual(["teams"]);
      expect(run(["members.department.pages", "members.teams.pages.author"])).toEqual([
        "members.department",
        "members.teams",
      ]);
      expect(run("teams.lead")).toBe("teams.lead");
    });
  });

  describe("wildcards never re-open the channel", () => {
    it("expands populate=* and populate[0]=* without pages", () => {
      expect(run("*")).toEqual(DEPARTMENT_WITHOUT_PAGES);
      expect(run(["*"])).toEqual(DEPARTMENT_WITHOUT_PAGES);
      expect(run("*", TEAM)).toEqual(TEAM_WITHOUT_PAGES);
    });

    it("expands a '*' object key without overriding explicit keys", () => {
      const out = run({ "*": "true", head: { fields: ["username"] } }) as Record<string, unknown>;
      expect(Object.keys(out).sort()).toEqual([...DEPARTMENT_WITHOUT_PAGES].sort());
      expect(out.head).toEqual({ fields: ["username"] });
    });

    it("expands a nested populate=* (the core resets the depth there)", () => {
      expect(run({ teams: { populate: "*" } })).toEqual({
        teams: { populate: TEAM_WITHOUT_PAGES },
      });
      expect(run({ teams: { populate: ["*"] } })).toEqual({
        teams: { populate: TEAM_WITHOUT_PAGES },
      });
    });

    it("cuts a dotted wildcard at a model that owns pages", () => {
      expect(run("teams.*")).toEqual(["teams"]);
    });

    it("keeps a wildcard where no restricted relation is reachable in one step", () => {
      // user has no relation into wiki-page; `*` only populates one level.
      expect(run({ members: { populate: "*" } })).toEqual({ members: { populate: "*" } });
    });
  });
});
