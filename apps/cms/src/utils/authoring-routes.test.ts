import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTHORING_FIELDS,
  AUTHORING_INTENTS,
  AUTHORING_PATHS,
  AUTHORING_STATUS_MODES,
  AUTHORING_TYPES,
  DEPARTMENT_AUTHORED_TYPES,
  authoringRoute,
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

describe("the authoring route table (K7) = the cms routes", () => {
  it("covers exactly the authored uids, with the schemas' plural names", () => {
    expect(AUTHORING_TYPES.map((type) => UID_OF[type]).sort()).toEqual([...AUTHORED_UIDS].sort());
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
