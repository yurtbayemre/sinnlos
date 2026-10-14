import { errors } from "@strapi/utils";
import { describe, expect, it, vi } from "vitest";
import { documentMiddlewares } from "./bootstrap/document-middlewares";
import { registerRestrictedRelationGuard } from "./bootstrap/restricted-relation-guard";
import { registerUserContactSanitizer } from "./bootstrap/user-contact-sanitizer";
import lifecycle from "./index";
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

/** A request's `auth` as the users-permissions strategy builds it: an ability over scopes. */
const authWith = (...scopes: string[]) => ({
  strategy: { name: "users-permissions" },
  ability: { can: (scope: string) => scopes.includes(scope) },
});

/**
 * The Strapi slice the datetime guard touches in register(): log, hooks,
 * dialect; plus the Document Service middleware registry the poll audience
 * guard hangs onto, and the auth service the relation guard asks for grants
 * inside populate (batch 15.2).
 */
function datetimeHost() {
  const hooks = new Map<string, Array<(context: unknown) => Promise<void>>>();
  return {
    hooks,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    db: { dialect: { client: "sqlite" } },
    documents: { use: vi.fn() },
    // users-permissions' verify (strategies/users-permissions.js): the
    // request's ability decides; no auth or no ability, no grant.
    auth: {
      verify: vi.fn(async (auth: unknown, config: { scope: string }) => {
        const ability = (auth as { ability?: { can(scope: string): boolean } } | undefined)
          ?.ability;
        if (!ability) throw new errors.UnauthorizedError();
        if (!ability.can(config.scope)) throw new errors.ForbiddenError();
      }),
    },
    hook: (name: string) => ({
      register: (handler: (context: unknown) => Promise<void>) => {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
    }),
  };
}

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
 *   - admin_role/editor bypass both, except for the closed targets (wiki
 *     revisions, batch 15.1); no request context = guard applies,
 *   - inside a populate, filters follow only relations whose target the
 *     caller may `find`, asked through `strapi.auth.verify` with the
 *     request's `auth` (batch 15.2), for every caller, and a sort follows no
 *     relation at all (batch 16),
 *   - boot fails when a hook point is gone (no silent re-open),
 *   - register() installs it next to the contact sanitizer.
 */
describe("relation side-channel guard registration (FX05)", () => {
  const WIKI_PAGE = "api::wiki-page.wiki-page";
  const DEPARTMENT = "api::department.department";
  const ROLE = "plugin::users-permissions.role";
  const department: RelationModel = {
    uid: DEPARTMENT,
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
      department: { type: "relation", target: DEPARTMENT },
      role: { type: "relation", target: ROLE },
    },
  };
  const wikiPage: RelationModel = {
    uid: WIKI_PAGE,
    attributes: {
      title: { type: "string" },
      children: { type: "relation", target: WIKI_PAGE },
      author: { type: "relation", target: USER_UID },
      department: { type: "relation", target: DEPARTMENT },
      revisions: { type: "relation", target: "api::wiki-revision.wiki-revision" },
    },
  };
  const models: Record<string, RelationModel> = {
    [department.uid as string]: department,
    [USER_UID]: user,
    [WIKI_PAGE]: wikiPage,
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
      ...datetimeHost(),
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

  it.each(["admin_role", "editor"])("hands %s the FX05 relations untouched", async (role) => {
    const { strapi } = host(role);
    registerRestrictedRelationGuard(strapi);
    const out = await strapi.contentAPI.sanitize.query(
      { ...pagesAndTeams(), filters: { pages: { title: "x" } } },
      department,
    );
    expect(out.populate).toEqual({ pages: "true", teams: "true" });
  });

  it.each(["admin_role", "editor", "member", undefined])(
    "holds %s to the closed targets: wiki revisions on both sides (batch 15.1)",
    async (role) => {
      const { strapi } = host(role);
      registerRestrictedRelationGuard(strapi);
      const out = await strapi.contentAPI.sanitize.query(
        { populate: { revisions: "true", children: "true" } },
        wikiPage,
      );
      expect(out.populate).toEqual({ children: "true" });
      // The filter inside a populate: the core never checks its scope.
      await expect(
        strapi.contentAPI.sanitize.query(
          { populate: { children: { filters: { revisions: { body: { $startsWith: "D" } } } } } },
          wikiPage,
        ),
      ).rejects.toThrow("Invalid key revisions at children.revisions");
      const [backstop] = strapi.sanitizers.get("content-api.output") as Array<
        (schema: RelationModel) => (data: unknown) => unknown
      >;
      expect(backstop(wikiPage)({ id: 1, revisions: [{ id: 2 }], children: [] })).toEqual({
        id: 1,
        children: [],
      });
    },
  );

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

  describe("grants inside populate (batch 15.2)", () => {
    /** Filters through department and through author.role, nested in a populate. */
    const throughDepartment = () => ({
      populate: { children: { filters: { department: { name: { $eq: "Eng" } } } } },
    });
    const throughRole = () => ({
      populate: { children: { filters: { author: { role: { type: { $eq: "x" } } } } } },
    });
    const READS = [`${WIKI_PAGE}.find`, `${USER_UID}.find`];

    it.each(["admin_role", "editor", "member", "guest", undefined])(
      "refuses %s a relation it may not find, with the core's 400; the grant lets it through",
      async (role) => {
        const { strapi } = host(role);
        registerRestrictedRelationGuard(strapi);
        const readsOnly = authWith(...READS);
        const without = strapi.contentAPI.sanitize.query(throughDepartment(), wikiPage, {
          auth: readsOnly,
        });
        await expect(without).rejects.toBeInstanceOf(errors.ValidationError);
        await expect(without).rejects.toThrow("Invalid key department at children.department");
        await expect(
          strapi.contentAPI.sanitize.query(throughRole(), wikiPage, { auth: readsOnly }),
        ).rejects.toThrow("Invalid key role at children.author.role");

        const granted = authWith(...READS, `${DEPARTMENT}.find`, `${ROLE}.find`);
        for (const query of [throughDepartment(), throughRole()]) {
          await expect(
            strapi.contentAPI.sanitize.query(query, wikiPage, { auth: granted }),
          ).resolves.toEqual({ ...query, locale: "sanitized-by-core" });
        }
      },
    );

    it.each(["admin_role", "editor", "member", undefined])(
      "refuses %s a relation or media sort inside a populate, whatever it holds (batch 16)",
      async (role) => {
        const { strapi } = host(role);
        registerRestrictedRelationGuard(strapi);
        const everything = authWith(...READS, `${DEPARTMENT}.find`, `${ROLE}.find`);
        const sorted = (sort: unknown) =>
          strapi.contentAPI.sanitize.query({ populate: { children: { sort } } }, wikiPage, {
            auth: everything,
          });
        await expect(sorted("title:asc,author.username:desc")).rejects.toThrow(
          "Invalid key author at children.author",
        );
        await expect(sorted({ department: { name: "asc" } })).rejects.toBeInstanceOf(
          errors.ValidationError,
        );
        await expect(sorted("title:desc")).resolves.toEqual({
          populate: { children: { sort: "title:desc" } },
          locale: "sanitized-by-core",
        });
        expect(strapi.auth.verify).not.toHaveBeenCalled();
      },
    );

    it("asks strapi.auth.verify with the request's auth and `<target>.find`, once per target", async () => {
      const { strapi } = host("member");
      registerRestrictedRelationGuard(strapi);
      const auth = authWith(...READS, `${DEPARTMENT}.find`);
      await strapi.contentAPI.sanitize.query(
        {
          populate: {
            children: {
              filters: {
                $or: [{ department: { name: "a" } }, { department: { name: "b" } }],
                author: { username: "x" },
              },
            },
          },
        },
        wikiPage,
        { auth },
      );
      expect(strapi.auth.verify.mock.calls).toEqual([
        [auth, { scope: `${DEPARTMENT}.find` }],
        [auth, { scope: `${USER_UID}.find` }],
      ]);
    });

    it("leaves root filters and sort to the core, and asks nothing without a nested query", async () => {
      const { strapi } = host("guest");
      registerRestrictedRelationGuard(strapi);
      const query = {
        filters: { department: { name: "x" } },
        sort: "author.role.type:asc",
        populate: { children: { populate: { author: "true" } }, department: "true" },
      };
      await expect(
        strapi.contentAPI.sanitize.query(query, wikiPage, { auth: authWith() }),
      ).resolves.toEqual({ ...query, locale: "sanitized-by-core" });
      expect(strapi.auth.verify).not.toHaveBeenCalled();
    });

    it("fails closed without auth (no controller passes none)", async () => {
      const { strapi } = host("admin_role");
      registerRestrictedRelationGuard(strapi);
      await expect(strapi.contentAPI.sanitize.query(throughDepartment(), wikiPage)).rejects.toThrow(
        "Invalid key department at children.department",
      );
    });
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

  it("refuses to boot when strapi.auth.verify is gone (batch 15.2)", () => {
    const { strapi } = host("member");
    expect(() => registerRestrictedRelationGuard({ ...strapi, auth: undefined })).toThrow(
      /strapi\.auth\.verify not found/,
    );
    expect(() => registerRestrictedRelationGuard({ ...strapi, auth: {} })).toThrow(
      /populate grant check/,
    );
  });

  it("register() installs the guard next to the contact sanitizer", async () => {
    const { strapi, coreSanitizeQuery } = host("member");
    await lifecycle.register({ strapi });
    expect(strapi.sanitizers.get("content-api.output")).toHaveLength(2);
    expect(strapi.contentAPI.sanitize.query).not.toBe(coreSanitizeQuery);
  });
});

/**
 * Wiring test for the department/team draft guard (decision 05). The guard
 * itself is pinned in utils/org-dp-guard.test.ts; this pins that register()
 * awaits it FIRST: Strapi deletes org draft rows in the beforeSync hook right
 * after register(), so a rejection has to stop the boot before anything else
 * in register() runs.
 */
describe("org draft guard in register() (decision 05)", () => {
  const ORG_MODELS: Record<
    string,
    { collectionName: string; options: { draftAndPublish: boolean } }
  > = {
    "api::department.department": {
      collectionName: "departments",
      options: { draftAndPublish: false },
    },
    "api::team.team": { collectionName: "teams", options: { draftAndPublish: false } },
  };

  function orgHost(drafts: Record<string, number>) {
    const counted: string[] = [];
    const coreSanitizeQuery = vi.fn(async (query: Record<string, unknown>) => query);
    const strapi = {
      ...datetimeHost(),
      getModel: (uid: string) => ORG_MODELS[uid],
      requestContext: { get: () => undefined },
      sanitizers: makeSanitizers(),
      contentAPI: { sanitize: { query: coreSanitizeQuery } },
      db: {
        dialect: { client: "sqlite" },
        getSchemaConnection: () => ({ hasTable: async () => true }),
        getConnection: (table: string) => ({
          whereNull: () => ({
            count: async () => {
              counted.push(table);
              return [{ n: String(drafts[table] ?? 0) }];
            },
          }),
        }),
      },
    };
    return { strapi, counted, coreSanitizeQuery };
  }

  it("rejects before registering anything while draft rows exist", async () => {
    const { strapi, coreSanitizeQuery } = orgHost({ teams: 2 });
    await expect(lifecycle.register({ strapi })).rejects.toThrow(
      /^\[org-dp\] teams still holds 2 draft row\(s\)/,
    );
    expect(strapi.sanitizers.store.has("content-api.output")).toBe(false);
    expect(strapi.contentAPI.sanitize.query).toBe(coreSanitizeQuery);
  });

  it("checks both tables, then registers each output sanitizer exactly once", async () => {
    const { strapi, counted, coreSanitizeQuery } = orgHost({});
    await lifecycle.register({ strapi });
    expect(counted).toEqual(["departments", "teams"]);
    expect(strapi.sanitizers.get("content-api.output")).toHaveLength(2);
    expect(strapi.contentAPI.sanitize.query).not.toBe(coreSanitizeQuery);
  });

  it("registers no poll audience guard while draft rows exist", async () => {
    const { strapi } = orgHost({ departments: 1 });
    await expect(lifecycle.register({ strapi })).rejects.toThrow(/^\[org-dp\]/);
    expect(strapi.documents.use).not.toHaveBeenCalled();
  });

  /*
   * The wiki-revision guard (batch 16, utils/revision-dp-guard.ts) runs right
   * after the org guard and also before everything else in register():
   * Strapi deletes revision draft rows in the same beforeSync hook.
   */
  const withRevisions = (drafts: Record<string, number>) => {
    const host = orgHost(drafts);
    const getModel = host.strapi.getModel;
    host.strapi.getModel = (uid: string) =>
      uid === "api::wiki-revision.wiki-revision"
        ? { collectionName: "wiki_revisions", options: { draftAndPublish: false } }
        : getModel(uid);
    return host;
  };

  it("checks wiki_revisions right after the org tables", async () => {
    const { strapi, counted } = withRevisions({});
    await lifecycle.register({ strapi });
    expect(counted).toEqual(["departments", "teams", "wiki_revisions"]);
  });

  it("rejects before registering anything while revision draft rows exist", async () => {
    const { strapi, coreSanitizeQuery } = withRevisions({ wiki_revisions: 3 });
    await expect(lifecycle.register({ strapi })).rejects.toThrow(
      /^\[revision-dp\] wiki_revisions still holds 3 draft row\(s\)/,
    );
    expect(strapi.sanitizers.store.has("content-api.output")).toBe(false);
    expect(strapi.contentAPI.sanitize.query).toBe(coreSanitizeQuery);
    expect(strapi.documents.use).not.toHaveBeenCalled();
  });

  it("the org guard decides first when both hold draft rows", async () => {
    const { strapi, counted } = withRevisions({ teams: 1, wiki_revisions: 3 });
    await expect(lifecycle.register({ strapi })).rejects.toThrow(/^\[org-dp\]/);
    expect(counted).toEqual(["departments", "teams"]);
  });
});

/**
 * Wiring test for the Document Service middlewares
 * (bootstrap/document-middlewares.ts, decision 06 §K): register() hangs them
 * onto `strapi.documents` in slot order, before any plugin bootstrap or our
 * own bootstrap writes a row, and refuses to boot without the registry.
 * Among them the write-time audience guards (decision 02, Codex review
 * finding 1; utils/poll-audience-guard.ts; for documents and quick links
 * the batch 12 review B12-01, utils/department-audience-guard.ts) and the
 * user write guard (FX40, extensions/users-permissions/strapi-server.ts
 * createUserWriteGuard). Their order is pinned in
 * bootstrap/document-middlewares.test.ts.
 */
describe("Document Service middlewares in register() (decision 06 §K)", () => {
  function guardHost(documents: unknown) {
    const stub = datetimeHost();
    const transaction = vi.fn(async (callback: () => Promise<unknown>) => callback());
    return {
      ...stub,
      db: {
        ...stub.db,
        transaction,
        // No rows and no ballots (the poll guard's vote freeze counts them).
        query: () => ({
          findMany: async () => [],
          updateMany: async () => ({ count: 0 }),
          count: async () => 0,
        }),
      },
      getModel: () => undefined,
      requestContext: { get: () => undefined },
      sanitizers: makeSanitizers(),
      contentAPI: { sanitize: { query: vi.fn(async (query: unknown) => query) } },
      documents,
      transaction,
    };
  }

  type Middleware = (
    context: { uid: string; action: string; params: unknown },
    next: () => Promise<unknown>,
  ) => Promise<unknown>;

  it("registers every slot's middleware in order: polls, documents and quick links, users (FX40) among them", async () => {
    const use = vi.fn();
    const strapi = guardHost({ use });
    await lifecycle.register({ strapi });
    const slots = documentMiddlewares(strapi as never).map((entry) => entry.slot);
    expect(use).toHaveBeenCalledTimes(slots.length);
    const bySlot = new Map(
      slots.map((slot, index) => [slot, use.mock.calls[index][0] as Middleware]),
    );
    const polls = bySlot.get("poll-audience-guard")!;
    const departmentScoped = bySlot.get("department-audience-guard")!;
    const users = bySlot.get("user-write-guard")!;
    expect(slots[slots.length - 1]).toBe("user-write-guard");
    // The user guard: tokenVersion never reaches a user write; other types
    // pass untouched.
    const reached: unknown[] = [];
    const write = (uid: string) => ({
      uid,
      action: "update",
      params: { documentId: "u1", data: { displayName: "Ada", tokenVersion: 0 } },
    });
    for (const uid of ["plugin::users-permissions.user", "api::poll.poll"]) {
      const context = write(uid);
      await users(context, async () => reached.push(context.params));
    }
    expect(reached).toEqual([
      { documentId: "u1", data: { displayName: "Ada" } },
      { documentId: "u1", data: { displayName: "Ada", tokenVersion: 0 } },
    ]);
    // Which uids each one guards: a guarded write runs in its transaction.
    const guards = async (middleware: Middleware, uid: string) => {
      strapi.transaction.mockClear();
      await middleware({ uid, action: "publish", params: { documentId: "d1" } }, async () => null);
      return strapi.transaction.mock.calls.length === 1;
    };
    const uids = [
      "api::poll.poll",
      "api::document.document",
      "api::quick-link.quick-link",
      "api::announcement.announcement",
    ];
    const guarded = async (middleware: Middleware) => {
      const hits: string[] = [];
      for (const uid of uids) if (await guards(middleware, uid)) hits.push(uid);
      return hits;
    };
    expect(await guarded(polls)).toEqual(["api::poll.poll"]);
    // Batch 15 lane 15D: the department/targeting guard also raises the
    // announcement (and event) targeting flags (utils/targeting-flags.ts).
    expect(await guarded(departmentScoped)).toEqual([
      "api::document.document",
      "api::quick-link.quick-link",
      "api::announcement.announcement",
    ]);
  });

  it("refuses to boot when strapi.documents.use is gone", async () => {
    await expect(lifecycle.register({ strapi: guardHost({}) })).rejects.toThrow(
      /^\[document-middlewares\] strapi\.documents\.use not found/,
    );
  });
});

/**
 * Wiring test for the datetime contract (database/ensure-timestamptz.ts):
 * register() runs the boot checks and hooks the timestamptz guard into
 * Strapi's afterSync. On SQLite (this stub) both are no-ops apart from the
 * zone log line.
 */
describe("timestamptz guard in register() (datetime contract)", () => {
  it("registers exactly one beforeSync and one afterSync handler and logs the zones", async () => {
    const stub = datetimeHost();
    const strapi = {
      ...stub,
      getModel: () => undefined,
      requestContext: { get: () => undefined },
      sanitizers: makeSanitizers(),
      contentAPI: { sanitize: { query: vi.fn(async (query: unknown) => query) } },
    };
    await lifecycle.register({ strapi });
    expect(stub.hooks.get("strapi::content-types.beforeSync")).toHaveLength(1);
    expect(stub.hooks.get("strapi::content-types.afterSync")).toHaveLength(1);
    expect(stub.log.info).toHaveBeenCalledWith(
      expect.stringMatching(/^\[datetime\] process time zone .+, APP_TIME_ZONE /),
    );
    // Both handlers are no-ops off Postgres.
    await stub.hooks.get("strapi::content-types.beforeSync")?.[0]({});
    await stub.hooks.get("strapi::content-types.afterSync")?.[0]({});
  });
});
