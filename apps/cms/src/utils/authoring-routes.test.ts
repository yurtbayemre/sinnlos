import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTHORING_FIELDS,
  AUTHORING_INTENTS,
  AUTHORING_PATHS,
  AUTHORING_STATUS_MODES,
  AUTHORING_TYPES,
  DEPARTMENT_AUTHORED_TYPES,
  TRAINING_AUTHORING_INTENTS,
  TRAINING_FIELDS,
  TRAINING_PATHS,
  ORG_FIELDS,
  ORG_PATHS,
  WIKI_FIELDS,
  WIKI_PAGE_INTENTS,
  WIKI_PATHS,
  WIKI_SPACE_INTENTS,
  authoringRoute,
  wikiPageRoute,
  wikiSpaceRoute,
  type AuthoringRoute,
  type AuthoringType,
} from "@sinnlos/domain";
import { describe, expect, it, vi } from "vitest";

import { AUTHORED_UIDS, DEPARTMENT_AUTHORED_UIDS } from "./authoring-uids";
import { AUTHORING_SPECS } from "./authoring-controller";
import { writeClassesFor } from "./write-allowlist";

/**
 * The HTTP contract of v2 authoring (contract K7, @sinnlos/domain
 * authoring/http.ts and fields.ts) against what the cms serves: every
 * custom route of api/<type>/routes/00-authoring.ts has the method and path
 * of the domain's route table, every type's plural is its schema's, the
 * status modes and the class lists agree. The web builds its requests from
 * the domain table, so a route moved here without the table fails.
 */

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreRouter: (uid: string, options: unknown) => ({ uid, options }),
    createCoreController: () => ({}),
  },
}));

const API_DIR = join(__dirname, "..", "api");

const UID_OF: Record<AuthoringType, string> = {
  announcement: "api::announcement.announcement",
  event: "api::event.event",
  quickLink: "api::quick-link.quick-link",
  document: "api::document.document",
  poll: "api::poll.poll",
};

const apiName = (uid: string) => uid.split("::")[1].split(".")[0];

interface CustomRoute {
  method: string;
  path: string;
  handler: string;
}

async function customRoutes(uid: string): Promise<CustomRoute[]> {
  const mod = (await import(join(API_DIR, apiName(uid), "routes", "00-authoring.ts"))) as {
    default: { routes: CustomRoute[] };
  };
  return mod.default.routes;
}

const WIKI_SPACE = "api::wiki-space.wiki-space";
const WIKI_PAGE = "api::wiki-page.wiki-page";

describe("the authoring route table (K7) = the cms routes", () => {
  it("covers exactly the authored uids, with the schemas' plural names", () => {
    expect(
      [
        ...AUTHORING_TYPES.map((type) => UID_OF[type]),
        WIKI_SPACE,
        WIKI_PAGE,
        "api::course.course",
        "api::lesson.lesson",
      ].sort(),
    ).toEqual([...AUTHORED_UIDS].sort());
    for (const type of AUTHORING_TYPES) {
      const schema = JSON.parse(
        readFileSync(
          join(
            API_DIR,
            apiName(UID_OF[type]),
            "content-types",
            apiName(UID_OF[type]),
            "schema.json",
          ),
          "utf8",
        ),
      ) as { info: { pluralName: string } };
      expect(AUTHORING_PATHS[type], type).toBe(schema.info.pluralName);
    }
  });

  it("serves every custom intent at the domain's method and path, and nothing else", async () => {
    for (const type of AUTHORING_TYPES) {
      const uid = UID_OF[type];
      const custom = AUTHORING_INTENTS[type].filter(
        (intent) => !["create", "update", "delete"].includes(intent),
      );
      const routes = await customRoutes(uid);
      expect(routes.map((route) => route.handler).sort(), type).toEqual(
        custom.map((intent) => `${uid}.${intent}`).sort(),
      );
      for (const intent of custom) {
        const route = routes.find((candidate) => candidate.handler === `${uid}.${intent}`);
        const expected = authoringRoute(type, intent);
        expect(route?.method, `${type} ${intent}`).toBe(expected.method);
        expect(route?.path, `${type} ${intent}`).toBe(expected.path.replace(":documentId", ":id"));
      }
    }
  });

  it("agrees on the status modes, the department-authored types and the classes", () => {
    for (const type of AUTHORING_TYPES) {
      const uid = UID_OF[type];
      expect(AUTHORING_SPECS[uid].statusMode, type).toBe(AUTHORING_STATUS_MODES[type]);
      expect(writeClassesFor(uid, "create"), type).toEqual(
        Object.keys(AUTHORING_FIELDS[type]).sort(),
      );
    }
    expect(DEPARTMENT_AUTHORED_TYPES.map((type) => UID_OF[type]).sort()).toEqual(
      [...DEPARTMENT_AUTHORED_UIDS].sort(),
    );
  });
});

