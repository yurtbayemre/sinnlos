import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errors } from "@strapi/utils";
import { describe, expect, it } from "vitest";
import {
  RESTRICTED_RELATION_TARGETS,
  guardRestrictedRelations,
  isRestrictedRelation,
  stripRestrictedRelationsFromOutput,
  type RelationAttribute,
  type RelationModel,
} from "./restricted-relations";

/**
 * The relation side-channel guard (FX05) on the REAL schema.json models.
 *
 * department.pages / team.pages (inverse of wiki-page.department/team) handed
 * out the pages of hidden wiki spaces from every route whose model reaches a
 * department or team, and filters/sort over them were a blind oracle. The
 * models are built the way Strapi holds them at runtime: uid set, and the
 * private creator relations createdBy/updatedBy (→ admin::user) that
 * @strapi/core adds to every content type. The first cut's stubs lacked them,
 * which hid a wildcard expansion that 400'd on `createdBy`. A schema change
 * that opens a new path (e.g. a new relation into wiki-page) shows up here and
 * in routes.matrix.test.ts.
 *
 * Wiring (the sanitize.query wrapper, the output sanitizer, the admin/editor
 * bypass) is pinned in index.register.test.ts.
 */

const SRC = join(__dirname, "..");

const CREATOR_FIELDS: Record<string, RelationAttribute> = {
  createdBy: { type: "relation", target: "admin::user", private: true },
  updatedBy: { type: "relation", target: "admin::user", private: true },
};

/** A schema.json as Strapi holds it at runtime (uid + creator fields). */
function runtimeModel(uid: string, file: string): RelationModel {
  const schema = JSON.parse(readFileSync(file, "utf8")) as RelationModel;
  return { ...schema, uid, attributes: { ...schema.attributes, ...CREATOR_FIELDS } };
}

const DEPARTMENT = "api::department.department";
const TEAM = "api::team.team";
const WIKI_PAGE = "api::wiki-page.wiki-page";
const WIKI_SPACE = "api::wiki-space.wiki-space";
const WIKI_REVISION = "api::wiki-revision.wiki-revision";
const ANNOUNCEMENT = "api::announcement.announcement";
const EVENT = "api::event.event";
const USER = "plugin::users-permissions.user";
const FILE = "plugin::upload.file";

const API_NAMES = ["department", "team", "wiki-page", "wiki-space", "wiki-revision"];
const MODELS: Record<string, RelationModel> = {
  ...Object.fromEntries(
    [...API_NAMES, "announcement", "event", "poll"].map((name) => [
      `api::${name}.${name}`,
      runtimeModel(
        `api::${name}.${name}`,
        join(SRC, "api", name, "content-types", name, "schema.json"),
      ),
    ]),
  ),
  [USER]: runtimeModel(
    USER,
    join(SRC, "extensions", "users-permissions", "content-types", "user", "schema.json"),
  ),
  // @strapi/upload 5.49 content-types/file.js (relations only).
  [FILE]: {
    uid: FILE,
    attributes: {
      name: { type: "string" },
      related: { type: "relation" }, // morphToMany — no static target
      folder: { type: "relation", target: "plugin::upload.folder" },
      ...CREATOR_FIELDS,
    },
  },
};

const OPTIONS = {
  getModel: (uid: string) => MODELS[uid],
  rules: RESTRICTED_RELATION_TARGETS,
};

const guard = (uid: string, query: Record<string, unknown>) =>
  guardRestrictedRelations(query, MODELS[uid], OPTIONS);

/** The populate the service receives when `populate` is sent to the `uid` route. */
const populateOn = (uid: string, populate: unknown) => guard(uid, { populate }).populate;

