import { errors } from "@strapi/utils";
import { describe, expect, it } from "vitest";

import { ADMIN, MODERATORS, type RoleType } from "../bootstrap/roles";
import {
  createStrapiStub,
  policyContext,
  type StrapiStub,
  type StubUser,
} from "../test/strapi-stub.test.helper";
import { MALFORMED_ENTRY_IDS } from "./entry-id.test.helper";
import {
  configuredBypass,
  departmentScopedIds,
  findByRef,
  identifiedCaller,
  ownerGate,
  ownRowsFilter,
  rowIds,
  visibleIdsPolicy,
  type PolicyDb,
  type VisibleIdsInput,
} from "./policy-factories";

const COMMENT = "api::comment.comment";
const DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";
const OTHER_DOC = "m4w8r2t6y1u5i9o3p7a2s6d0";

function commentStub() {
  return createStrapiStub({
    tables: {
      "plugin::users-permissions.user": [{ id: 5, username: "author", email: "a@example.test" }],
      [COMMENT]: [
        {
          id: 7,
          documentId: DOC,
          body: "hello",
          targetType: "announcement",
          targetDocumentId: OTHER_DOC,
          author: { id: 5 },
        },
      ],
    },
  });
}

describe("findByRef (PL01)", () => {
  it("finds a row by numeric id, canonical numeric string or documentId", async () => {
    for (const idParam of [7, "7", DOC]) {
      const strapi = commentStub();
      const row = await findByRef(strapi, COMMENT, idParam);
      expect(row?.id, String(idParam)).toBe(7);
      expect(row?.documentId, String(idParam)).toBe(DOC);
    }
  });

  it("answers null for a missing row", async () => {
    for (const idParam of [8, OTHER_DOC]) {
      await expect(findByRef(commentStub(), COMMENT, idParam), String(idParam)).resolves.toBeNull();
    }
  });

  it("answers null without any query for missing and malformed ids", async () => {
    for (const idParam of [undefined, null, "", 0, -1, 1.5, ...MALFORMED_ENTRY_IDS]) {
      const strapi = commentStub();
      await expect(findByRef(strapi, COMMENT, idParam), String(idParam)).resolves.toBeNull();
      expect(strapi.calls, String(idParam)).toEqual([]);
    }
  });

  it("forwards populate and always selects id and documentId", async () => {
    const strapi = commentStub();
    const row = await findByRef<{ id: number; documentId: string; author?: { id?: number } }>(
      strapi,
      COMMENT,
      DOC,
      { select: ["body"], populate: { author: { select: ["id"] } } },
    );
    expect(row).toEqual({ id: 7, documentId: DOC, body: "hello", author: { id: 5 } });
    expect(strapi.calls).toEqual([
      {
        api: "db",
        uid: COMMENT,
        method: "findOne",
        params: {
          where: { documentId: DOC },
          select: ["id", "documentId", "body"],
          populate: { author: { select: ["id"] } },
        },
      },
    ]);
  });

  it("treats a row without a documentId as no entry", async () => {
    const strapi: PolicyDb = {
      db: {
        query: () => ({
          findOne: async () => ({ id: 7 }),
          findMany: async () => [],
        }),
      },
    };
    await expect(findByRef(strapi, COMMENT, 7)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Callers and helpers
// ---------------------------------------------------------------------------

const as = (type: string, id = 50): StubUser => ({ id, role: { id: 1, type } });
const LOOKALIKES = ["Admin_role", "ADMIN_ROLE", "admin", " editor", "Editor", "", "authenticated"];
const CLIENT = { filters: { title: { $eq: "client" } }, status: "draft", publicationFilter: "x" };

describe("identifiedCaller and rowIds", () => {
  it("accepts only a caller with a row id", () => {
    expect(identifiedCaller({ id: 5 })).toEqual({ id: 5 });
    for (const user of [null, undefined, {}, { id: "5" }, { id: 0 }, { id: -1 }, { id: 1.5 }]) {
      expect(identifiedCaller(user), JSON.stringify(user)).toBeNull();
    }
  });

  it("collects the numeric ids of rows", () => {
    expect(rowIds([{ id: 1 }, { id: "2" }, null, { id: 3 }])).toEqual([1, 3]);
    expect(rowIds(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ownRowsFilter
// ---------------------------------------------------------------------------

describe("ownRowsFilter (PL02)", () => {
  const policy = ownRowsFilter({ ownerField: "recipient", bypass: [ADMIN] });

  it("refuses without a signed-in user or a numeric id, query untouched", async () => {
    // A string id is what a broken auth layer could hand in; StubUser types it out.
    const stringId = { id: "7", role: null } as unknown as StubUser;
    for (const user of [undefined, null, { role: { type: "member" } }, stringId]) {
      const ctx = policyContext(user, { query: CLIENT });
      await expect(policy(ctx), JSON.stringify(user)).resolves.toBe(false);
      expect(ctx.request.query).toEqual(CLIENT);
    }
  });

  it("lets exactly the bypass roles through untouched", async () => {
    const passed: string[] = [];
    for (const type of ["admin_role", "editor", "member", "guest", ...LOOKALIKES]) {
      const ctx = policyContext(as(type), { query: CLIENT });
      expect(await policy(ctx)).toBe(true);
      if (JSON.stringify(ctx.request.query) === JSON.stringify(CLIENT)) passed.push(type);
    }
    expect(passed).toEqual(["admin_role"]);
  });

  it("$and-narrows the client filter with the owner clause on the real query", async () => {
    const decoy = { filters: "DECOY" };
    const ctx = policyContext(as("editor", 7), { query: CLIENT, decoy });
    await expect(policy(ctx)).resolves.toBe(true);
    expect(ctx.query).toBe(decoy);
    expect(ctx.request.query.filters).toEqual({
      $and: [CLIENT.filters, { recipient: { id: 7 } }],
    });
    // No draft & publish: the status is the client's.
    expect(ctx.request.query.status).toBe("draft");

    const bare = policyContext(as("member", 7));
    await expect(policy(bare)).resolves.toBe(true);
    expect(bare.request.query.filters).toEqual({ recipient: { id: 7 } });
  });

  it("runs checkQuery for non-bypass callers only, before the clause", async () => {
    const seen: unknown[] = [];
    const checked = ownRowsFilter({
      ownerField: "user",
      bypass: [ADMIN],
      checkQuery(query) {
        seen.push(JSON.parse(JSON.stringify(query.filters ?? null)));
        if (query.filters === "refuse") throw new errors.ValidationError("refused");
      },
    });
    await expect(checked(policyContext(as("admin_role"), { query: CLIENT }))).resolves.toBe(true);
    expect(seen).toEqual([]);
    await expect(checked(policyContext(as("member", 3), { query: CLIENT }))).resolves.toBe(true);
    expect(seen).toEqual([CLIENT.filters]);
    const refused = policyContext(as("member", 3), { query: { filters: "refuse" } });
    await expect(checked(refused)).rejects.toBeInstanceOf(errors.ValidationError);
    expect(refused.request.query.filters).toBe("refuse");
  });
});

// ---------------------------------------------------------------------------
// visibleIdsPolicy
// ---------------------------------------------------------------------------

describe("visibleIdsPolicy (PL02)", () => {
  type Config = { level?: string } | undefined;

  function setup(
    options: { anonymous?: "filter" | "deny"; pinPublished?: boolean; ids?: number[] } = {},
  ) {
    const loads: VisibleIdsInput<Config>[] = [];
    const policy = visibleIdsPolicy<Config>({
      uid: (config) => `api::thing.${config?.level ?? "default"}`,
      bypass: MODERATORS,
      anonymous: options.anonymous ?? "filter",
      pinPublished: options.pinPublished ?? true,
      loadVisibleIds: async (input) => {
        loads.push(input);
        return options.ids ?? [3, 4];
      },
    });
    const strapi = createStrapiStub();
    return { policy, loads, strapi };
  }

  it("bypasses exactly its roles, untouched and without loading", async () => {
    const passed: string[] = [];
    for (const type of ["admin_role", "editor", "department_head", "member", ...LOOKALIKES]) {
      const { policy, loads, strapi } = setup();
      const ctx = policyContext(as(type), { query: CLIENT });
      expect(await policy(ctx, undefined, { strapi })).toBe(true);
      if (loads.length === 0 && JSON.stringify(ctx.request.query) === JSON.stringify(CLIENT)) {
        passed.push(type);
      }
    }
    expect(passed.sort()).toEqual(["admin_role", "editor"]);
  });

  it("injects the loaded ids, $and-narrowed, and pins published after the bypass", async () => {
    const { policy, loads, strapi } = setup();
    const ctx = policyContext(as("member", 9), { query: CLIENT, decoy: { filters: "DECOY" } });
    await expect(policy(ctx, { level: "page" }, { strapi })).resolves.toBe(true);
    expect(ctx.query).toEqual({ filters: "DECOY" });
    expect(ctx.request.query).toEqual({
      filters: { $and: [CLIENT.filters, { id: { $in: [3, 4] } }] },
      status: "published",
    });
    expect(loads).toHaveLength(1);
    expect(loads[0].uid).toBe("api::thing.page");
    expect(loads[0].config).toEqual({ level: "page" });
    expect(loads[0].user?.id).toBe(9);
    expect(loads[0].strapi).toBe(strapi);
  });

  it("keeps an empty set restrictive, never an empty $in", async () => {
    const { policy, strapi } = setup({ ids: [] });
    const ctx = policyContext(as("member"));
    await expect(policy(ctx, undefined, { strapi })).resolves.toBe(true);
    expect(ctx.request.query.filters).toEqual({ id: { $eq: -1 } });
  });

  it("leaves the status alone without pinPublished", async () => {
    const { policy, strapi } = setup({ pinPublished: false });
    const ctx = policyContext(as("member"), { query: CLIENT });
    await expect(policy(ctx, undefined, { strapi })).resolves.toBe(true);
    expect(ctx.request.query.status).toBe("draft");
    expect(ctx.request.query.publicationFilter).toBe("x");
  });

  it("filters anonymous callers and callers without an id as nobody ('filter')", async () => {
    for (const user of [undefined, null, { role: { type: "member" } }]) {
      const { policy, loads, strapi } = setup();
      const ctx = policyContext(user);
      await expect(policy(ctx, undefined, { strapi }), JSON.stringify(user)).resolves.toBe(true);
      expect(loads.map((load) => load.user)).toEqual([null]);
      expect(ctx.request.query.filters).toEqual({ id: { $in: [3, 4] } });
    }
  });

  it("fails closed beyond the bind limit, with an error log (PL04)", async () => {
    const many = Array.from({ length: 40_000 }, (_, index) => index + 1);
    const policy = visibleIdsPolicy({
      uid: "api::document.document",
      bypass: MODERATORS,
      anonymous: "filter",
      pinPublished: true,
      loadVisibleIds: async () => many,
    });

    // SQLite (the stub names no dialect: the lower limit applies).
    const sqlite = createStrapiStub();
    const ctx = policyContext(as("member"));
    await expect(policy(ctx, undefined, { strapi: sqlite })).resolves.toBe(true);
    expect(ctx.request.query).toEqual({ filters: { id: { $eq: -1 } }, status: "published" });
    expect(sqlite.log.error).toHaveBeenCalledTimes(1);
    expect(String(sqlite.log.error.mock.calls[0][0])).toContain(
      "api::document.document read policy: 40000 values",
    );

    // Postgres binds 40000 ids in one statement.
    const pg = createStrapiStub();
    const pgStrapi = { ...pg, db: { ...pg.db, dialect: { client: "postgres" } } };
    const pgCtx = policyContext(as("member"));
    await expect(policy(pgCtx, undefined, { strapi: pgStrapi })).resolves.toBe(true);
    expect(pgCtx.request.query.filters).toEqual({ id: { $in: many } });
    expect(pg.log.error).not.toHaveBeenCalled();
  });

  it("refuses anonymous callers and callers without an id ('deny')", async () => {
    for (const user of [undefined, null, { role: { type: "member" } }]) {
      const { policy, loads, strapi } = setup({ anonymous: "deny" });
      const ctx = policyContext(user, { query: CLIENT });
      await expect(policy(ctx, undefined, { strapi }), JSON.stringify(user)).resolves.toBe(false);
      expect(loads).toEqual([]);
      expect(ctx.request.query).toEqual(CLIENT);
    }
  });
});

// ---------------------------------------------------------------------------
// departmentScopedIds
// ---------------------------------------------------------------------------

describe("departmentScopedIds (PL02)", () => {
  const DOCUMENT = "api::document.document";

  function stub(): StrapiStub {
    return createStrapiStub({
      tables: {
        "api::department.department": [
          { id: 10, documentId: "deng00000000000000000000", name: "Eng" },
          { id: 11, documentId: "dops00000000000000000000", name: "Ops" },
        ],
        "plugin::users-permissions.user": [
          { id: 1, username: "eng", department: { id: 10 } },
          { id: 2, username: "none", department: null },
        ],
        [DOCUMENT]: [
          { id: 100, title: "all", departments: [] },
          { id: 101, title: "eng", departments: [{ id: 10 }] },
          { id: 102, title: "ops", departments: [{ id: 11 }] },
          { id: 103, title: "both", departments: [{ id: 10 }, { id: 11 }] },
        ],
      },
    });
  }

  const load = (userId: number | null) =>
    departmentScopedIds({
      strapi: stub(),
      user: userId === null ? null : { id: userId },
      config: undefined,
      uid: DOCUMENT,
    });

  it("shows company-wide rows to everyone and scoped rows to their departments", async () => {
    await expect(load(1)).resolves.toEqual([100, 101, 103]);
    await expect(load(2)).resolves.toEqual([100]);
    await expect(load(null)).resolves.toEqual([100]);
    await expect(load(999)).resolves.toEqual([100]);
  });
});

// ---------------------------------------------------------------------------
// ownerGate
// ---------------------------------------------------------------------------

describe("ownerGate (PL02)", () => {
  const RSVP = "api::event-rsvp.event-rsvp";
  const OWN_DOC = "rsown0000000000000000000";

  function stub(): StrapiStub {
    return createStrapiStub({
      tables: {
        "plugin::users-permissions.user": [
          { id: 5, username: "owner" },
          { id: 6, username: "stranger" },
        ],
        [RSVP]: [
          { id: 1, documentId: OWN_DOC, targetDocumentId: "e", status: "yes", user: { id: 5 } },
          {
            id: 2,
            documentId: "rsnouser0000000000000000",
            targetDocumentId: "e",
            status: "no",
            user: null,
          },
        ],
      },
    });
  }

  const gate = ownerGate({ uid: RSVP, ownerField: "user", bypass: [ADMIN] });
  const run = async (
    user: StubUser | null | undefined,
    id: unknown,
    policy = gate,
    config?: { bypassRoles?: unknown },
  ) => {
    const strapi = stub();
    const ctx = policyContext(user, { params: { id }, query: CLIENT });
    const result = await policy(ctx, config, { strapi });
    return { result, calls: strapi.calls, query: ctx.request.query };
  };

  it("passes the owner by row id and documentId, and nobody else", async () => {
    await expect(run(as("member", 5), "1")).resolves.toMatchObject({ result: true });
    await expect(run(as("member", 5), 1)).resolves.toMatchObject({ result: true });
    await expect(run(as("member", 5), OWN_DOC)).resolves.toMatchObject({ result: true });
    await expect(run(as("member", 6), "1")).resolves.toMatchObject({ result: false });
    await expect(run(as("editor", 6), "1")).resolves.toMatchObject({ result: false });
  });

  it("reads only the owner's id, and leaves the query alone", async () => {
    const { calls, query } = await run(as("member", 5), "1");
    expect(calls.map((call) => call.params)).toEqual([
      { where: { id: 1 }, populate: { user: { select: ["id"] } } },
    ]);
    expect(query).toEqual(CLIENT);
  });

  it("refuses missing, malformed and unknown ids like a foreign row", async () => {
    for (const id of [undefined, "", "abc", "0", "2147483648", "99", "zz0000000000000000000000"]) {
      const { result } = await run(as("member", 5), id);
      expect(result, String(id)).toBe(false);
    }
    const { calls } = await run(as("member", 5), "abc");
    expect(calls).toEqual([]);
  });

  it("lets no caller without an id own a row, not even an ownerless one", async () => {
    for (const id of ["1", "2", "rsnouser0000000000000000"]) {
      const { result, calls } = await run({ role: { type: "member" } }, id);
      expect(result, id).toBe(false);
      expect(calls, id).toEqual([]);
    }
    // With an id, the ownerless row belongs to nobody either.
    await expect(run(as("member", 5), "2")).resolves.toMatchObject({ result: false });
  });

  it("refuses a request without a signed-in user", async () => {
    for (const user of [undefined, null]) {
      await expect(run(user, "1")).resolves.toMatchObject({ result: false, calls: [] });
    }
  });

  it("bypasses exactly the static roles without a lookup", async () => {
    const passed: string[] = [];
    for (const type of ["admin_role", "editor", "member", ...LOOKALIKES]) {
      const { result, calls } = await run(as(type, 6), "1");
      if (result && calls.length === 0) passed.push(type);
    }
    expect(passed).toEqual(["admin_role"]);
  });

  it("takes the bypass from the route config when asked to", async () => {
    const configured = ownerGate({
      uid: RSVP,
      ownerField: "user",
      bypass: MODERATORS,
      bypassFromConfig: true,
    });
    const bypassed = async (config: { bypassRoles?: unknown } | undefined) => {
      const passed: string[] = [];
      for (const type of ["admin_role", "editor", "member"]) {
        const { result, calls } = await run(as(type, 6), "1", configured, config);
        if (result && calls.length === 0) passed.push(type);
      }
      return passed;
    };
    await expect(bypassed(undefined)).resolves.toEqual(["admin_role", "editor"]);
    await expect(bypassed({})).resolves.toEqual(["admin_role", "editor"]);
    await expect(bypassed({ bypassRoles: ["admin_role"] })).resolves.toEqual(["admin_role"]);
    await expect(bypassed({ bypassRoles: ["admin_role", "editor"] })).resolves.toEqual([
      "admin_role",
      "editor",
    ]);
    await expect(bypassed({ bypassRoles: [] })).resolves.toEqual([]);
    await expect(bypassed({ bypassRoles: ["Admin_role", "admin", 1] })).resolves.toEqual([]);
    await expect(bypassed({ bypassRoles: "admin_role" })).resolves.toEqual([]);
  });

  it("returns strict booleans on every branch", async () => {
    const results = new Set<unknown>();
    for (const user of [undefined, null, {}, as("admin_role"), as("member", 5), as("guest", 6)]) {
      for (const id of [undefined, "1", "2", "abc", OWN_DOC]) {
        results.add(typeof (await run(user, id)).result);
      }
    }
    expect([...results]).toEqual(["boolean"]);
  });
});

describe("configuredBypass", () => {
  const fallback: readonly RoleType[] = MODERATORS;

  it("uses the fallback without config and the valid role types of a list", () => {
    expect(configuredBypass(undefined, fallback)).toBe(fallback);
    expect(configuredBypass({ bypassRoles: null }, fallback)).toBe(fallback);
    expect(configuredBypass({ bypassRoles: ["editor", "nope"] }, fallback)).toEqual(["editor"]);
    expect(configuredBypass({ bypassRoles: { 0: "admin_role" } }, fallback)).toEqual([]);
  });
});