describe("the wiki route table (K18) = the cms routes", () => {
  const custom = (intents: readonly string[]) =>
    intents.filter((intent) => !["create", "update", "delete"].includes(intent));

  it.each([
    [WIKI_SPACE, "wikiSpace", WIKI_SPACE_INTENTS, wikiSpaceRoute],
    [WIKI_PAGE, "wikiPage", WIKI_PAGE_INTENTS, wikiPageRoute],
  ] as const)(
    "%s serves every custom intent at the domain's method and path",
    async (uid, type, intents, route) => {
      const schema = JSON.parse(
        readFileSync(
          join(API_DIR, apiName(uid), "content-types", apiName(uid), "schema.json"),
          "utf8",
        ),
      ) as { info: { pluralName: string } };
      expect(WIKI_PATHS[type]).toBe(schema.info.pluralName);
      const routes = await customRoutes(uid);
      const wanted = custom(intents);
      expect(routes.map((entry) => entry.handler).sort(), uid).toEqual(
        wanted.map((intent) => `${uid}.${intent}`).sort(),
      );
      for (const intent of wanted) {
        const entry = routes.find((candidate) => candidate.handler === `${uid}.${intent}`);
        const expected: AuthoringRoute = (route as (intent: string) => AuthoringRoute)(intent);
        expect(entry?.method, `${uid} ${intent}`).toBe(expected.method);
        expect(entry?.path, `${uid} ${intent}`).toBe(expected.path.replace(":documentId", ":id"));
      }
    },
  );

  it("agrees on the status modes and the classes", () => {
    expect(AUTHORING_SPECS[WIKI_SPACE].statusMode).toBe("alwaysPublished");
    expect(AUTHORING_SPECS[WIKI_PAGE].statusMode).toBe("explicit");
    for (const action of ["create", "update"] as const) {
      expect(writeClassesFor(WIKI_SPACE, action)).toEqual(
        Object.keys(WIKI_FIELDS.wikiSpace[action]).sort(),
      );
      expect(writeClassesFor(WIKI_PAGE, action)).toEqual(
        Object.keys(WIKI_FIELDS.wikiPage[action]).sort(),
      );
    }
  });
});

describe("batch 17 route contracts", () => {
  it.each(["course", "lesson"] as const)(
    "%s serves exactly the training intents and field classes",
    async (type) => {
      const uid = `api::${type}.${type}`;
      const routes = await customRoutes(uid);
      expect(routes.map((route) => route.handler).sort()).toEqual(
        TRAINING_AUTHORING_INTENTS.filter((intent) => intent !== "create" && intent !== "update")
          .map((intent) => `${uid}.${intent}`)
          .sort(),
      );
      for (const route of routes) {
        const intent = route.handler.split(".").pop()!;
        const read = intent === "authoringList" || intent === "editable";
        const suffix =
          intent === "authoringList"
            ? "authoring"
            : `:id/${intent === "discardDraft" ? "discard-draft" : intent}`;
        expect(route.method).toBe(read ? "GET" : "POST");
        expect(route.path).toBe(`/${TRAINING_PATHS[type]}/${suffix}`);
      }
      expect(AUTHORING_SPECS[uid].statusMode).toBe("explicit");
      for (const action of ["create", "update"] as const)
        expect(writeClassesFor(uid, action)).toEqual(Object.keys(TRAINING_FIELDS[type]).sort());
    },
  );

  it.each(["department", "team"] as const)(
    "%s exposes only the org editable action with the exact update classes",
    async (type) => {
      const uid = `api::${type}.${type}`;
      const routes = await customRoutes(uid);
      expect(routes.map(({ method, path, handler }) => ({ method, path, handler }))).toEqual([
        { method: "GET", path: `/${ORG_PATHS[type]}/:id/editable`, handler: `${uid}.editable` },
      ]);
      expect(writeClassesFor(uid, "update")).toEqual(Object.keys(ORG_FIELDS[type]).sort());
      expect(writeClassesFor(uid, "create")).toEqual([]);
    },
  );
});
