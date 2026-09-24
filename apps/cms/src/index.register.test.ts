import { errors } from "@strapi/utils";
import { describe, expect, it, vi } from "vitest";
import lifecycle, { registerRestrictedRelationGuard, registerUserContactSanitizer } from "./index";
import type { RelationModel } from "./utils/restricted-relations";
import { SENSITIVE_USER_FIELDS, USER_UID, type ModelSchema } from "./utils/sanitize-user-contact";

/**
 * Wiring test for the issue #10 output sanitizer (F6).
 *
 * The pure removal/gate logic is pinned in sanitize-user-contact.test.ts. This
 * file pins the REGISTRATION SEMANTICS instead — the part that actually hangs
 * the factory onto Strapi's `content-api.output` sanitizer list — because that
 * is where a silent regression hides:
 *
 *   `strapi.sanitizers.add("content-api.output", fn)` LOOKS correct but is a
 *   no-op against @strapi/core 5.49 (registries/sanitizers.js): `add` reads the
 *   target list with a FRESH `[]` default for an uninitialized path and pushes
 *   onto that throwaway array, so nothing persists. `content-api.output` is
 *   never pre-`set`, so `.add` would leave the sanitizer UNREGISTERED and every
 *   guest would keep reading staff contact data — with no error anywhere.
 *
 * `makeSanitizers()` reproduces exactly that registry contract, and the first
 * test proves the reproduction is faithful (the trap fires). The second test
 * then runs the REAL `registerUserContactSanitizer` against it and asserts the
 * factory actually lands (length 1) — which only holds for the get()+set()
 * append the implementation uses, and fails the moment someone "simplifies" it
 * back to `.add`.
 */

/** Minimal stand-in for @strapi/core's sanitizers registry (5.49 contract). */
function makeSanitizers() {
  const store = new Map<string, unknown[]>();
  // An uninitialized path yields a FRESH [] that is NOT persisted.
  const get = (path: string): unknown[] => (store.has(path) ? store.get(path)! : []);
  const set = (path: string, value: unknown[]): void => {
    store.set(path, value);
  };
  // Faithful 5.49 no-op: read the list via get(), push onto it. For an
  // uninitialized path get() returned a throwaway [], so nothing persists.
  const add = (path: string, fn: unknown): void => {
    get(path).push(fn);
  };
  return { store, get, set, add };
}

const userModel: ModelSchema = {
  uid: USER_UID,
  attributes: {
    email: { type: "email" },
    phone: { type: "string" },
    hireDate: { type: "date" },
    officeLocation: { type: "string" },
    microsoftOid: { type: "string" },
    displayName: { type: "string" },
  },
};

/** A directory user as it reaches the output transform. */
const fullUser = () => ({
  id: 7,
  displayName: "Ada Lovelace",
  email: "ada@example.com",
  phone: "+49 30 111",
  hireDate: "2020-01-01",
  officeLocation: "Berlin HQ",
  microsoftOid: "oid-ada-123",
});

describe("content-api.output sanitizer registration (issue #10 / F6)", () => {
  it("models the 5.49 registry contract: `.add` on an uninitialized path is a silent no-op", () => {
    const s = makeSanitizers();
    s.add("content-api.output", () => {});
    // The trap: the push landed on a throwaway array, so the path is still
    // empty/uninitialized. This is exactly why the implementation must NOT
    // use `.add`.
    expect(s.get("content-api.output")).toHaveLength(0);
    expect(s.store.has("content-api.output")).toBe(false);
  });

  it("registerUserContactSanitizer appends its factory so it actually persists", () => {
    const s = makeSanitizers();
    const strapi = {
      sanitizers: s,
      requestContext: { get: () => undefined },
      getModel: () => undefined,
    };

    registerUserContactSanitizer(strapi);

    // Would be 0 if the implementation regressed to `strapi.sanitizers.add(...)`.
    expect(s.get("content-api.output")).toHaveLength(1);
    expect(s.store.get("content-api.output")).toHaveLength(1);
  });

  it("the registered factory strips for guest, keeps for member, and no-ops without a request", () => {
    const holder: { ctx: unknown } = { ctx: undefined };
    const strapi = {
      sanitizers: makeSanitizers(),
      requestContext: { get: () => holder.ctx },
      getModel: (uid: string) => (uid === USER_UID ? userModel : undefined),
    };
    registerUserContactSanitizer(strapi);

    const registered = strapi.sanitizers.get("content-api.output") as Array<
      (schema: unknown) => (data: unknown) => unknown
    >;
    expect(registered).toHaveLength(1);
    // The factory is schema-bound, then applied to the response entity.
    const sanitize = registered[0](userModel) as (data: unknown) => Record<string, unknown>;

    // guest → every sensitive field removed, identity kept.
    holder.ctx = { state: { user: { role: { type: "guest" } } } };
    const asGuest = sanitize(fullUser());
    for (const field of SENSITIVE_USER_FIELDS) expect(asGuest).not.toHaveProperty(field);
    expect(asGuest.displayName).toBe("Ada Lovelace");

    // member (privileged) → fields kept.
    holder.ctx = { state: { user: { role: { type: "member" } } } };
    const asMember = sanitize(fullUser());
    expect(asMember.email).toBe("ada@example.com");
    expect(asMember.hireDate).toBe("2020-01-01");

    // No request in scope (lifecycle / cron / seed) → internal call, kept.
    holder.ctx = undefined;
    const internal = sanitize(fullUser());
    expect(internal.email).toBe("ada@example.com");
  });
});

