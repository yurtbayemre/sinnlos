import { describe, expect, it } from "vitest";
import {
  PRIVILEGED_ROLE_TYPES,
  SENSITIVE_USER_FIELDS,
  USER_UID,
  shouldSanitizeForRole,
  stripSensitiveUserFields,
  type ModelSchema,
} from "./sanitize-user-contact";

/**
 * Issue #10 / P1.2 — guests (and every other non-privileged caller) must not
 * read staff email/phone/hireDate. The fix is a role-aware content-api output
 * sanitizer whose two halves are pure and pinned here:
 *   - `shouldSanitizeForRole` — the fail-closed role gate,
 *   - `stripSensitiveUserFields` — schema-guided removal of the sensitive
 *     fields on the directory user AND on every populated user relation, at
 *     any depth, without crashing on partial payloads.
 *
 * The recursion reads only `schema.uid` + `schema.attributes`, so a tiny
 * hand-written model registry stands in for Strapi's — no runtime needed.
 */

const models: Record<string, ModelSchema> = {
  [USER_UID]: {
    uid: USER_UID,
    attributes: {
      email: { type: "email" },
      phone: { type: "string" },
      hireDate: { type: "date" },
      officeLocation: { type: "string" },
      microsoftOid: { type: "string" },
      displayName: { type: "string" },
      jobTitle: { type: "string" },
      avatar: { type: "media" },
      role: { type: "relation", target: "plugin::users-permissions.role" },
      department: { type: "relation", target: "api::department.department" },
      teams: { type: "relation", target: "api::team.team" },
      manager: { type: "relation", target: USER_UID },
      directReports: { type: "relation", target: USER_UID },
    },
  },
  "api::team.team": {
    uid: "api::team.team",
    attributes: {
      name: { type: "string" },
      lead: { type: "relation", target: USER_UID },
      members: { type: "relation", target: USER_UID },
    },
  },
  "api::department.department": {
    uid: "api::department.department",
    attributes: {
      name: { type: "string" },
      slug: { type: "string" },
      head: { type: "relation", target: USER_UID },
    },
  },
  "api::announcement.announcement": {
    uid: "api::announcement.announcement",
    attributes: {
      title: { type: "string" },
      author: { type: "relation", target: USER_UID },
      department: { type: "relation", target: "api::department.department" },
    },
  },
  "plugin::users-permissions.role": {
    uid: "plugin::users-permissions.role",
    attributes: { name: { type: "string" }, type: { type: "string" } },
  },
  // A content type with a repeatable component and a dynamic zone, both of
  // which embed a user relation — proves the non-relation descent paths.
  "api::page.page": {
    uid: "api::page.page",
    attributes: {
      title: { type: "string" },
      contributors: { type: "component", component: "shared.contributor" },
      blocks: { type: "dynamiczone" },
    },
  },
  "shared.contributor": {
    uid: "shared.contributor",
    attributes: {
      note: { type: "string" },
      person: { type: "relation", target: USER_UID },
    },
  },
  "shared.author-block": {
    uid: "shared.author-block",
    attributes: {
      heading: { type: "string" },
      writer: { type: "relation", target: USER_UID },
    },
  },
};

const getModel = (uid: string): ModelSchema | undefined => models[uid];
const strip = <T>(data: T, schema: ModelSchema | undefined): T =>
  stripSensitiveUserFields(data, schema, { getModel });

/** A fully-populated directory user, as it reaches the output sanitizer. */
const fullUser = (over: Record<string, unknown> = {}) => ({
  id: 7,
  documentId: "usr_7",
  username: "ada",
  displayName: "Ada Lovelace",
  jobTitle: "Engineer",
  email: "ada@example.com",
  phone: "+49 30 111",
  hireDate: "2020-01-01",
  officeLocation: "Berlin HQ",
  microsoftOid: "oid-ada-123",
  ...over,
});

const SENSITIVE = [...SENSITIVE_USER_FIELDS];