/** Asserts the core's own `Invalid key` 400 (ValidationError), nothing else. */
function expectRejected(uid: string, query: Record<string, unknown>, message: string) {
  let thrown: unknown;
  try {
    guard(uid, query);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(errors.ValidationError);
  expect((thrown as Error).message).toBe(message);
}

/** Every populatable, non-private attribute except `pages`. */
const DEPARTMENT_WITHOUT_PAGES = ["headerImage", "head", "members", "teams"];
const TEAM_WITHOUT_PAGES = ["avatar", "department", "lead", "members"];

describe("isRestrictedRelation", () => {
  const attr = (uid: string, name: string) => MODELS[uid].attributes?.[name];

  it("cuts department.pages and team.pages", () => {
    for (const uid of [DEPARTMENT, TEAM]) {
      expect(
        isRestrictedRelation(MODELS[uid], attr(uid, "pages"), RESTRICTED_RELATION_TARGETS),
      ).toBe(true);
    }
  });

  it("trusts the wiki domain's own relations into wiki-page", () => {
    const trusted: [string, string][] = [
      [WIKI_SPACE, "pages"],
      [WIKI_PAGE, "parent"],
      [WIKI_PAGE, "children"],
      [WIKI_REVISION, "page"],
    ];
    for (const [uid, name] of trusted) {
      expect(isRestrictedRelation(MODELS[uid], attr(uid, name), RESTRICTED_RELATION_TARGETS)).toBe(
        false,
      );
    }
  });

  it("fails closed on morph relations and on a source without a uid", () => {
    expect(
      isRestrictedRelation(MODELS[FILE], attr(FILE, "related"), RESTRICTED_RELATION_TARGETS),
    ).toBe(true);
    const anonymous = { attributes: { pages: { type: "relation", target: WIKI_PAGE } } };
    expect(
      isRestrictedRelation(anonymous, anonymous.attributes.pages, RESTRICTED_RELATION_TARGETS),
    ).toBe(true);
  });

  it("leaves scalars and relations into unrestricted types alone", () => {
    expect(
      isRestrictedRelation(
        MODELS[DEPARTMENT],
        attr(DEPARTMENT, "name"),
        RESTRICTED_RELATION_TARGETS,
      ),
    ).toBe(false);
    expect(
      isRestrictedRelation(
        MODELS[WIKI_PAGE],
        attr(WIKI_PAGE, "department"),
        RESTRICTED_RELATION_TARGETS,
      ),
    ).toBe(false);
  });
});

describe("guardRestrictedRelations — populate is stripped", () => {
  describe("object shapes", () => {
    it("drops the relation with everything nested under it", () => {
      expect(
        populateOn(DEPARTMENT, {
          pages: { populate: { author: "true" }, fields: ["title"] },
          head: "true",
        }),
      ).toEqual({ head: "true" });
    });

    it("drops a count populate", () => {
      expect(populateOn(DEPARTMENT, { pages: { count: "true" } })).toEqual({});
    });

    it("keeps harmless populate untouched", () => {
      const populate = { head: "true", teams: { fields: ["name"], populate: { lead: "true" } } };
      expect(populateOn(DEPARTMENT, populate)).toEqual(populate);
    });

    it("strips nested paths through teams and through users", () => {
      expect(
        populateOn(DEPARTMENT, { teams: { populate: { pages: "true", lead: "true" } } }),
      ).toEqual({ teams: { populate: { lead: "true" } } });
      expect(
        populateOn(DEPARTMENT, {
          members: { populate: { department: { populate: { pages: "true" } } } },
        }),
      ).toEqual({ members: { populate: { department: { populate: {} } } } });
    });

    it("strips on the team model, including the way back through department", () => {
      expect(
        populateOn(TEAM, { pages: "true", department: { populate: { pages: "true" } } }),
      ).toEqual({ department: { populate: {} } });
    });

    it("drops a dotted object key that would reach pages", () => {
      expect(populateOn(DEPARTMENT, { "teams.pages": "true", head: "true" })).toEqual({
        head: "true",
      });
    });

    it("drops morph relations (no static target) below media", () => {
      expect(
        populateOn(DEPARTMENT, { headerImage: { populate: { related: "true", folder: "true" } } }),
      ).toEqual({ headerImage: { populate: { folder: "true" } } });
    });
  });

  describe("string and array shapes", () => {
    it("filters comma lists and arrays", () => {
      expect(populateOn(DEPARTMENT, "pages")).toEqual([]);
      expect(populateOn(DEPARTMENT, "pages,teams")).toEqual(["teams"]);
      expect(populateOn(DEPARTMENT, ["pages", "teams"])).toEqual(["teams"]);
      expect(populateOn(DEPARTMENT, ["pages,head", "members"])).toEqual(["head", "members"]);
    });

    it("keeps a harmless string as the same value", () => {
      expect(populateOn(DEPARTMENT, "head,teams")).toBe("head,teams");
    });

    it("truncates dotted paths before the restricted segment", () => {
      expect(populateOn(DEPARTMENT, "teams.pages")).toEqual(["teams"]);
      expect(
        populateOn(DEPARTMENT, ["members.department.pages", "members.teams.pages.author"]),
      ).toEqual(["members.department", "members.teams"]);
      expect(populateOn(DEPARTMENT, "teams.lead")).toBe("teams.lead");
    });
  });

  describe("wildcards never re-open the channel", () => {
    it("expands populate=* and populate[0]=* without pages", () => {
      expect(populateOn(DEPARTMENT, "*")).toEqual(DEPARTMENT_WITHOUT_PAGES);
      expect(populateOn(DEPARTMENT, ["*"])).toEqual(DEPARTMENT_WITHOUT_PAGES);
      expect(populateOn(TEAM, "*")).toEqual(TEAM_WITHOUT_PAGES);
    });

    it("never names a private attribute (createdBy/updatedBy would 400 or be dropped)", () => {
      for (const uid of [DEPARTMENT, TEAM]) {
        const expanded = populateOn(uid, "*") as string[];
        const attributes = MODELS[uid].attributes ?? {};
        expect(expanded.filter((name) => attributes[name]?.private === true)).toEqual([]);
        expect(expanded).not.toContain("createdBy");
      }
      const out = populateOn(DEPARTMENT, { "*": "true" }) as Record<string, unknown>;
      expect(out).not.toHaveProperty("createdBy");
      expect(out).not.toHaveProperty("updatedBy");
    });

    it("expands a '*' object key without overriding explicit keys", () => {
      const out = populateOn(DEPARTMENT, { "*": "true", head: { fields: ["username"] } }) as Record<
        string,
        unknown
      >;
      expect(Object.keys(out).sort()).toEqual([...DEPARTMENT_WITHOUT_PAGES].sort());
      expect(out.head).toEqual({ fields: ["username"] });
    });

    it("expands a nested populate=* (the core resets the depth there)", () => {
      expect(populateOn(DEPARTMENT, { teams: { populate: "*" } })).toEqual({
        teams: { populate: TEAM_WITHOUT_PAGES },
      });
      expect(populateOn(DEPARTMENT, { teams: { populate: ["*"] } })).toEqual({
        teams: { populate: TEAM_WITHOUT_PAGES },
      });
    });

    it("cuts a dotted wildcard at a model that owns pages", () => {
      expect(populateOn(DEPARTMENT, "teams.*")).toEqual(["teams"]);
    });

    it("keeps a wildcard where no restricted relation is one step away", () => {
      // user has no relation into wiki-page; `*` only populates one level.
      expect(populateOn(DEPARTMENT, { members: { populate: "*" } })).toEqual({
        members: { populate: "*" },
      });
      // wiki-page's own parent/children are trusted.
      expect(populateOn(WIKI_PAGE, "*")).toBe("*");
    });
  });

  describe("every root, not only department/team", () => {
    it("/api/users and /api/users/me", () => {
      expect(populateOn(USER, { department: { populate: { pages: "true" } } })).toEqual({
        department: { populate: {} },
      });
      expect(populateOn(USER, "department.pages")).toEqual(["department"]);
      expect(populateOn(USER, { teams: { populate: "*" } })).toEqual({
        teams: { populate: TEAM_WITHOUT_PAGES },
      });
      expect(
        populateOn(USER, { department: { populate: { teams: { populate: { pages: "true" } } } } }),
      ).toEqual({ department: { populate: { teams: { populate: {} } } } });
    });

    it("announcements, events and polls", () => {
      expect(
        populateOn(ANNOUNCEMENT, {
          team: { populate: { pages: "true" } },
          department: { populate: "*" },
        }),
      ).toEqual({ team: { populate: {} }, department: { populate: DEPARTMENT_WITHOUT_PAGES } });
      for (const uid of [EVENT, "api::poll.poll"]) {
        expect(populateOn(uid, { departments: { populate: { pages: "true" } } })).toEqual({
          departments: { populate: {} },
        });
      }
    });

    it("wiki-space keeps its own pages but not a detour through department", () => {
      // The web's space query (apps/web lib/strapi.ts wiki.space).
      const web = { pages: { populate: { author: "true" } } };
      expect(populateOn(WIKI_SPACE, web)).toEqual(web);
      expect(populateOn(WIKI_SPACE, { department: { populate: { pages: "true" } } })).toEqual({
        department: { populate: {} },
      });
      expect(
        populateOn(WIKI_SPACE, {
          pages: { populate: { department: { populate: { pages: "true" } } } },
        }),
      ).toEqual({ pages: { populate: { department: { populate: {} } } } });
    });

    it("wiki-page and wiki-revision keep the wiki domain's relations", () => {
      // The web's page query (apps/web lib/strapi.ts wiki.page).
      const web = {
        author: "true",
        lastEditor: "true",
        space: "true",
        revisions: { populate: { editor: "true" } },
      };
      expect(populateOn(WIKI_PAGE, web)).toEqual(web);
      expect(populateOn(WIKI_PAGE, { parent: "true", children: "true" })).toEqual({
        parent: "true",
        children: "true",
      });
      expect(populateOn(WIKI_PAGE, { team: { populate: ["pages"] } })).toEqual({
        team: { populate: [] },
      });
      expect(populateOn(WIKI_REVISION, { page: { populate: { space: "true" } } })).toEqual({
        page: { populate: { space: "true" } },
      });
    });
  });

  it("passes every other query key through untouched", () => {
    const query = {
      populate: { pages: "true", head: "true" },
      status: "published",
      fields: ["name"],
      pagination: { page: 1, pageSize: 10 },
      filters: { slug: { $eq: "eng" } },
    };
    expect(guard(DEPARTMENT, query)).toEqual({ ...query, populate: { head: "true" } });
    // No populate → the very same object.
    const bare = { filters: { slug: { $eq: "eng" } }, status: "published" };
    expect(guard(DEPARTMENT, bare)).toBe(bare);
  });
});

describe("guardRestrictedRelations — filters and sort are rejected", () => {
  it("rejects the four oracle shapes of the review on department", () => {
    expectRejected(
      DEPARTMENT,
      { filters: { pages: { body: { $startsWith: "Conf" } } } },
      "Invalid key pages",
    );
    expectRejected(DEPARTMENT, { sort: "pages.title:asc" }, "Invalid key pages");
    expectRejected(
      DEPARTMENT,
      { populate: { teams: { filters: { pages: { title: { $containsi: "x" } } } } } },
      "Invalid key pages at teams.pages",
    );
    expectRejected(
      DEPARTMENT,
      { filters: { $or: [{ teams: { pages: { title: { $lt: "M" } } } }] } },
      "Invalid key pages at teams.pages",
    );
  });

  it("rejects filters across the relation from any root and inside $and/$not", () => {
    expectRejected(
      USER,
      { filters: { department: { pages: { title: { $eq: "x" } } } } },
      "Invalid key pages at department.pages",
    );
    expectRejected(TEAM, { filters: { $not: { pages: { $null: true } } } }, "Invalid key pages");
    expectRejected(
      TEAM,
      {
        filters: {
          $and: [{ name: { $eq: "a" } }, { department: { pages: { id: { $gt: 0 } } } }],
        },
      },
      "Invalid key pages at department.pages",
    );
    expectRejected(
      WIKI_PAGE,
      { filters: { department: { pages: { title: "x" } } } },
      "Invalid key pages at department.pages",
    );
    expectRejected(
      DEPARTMENT,
      { filters: { headerImage: { related: { id: 1 } } } },
      "Invalid key related at headerImage.related",
    );
  });

  it("rejects every sort shape across the relation", () => {
    expectRejected(DEPARTMENT, { sort: "name:asc,pages.title:desc" }, "Invalid key pages");
    expectRejected(
      DEPARTMENT,
      { sort: ["name:asc", "teams.pages.title:desc"] },
      "Invalid key pages at teams.pages",
    );
    expectRejected(DEPARTMENT, { sort: { pages: { title: "asc" } } }, "Invalid key pages");
    expectRejected(
      DEPARTMENT,
      { sort: [{ teams: { pages: { title: "asc" } } }] },
      "Invalid key pages at teams.pages",
    );
  });

  it("rejects filters and sort inside nested populate objects", () => {
    expectRejected(
      DEPARTMENT,
      { populate: { teams: { sort: "pages.title:asc" } } },
      "Invalid key pages at teams.pages",
    );
    expectRejected(
      DEPARTMENT,
      {
        populate: {
          members: { populate: { department: { filters: { pages: { title: "x" } } } } },
        },
      },
      "Invalid key pages at members.department.pages",
    );
  });

  it("does not reject a filter/sort under a populate key it strips anyway", () => {
    expect(
      populateOn(DEPARTMENT, { pages: { filters: { title: "x" }, sort: "title:asc" } }),
    ).toEqual({});
  });

  it("accepts every other filter and sort, including the wiki domain's own", () => {
    const ok: [string, Record<string, unknown>][] = [
      // The web's page lookup and a policy-composed filter.
      [WIKI_PAGE, { filters: { space: { slug: { $eq: "eng" } }, slug: { $eq: "intro" } } }],
      [DEPARTMENT, { filters: { $and: [{ slug: { $eq: "x" } }, { id: { $eq: -1 } }] } }],
      [DEPARTMENT, { filters: { teams: { name: { $eq: "x" } }, name: { $eq: "pages" } } }],
      [DEPARTMENT, { filters: { id: { $in: [1, 2] } }, sort: "name:asc,teams.name:desc" }],
      [DEPARTMENT, { sort: [{ teams: { name: "asc" } }, "head.username:desc"] }],
      [WIKI_SPACE, { filters: { pages: { title: { $containsi: "x" } } }, sort: "pages.title" }],
      [WIKI_PAGE, { filters: { parent: { title: "x" } }, sort: ["children.order:asc"] }],
    ];
    for (const [uid, query] of ok) expect(guard(uid, query), uid).toBe(query);
  });
});

describe("stripRestrictedRelationsFromOutput (backstop)", () => {
  const strip = <T>(uid: string, data: T) =>
    stripRestrictedRelationsFromOutput(data, MODELS[uid], OPTIONS);

  it("deletes restricted relations at any depth, counts and morphs included", () => {
    const entity = {
      id: 1,
      name: "Eng",
      pages: [{ id: 3, title: "Secret" }],
      teams: [{ id: 2, name: "Core", pages: { count: 4 } }],
      headerImage: { id: 9, url: "/x.png", related: [{ id: 1, __type: WIKI_PAGE }] },
    };
    expect(strip(DEPARTMENT, entity)).toBe(entity);
    expect(entity).toEqual({
      id: 1,
      name: "Eng",
      teams: [{ id: 2, name: "Core" }],
      headerImage: { id: 9, url: "/x.png" },
    });
  });

  it("covers /api/users(/me) and list responses", () => {
    const users = [
      { id: 1, department: { id: 2, pages: [{ id: 3 }] }, teams: [{ id: 4, pages: [] }] },
      { id: 5, department: null, teams: [] },
    ];
    strip(USER, users);
    expect(users).toEqual([
      { id: 1, department: { id: 2 }, teams: [{ id: 4 }] },
      { id: 5, department: null, teams: [] },
    ]);
  });

  it("keeps the wiki domain's own relations but cuts detours below them", () => {
    const space = {
      id: 1,
      pages: [{ id: 2, title: "Visible", department: { id: 3, pages: [{ id: 4 }] } }],
    };
    strip(WIKI_SPACE, space);
    expect(space).toEqual({ id: 1, pages: [{ id: 2, title: "Visible", department: { id: 3 } }] });

    const page = { id: 2, parent: { id: 1 }, children: [{ id: 5 }], team: { id: 6, pages: [] } };
    strip(WIKI_PAGE, page);
    expect(page).toEqual({ id: 2, parent: { id: 1 }, children: [{ id: 5 }], team: { id: 6 } });
  });

  it("survives cycles and scalars", () => {
    const department: Record<string, unknown> = { id: 1, pages: [{ id: 2 }] };
    department.teams = [{ id: 3, department }];
    expect(() => strip(DEPARTMENT, department)).not.toThrow();
    expect(department).not.toHaveProperty("pages");
    expect(strip(DEPARTMENT, null)).toBeNull();
    expect(strip(DEPARTMENT, 42)).toBe(42);
  });
});