/**
 * Wiring test for the relation side-channel guard (FX05). The walk itself is
 * pinned in utils/restricted-relations.test.ts; this pins where it hangs:
 *   - it WRAPS `strapi.contentAPI.sanitize.query`, the one function every
 *     content-api controller (core, users-permissions, upload) calls on the
 *     client query, and runs on the core's RESULT (after validateQuery),
 *   - a restricted filter becomes the core's own ValidationError (400),
 *   - the output backstop lands via get()+set() (never `.add`),
 *   - admin_role/editor bypass both; no request context = guard applies,
 *   - boot fails when the hook point is gone (no silent re-open),
 *   - register() installs it next to the contact sanitizer.
 */
describe("relation side-channel guard registration (FX05)", () => {
  const WIKI_PAGE = "api::wiki-page.wiki-page";
  const department: RelationModel = {
    uid: "api::department.department",
    attributes: {
      name: { type: "string" },
      teams: { type: "relation", target: "api::team.team" },
      pages: { type: "relation", target: WIKI_PAGE },
    },
  };
  const user: RelationModel = {
    uid: USER_UID,
    attributes: {
      username: { type: "string" },
      password: { type: "password", private: true },
      department: { type: "relation", target: "api::department.department" },
    },
  };
  const models: Record<string, RelationModel> = {
    [department.uid as string]: department,
    [USER_UID]: user,
  };

  type RequestState = { state?: { user?: { role?: { type?: string } | null } | null } };

  function host(role?: string) {
    const holder: { ctx: RequestState | undefined } = {
      ctx: role === undefined ? undefined : { state: { user: { role: { type: role } } } },
    };
    // Stands in for the core sanitizer: marks its output so the test can
    // tell that the guard ran on the RESULT, not on the raw query. The mark
    // is a REST key (`locale`), so the root-key pick keeps it; like the real
    // core (strictParams off), the stand-in keeps unknown keys.
    const coreSanitizeQuery = vi.fn(
      async (
        query: Record<string, unknown>,
        _schema: RelationModel,
        _options?: unknown,
      ): Promise<Record<string, unknown>> => ({ ...query, locale: "sanitized-by-core" }),
    );
    const strapi = {
      getModel: (uid: string) => models[uid],
      requestContext: { get: () => holder.ctx },
      sanitizers: makeSanitizers(),
      contentAPI: { sanitize: { query: coreSanitizeQuery } },
    };
    return { strapi, holder, coreSanitizeQuery };
  }

  const pagesAndTeams = () => ({ populate: { pages: "true", teams: "true" } });

  it("wraps contentAPI.sanitize.query and strips the core's result for a member", async () => {
    const { strapi, coreSanitizeQuery } = host("member");
    registerRestrictedRelationGuard(strapi);
    expect(strapi.contentAPI.sanitize.query).not.toBe(coreSanitizeQuery);

    const auth = { auth: { strategy: "users-permissions" } };
    const out = await strapi.contentAPI.sanitize.query(pagesAndTeams(), department, auth);
    expect(coreSanitizeQuery).toHaveBeenCalledWith(pagesAndTeams(), department, auth);
    expect(out).toEqual({ populate: { teams: "true" }, locale: "sanitized-by-core" });
  });

  it("applies without a request context (fail closed) and for guest", async () => {
    for (const role of [undefined, "guest"]) {
      const { strapi } = host(role);
      registerRestrictedRelationGuard(strapi);
      const out = await strapi.contentAPI.sanitize.query(pagesAndTeams(), department);
      expect(out.populate, String(role)).toEqual({ teams: "true" });
    }
  });

  it.each(["admin_role", "editor"])("hands %s the core's result untouched", async (role) => {
    const { strapi } = host(role);
    registerRestrictedRelationGuard(strapi);
    const out = await strapi.contentAPI.sanitize.query(
      { ...pagesAndTeams(), filters: { pages: { title: "x" } } },
      department,
    );
    expect(out.populate).toEqual({ pages: "true", teams: "true" });
  });

  it("turns a filter across a restricted relation into the core's 400", async () => {
    const { strapi } = host("member");
    registerRestrictedRelationGuard(strapi);
    const query = strapi.contentAPI.sanitize.query(
      { filters: { teams: { name: "x" }, pages: { body: { $startsWith: "Conf" } } } },
      department,
    );
    await expect(query).rejects.toBeInstanceOf(errors.ValidationError);
    await expect(query).rejects.toThrow("Invalid key pages");
  });

  /**
   * Final review C1-RAW-WHERE: the core sanitizer keeps unknown root keys,
   * and users-permissions/upload hand them to strapi.db.query. A raw
   * `where`/`orderBy`/`select` walked department.pages (and private
   * columns) with no check at all.
   */
  const rawDbKeys = () => ({
    where: { department: { pages: { body: { $startsWith: "Secret" } } } },
    orderBy: { department: { pages: { title: "asc" } } },
    select: ["password"],
    groupBy: ["password"],
    offset: 3,
  });
  const legitUserQuery = () => ({
    filters: { department: { name: { $eq: "Eng" } } },
    sort: "username:asc",
    populate: { department: "true" },
    fields: ["username"],
    start: 0,
    limit: 50,
  });

  it("drops raw where/orderBy/select on /api/users for a member, keeps a legit query", async () => {
    const { strapi } = host("member");
    registerRestrictedRelationGuard(strapi);
    const out = await strapi.contentAPI.sanitize.query(
      { ...legitUserQuery(), ...rawDbKeys() },
      user,
    );
    expect(out).toEqual({ ...legitUserQuery(), locale: "sanitized-by-core" });
  });

  it.each(["admin_role", "editor", "guest", undefined])(
    "drops the raw DB keys for %s too (bypass skips only the relation cut)",
    async (role) => {
      const { strapi } = host(role);
      registerRestrictedRelationGuard(strapi);
      const out = await strapi.contentAPI.sanitize.query(
        { where: { password: { $startsWith: "$2a$" } }, orderBy: { password: "asc" } },
        user,
      );
      expect(out).toEqual({ locale: "sanitized-by-core" });
    },
  );

  it("keeps the query keys a route declares (contentAPI.addQueryParams)", async () => {
    const { strapi } = host("member");
    registerRestrictedRelationGuard(strapi);
    const route = { request: { query: { window: {} } } };
    const out = await strapi.contentAPI.sanitize.query(
      { window: "30", where: { id: 1 } },
      department,
      { route },
    );
    expect(out).toEqual({ window: "30", locale: "sanitized-by-core" });
  });

  it("appends the output backstop via get()+set(): member stripped, editor kept", () => {
    const { strapi, holder } = host("member");
    registerRestrictedRelationGuard(strapi);

    const registered = strapi.sanitizers.get("content-api.output") as Array<
      (schema: RelationModel) => (data: unknown) => unknown
    >;
    // Would be 0 with `strapi.sanitizers.add(...)` (see the trap above).
    expect(registered).toHaveLength(1);
    const sanitize = registered[0](department);

    expect(sanitize({ id: 1, name: "Eng", pages: [{ id: 2 }] })).toEqual({ id: 1, name: "Eng" });
    holder.ctx = { state: { user: { role: { type: "editor" } } } };
    expect(sanitize({ id: 1, pages: [{ id: 2 }] })).toEqual({ id: 1, pages: [{ id: 2 }] });
  });

  it("refuses to boot when contentAPI.sanitize.query is gone", () => {
    const { strapi } = host("member");
    expect(() => registerRestrictedRelationGuard({ ...strapi, contentAPI: {} })).toThrow(
      /sanitize\.query/,
    );
    expect(() =>
      registerRestrictedRelationGuard({ ...strapi, contentAPI: { sanitize: {} } }),
    ).toThrow(/FX05/);
  });

  it("register() installs the guard next to the contact sanitizer", () => {
    const { strapi, coreSanitizeQuery } = host("member");
    lifecycle.register({ strapi });
    expect(strapi.sanitizers.get("content-api.output")).toHaveLength(2);
    expect(strapi.contentAPI.sanitize.query).not.toBe(coreSanitizeQuery);
  });
});