describe("shouldSanitizeForRole", () => {
  it("keeps the fields for every privileged employee role", () => {
    for (const roleType of ["admin_role", "editor", "department_head", "team_lead", "member"]) {
      expect(shouldSanitizeForRole(roleType)).toBe(false);
    }
  });

  it("strips for guest, the authenticated fallback, public, and unknown roles", () => {
    for (const roleType of ["guest", "authenticated", "public", "irgendwas"]) {
      expect(shouldSanitizeForRole(roleType)).toBe(true);
    }
  });

  it("strips when the role type is missing (undefined / null / empty)", () => {
    expect(shouldSanitizeForRole(undefined)).toBe(true);
    expect(shouldSanitizeForRole(null)).toBe(true);
    expect(shouldSanitizeForRole("")).toBe(true);
  });

  it("the privileged set is exactly the five non-guest employee roles", () => {
    expect([...PRIVILEGED_ROLE_TYPES].sort()).toEqual(
      ["admin_role", "department_head", "editor", "member", "team_lead"].sort(),
    );
    expect(PRIVILEGED_ROLE_TYPES.has("guest")).toBe(false);
  });
});

describe("stripSensitiveUserFields — direct user (the /api/users directory)", () => {
  it("removes every sensitive field and keeps the identity/display fields", () => {
    const user = strip(fullUser(), models[USER_UID]);
    for (const field of SENSITIVE) expect(user).not.toHaveProperty(field);
    expect(user.id).toBe(7);
    expect(user.documentId).toBe("usr_7");
    expect(user.username).toBe("ada");
    expect(user.displayName).toBe("Ada Lovelace");
    expect(user.jobTitle).toBe("Engineer");
  });

  it("strips each element of a user list (the /api/users array case)", () => {
    const list = strip([fullUser({ id: 1 }), fullUser({ id: 2 })], models[USER_UID]);
    for (const user of list) {
      for (const field of SENSITIVE) expect(user).not.toHaveProperty(field);
      expect(user).toHaveProperty("displayName");
    }
  });
});

describe("stripSensitiveUserFields — populated user relations", () => {
  it("cleans announcement.author but leaves the announcement's own fields", () => {
    const announcement = {
      id: 3,
      title: "All hands",
      author: fullUser(),
    };
    const out = strip(announcement, models["api::announcement.announcement"]);
    expect(out.title).toBe("All hands");
    for (const field of SENSITIVE) expect(out.author).not.toHaveProperty(field);
    expect(out.author.displayName).toBe("Ada Lovelace");
    expect(out.author.jobTitle).toBe("Engineer");
  });

  it("cleans nested manager / directReports[] / teams[].members[]", () => {
    const user = fullUser({
      manager: fullUser({ id: 100, email: "boss@example.com" }),
      directReports: [fullUser({ id: 101, phone: "+49 1" }), fullUser({ id: 102, phone: "+49 2" })],
      teams: [
        {
          id: 200,
          name: "Platform",
          members: [fullUser({ id: 103 }), fullUser({ id: 104 })],
        },
      ],
    });
    const out = strip(user, models[USER_UID]);

    for (const field of SENSITIVE) expect(out).not.toHaveProperty(field);
    expect(out.manager).not.toHaveProperty("email");
    expect(out.manager.displayName).toBe("Ada Lovelace");
    for (const report of out.directReports) {
      expect(report).not.toHaveProperty("phone");
      expect(report).not.toHaveProperty("email");
    }
    // the team itself (a non-user node) keeps its scalars…
    expect(out.teams[0].name).toBe("Platform");
    // …while its members[] users are cleaned
    for (const member of out.teams[0].members) {
      for (const field of SENSITIVE) expect(member).not.toHaveProperty(field);
    }
  });

  it("cleans users embedded in a component and in a dynamic zone", () => {
    const page = {
      id: 9,
      title: "Team page",
      contributors: { note: "lead author", person: fullUser({ id: 300 }) },
      blocks: [
        { __component: "shared.author-block", heading: "By", writer: fullUser({ id: 301 }) },
        { __component: "shared.unknown-block", label: "ignored" },
      ],
    };
    const out = strip(page, models["api::page.page"]);
    expect(out.title).toBe("Team page");
    for (const field of SENSITIVE) expect(out.contributors.person).not.toHaveProperty(field);
    expect(out.contributors.note).toBe("lead author");
    for (const field of SENSITIVE) expect(out.blocks[0].writer).not.toHaveProperty(field);
    expect(out.blocks[0].heading).toBe("By");
    // unknown component uid → left untouched, no crash
    expect(out.blocks[1].label).toBe("ignored");
  });
});

describe("stripSensitiveUserFields — untouched data", () => {
  it("leaves a non-user relation (department) fully intact", () => {
    const announcement = {
      id: 4,
      title: "HR update",
      author: fullUser(),
      department: { id: 50, name: "People", slug: "people" },
    };
    const out = strip(announcement, models["api::announcement.announcement"]);
    expect(out.department).toEqual({ id: 50, name: "People", slug: "people" });
    // the co-located user relation is still cleaned
    for (const field of SENSITIVE) expect(out.author).not.toHaveProperty(field);
  });

  it("does not descend into scalar/json attributes that happen to hold an 'email' key", () => {
    // `role` is a real relation here but points to a non-user model; a JSON
    // blob is not a relation at all — neither should be treated as a user.
    const user = fullUser({ role: { id: 1, name: "Guest", type: "guest" } });
    const out = strip(user, models[USER_UID]);
    expect(out.role).toEqual({ id: 1, name: "Guest", type: "guest" });
  });
});

describe("stripSensitiveUserFields — defensive edges (no crash)", () => {
  it("returns null / undefined / scalars unchanged", () => {
    expect(strip(null as unknown, models[USER_UID])).toBeNull();
    expect(strip(undefined as unknown, models[USER_UID])).toBeUndefined();
    expect(strip(42 as unknown, models[USER_UID])).toBe(42);
    expect(strip("plain" as unknown, models[USER_UID])).toBe("plain");
  });

  it("tolerates a missing schema, missing attributes, and empty objects", () => {
    expect(() => strip(fullUser(), undefined)).not.toThrow();
    // with no schema the sensitive fields are NOT removed (fail-safe: we only
    // strip when we positively know the node is a user)
    const noSchema = strip(fullUser(), undefined);
    expect(noSchema).toHaveProperty("email");
    expect(() => strip({}, models[USER_UID])).not.toThrow();
    expect(() => strip(fullUser(), { uid: USER_UID })).not.toThrow(); // no attributes
  });

  it("tolerates null / empty populated relations", () => {
    const user = fullUser({ manager: null, directReports: [], teams: null });
    const out = strip(user, models[USER_UID]);
    for (const field of SENSITIVE) expect(out).not.toHaveProperty(field);
    expect(out.manager).toBeNull();
    expect(out.directReports).toEqual([]);
  });

  it("tolerates an unresolved target model (getModel returns undefined)", () => {
    const orphanSchema: ModelSchema = {
      uid: "api::thing.thing",
      attributes: { owner: { type: "relation", target: "api::missing.missing" } },
    };
    const thing = { id: 1, owner: fullUser() };
    expect(() => stripSensitiveUserFields(thing, orphanSchema, { getModel })).not.toThrow();
    // target model unknown → the nested user is left as-is (documented limit)
    expect(thing.owner).toHaveProperty("email");
  });

  it("does not loop on a cyclic object graph", () => {
    const a = fullUser({ id: 1 });
    const b = fullUser({ id: 2 });
    (a as Record<string, unknown>).manager = b;
    (b as Record<string, unknown>).manager = a; // cycle
    expect(() => strip(a, models[USER_UID])).not.toThrow();
    expect(a).not.toHaveProperty("email");
    expect(b).not.toHaveProperty("email");
  });
});
