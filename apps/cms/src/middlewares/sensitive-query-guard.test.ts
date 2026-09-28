import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errors, sanitize, validate } from "@strapi/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import middlewaresConfig from "../../config/middlewares";
import sensitiveQueryGuard, {
  assertNoSensitiveUserKeys,
  registerSensitiveQueryGuard,
  type CoreModel,
  type SensitiveQueryGuardHost,
  type ValidateQuery,
} from "./sensitive-query-guard";
import {
  cmsPackageDir,
  openSqliteEngine,
  requirePackageFile,
  strapiPackageDir,
  type SqliteEngine,
} from "../test/sqlite-engine.test.helper";
import {
  PRIVILEGED_ROLE_TYPES,
  SENSITIVE_USER_FIELDS,
  USER_UID,
} from "../utils/sanitize-user-contact";

/**
 * FX22: the query side of the contact-field protection. Pinned:
 *   1. with the REAL @strapi/utils validators and traversals against the
 *      REAL schema.json files: a non-staff caller's filter, sort, nested
 *      populate filter/sort or users `_q` on a sensitive user field is a
 *      400 `Invalid key`, through /api/users and through user relations of
 *      content types; staff roles keep every one of them; `fields`,
 *      `populate`, `blocked`/`provider`/`confirmed` and the other user
 *      fields stay usable for everyone,
 *   2. the registration: it wraps `contentAPI.validate.query` once, runs the
 *      core validation first, logs each refusal without values, and refuses
 *      to boot without the validator,
 *   3. the Strapi behaviour the hook point relies on, against the installed
 *      @strapi/core, users-permissions and upload packages: global
 *      middlewares run before authentication, their factories are
 *      instantiated at boot before the routes, and every content-API
 *      controller resolves `strapi.contentAPI.validate.query` at call time,
 *   4. the schema-private user fields are no `_q` target for any role:
 *      `searchable: false`, checked on the installed @strapi/database,
 *   5. config/middlewares.ts registers the guard (and the other global
 *      guards): every other test here would still pass if a merge dropped
 *      that line, and the boot check only fires once the factory runs.
 */

const CMS_SRC = join(__dirname, "..");

const readSchema = (file: string): CoreModel & { collectionName?: string } =>
  JSON.parse(readFileSync(file, "utf8")) as CoreModel;

function contentType(uid: string, file: string): CoreModel {
  const schema = readSchema(file);
  return { ...schema, uid, modelType: "contentType" };
}

const apiSchema = (api: string) =>
  contentType(`api::${api}.${api}`, join(CMS_SRC, "api", api, "content-types", api, "schema.json"));

const MODELS: Record<string, CoreModel> = {
  [USER_UID]: contentType(
    USER_UID,
    join(CMS_SRC, "extensions", "users-permissions", "content-types", "user", "schema.json"),
  ),
  "api::announcement.announcement": apiSchema("announcement"),
  "api::department.department": apiSchema("department"),
  "api::team.team": apiSchema("team"),
};

const getModel = (uid: string): CoreModel | undefined => MODELS[uid];
const user = () => MODELS[USER_UID];
const announcement = () => MODELS["api::announcement.announcement"];

type RequestState = ReturnType<SensitiveQueryGuardHost["requestContext"]["get"]>;

/** A host with the real core validators; `request` is what requestContext.get() returns. */
function host(request: () => RequestState) {
  const validators = validate.createAPIValidators({
    getModel: (uid) => getModel(uid) as CoreModel,
  });
  const warn = vi.fn<(message: string) => void>();
  const strapi: SensitiveQueryGuardHost = {
    contentAPI: { validate: validators },
    requestContext: { get: request },
    getModel,
    log: { warn },
  };
  return { strapi, validators, warn };
}

/** A request of a caller with this role type (null: a user without a role, undefined: public). */
const as = (role: string | null | undefined): RequestState => ({
  method: "GET",
  path: "/api/users",
  state: { user: role === undefined ? undefined : { role: role === null ? null : { type: role } } },
});

/** Install the guard for `role` and validate `query` against `schema` the way a controller does. */
async function check(
  role: string | null | undefined,
  query: Record<string, unknown>,
  schema = user(),
) {
  const { strapi } = host(() => as(role));
  sensitiveQueryGuard({}, { strapi });
  const run = strapi.contentAPI?.validate?.query;
  if (!run) throw new Error("validator missing");
  return run(query, schema, {});
}

const NON_STAFF: ReadonlyArray<string | null | undefined> = [
  "guest",
  "authenticated",
  "public",
  "Member",
  "",
  null,
  undefined,
];
const STAFF = [...PRIVILEGED_ROLE_TYPES];

beforeEach(() => {
  // The core's private-attribute check reads the global strapi config.
  vi.stubGlobal("strapi", { config: { get: (_key: string, fallback?: unknown) => fallback } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("guest-class callers: a sensitive user field in a query is a 400 Invalid key", () => {
  const REFUSED: Array<[string, Record<string, unknown>, (() => CoreModel)?]> = [
    ["/api/users filters[email][$startsWith]", { filters: { email: { $startsWith: "a" } } }],
    ["/api/users filters[email] (implicit $eq)", { filters: { email: "ada@example.com" } }],
    [
      "/api/users filters[$or][1][phone][$containsi]",
      { filters: { $or: [{ displayName: { $containsi: "a" } }, { phone: { $containsi: "30" } }] } },
    ],
    [
      "/api/users filters[$and][0][$not][officeLocation]",
      { filters: { $and: [{ $not: { officeLocation: { $eq: "Berlin" } } }] } },
    ],
    ["/api/users filters[hireDate][$lt]", { filters: { hireDate: { $lt: "2020-01-01" } } }],
    ["/api/users filters[manager][email]", { filters: { manager: { email: { $eq: "x" } } } }],
    [
      "/api/users filters[teams][members][phone]",
      { filters: { teams: { members: { phone: { $null: true } } } } },
    ],
    ["/api/users sort=email:asc", { sort: "email:asc" }],
    ["/api/users sort=displayName,hireDate:desc", { sort: "displayName,hireDate:desc" }],
    ["/api/users sort[0]=email", { sort: ["displayName:asc", "email"] }],
    ["/api/users sort[officeLocation]=asc", { sort: { officeLocation: "asc" } }],
    ["/api/users sort=manager.email:asc", { sort: "manager.email:asc" }],
    ["/api/users _q", { _q: "ada@" }],
    [
      "/api/users populate[manager][filters][email]",
      { populate: { manager: { filters: { email: { $eq: "x" } } } } },
    ],
    [
      "/api/users populate[directReports][sort]=phone",
      { populate: { directReports: { sort: "phone:asc" } } },
    ],
    [
      "/api/users populate[department][populate][members][filters][hireDate]",
      {
        populate: {
          department: { populate: { members: { filters: { hireDate: { $gt: "2020-01-01" } } } } },
        },
      },
    ],
    [
      "/api/announcements filters[author][email]",
      { filters: { author: { email: { $eq: "x" } } } },
      announcement,
    ],
    ["/api/announcements sort=author.phone:asc", { sort: "author.phone:asc" }, announcement],
    [
      "/api/announcements populate[author][filters][email]",
      { populate: { author: { filters: { email: { $eq: "x" } } } } },
      announcement,
    ],
    [
      "/api/announcements populate[author][populate][manager][sort]",
      { populate: { author: { populate: { manager: { sort: ["hireDate:desc"] } } } } },
      announcement,
    ],
  ];

  it.each(REFUSED)("%s", async (_label, query, schema = user) => {
    const attempt = check("guest", query, schema());
    await expect(attempt).rejects.toBeInstanceOf(errors.ValidationError);
    await expect(attempt).rejects.toThrow(
      /^Invalid key (email|phone|hireDate|officeLocation|_q)\b/,
    );
  });

  it("names the key and its attribute path, like the core's own Invalid key", async () => {
    await expect(check("guest", { filters: { manager: { email: "x" } } })).rejects.toThrow(
      "Invalid key email at manager.email",
    );
    await expect(
      check("guest", { populate: { author: { filters: { phone: "1" } } } }, announcement()),
    ).rejects.toThrow("Invalid key phone at author.phone");
    await expect(check("guest", { sort: "email:asc" })).rejects.toThrow(/^Invalid key email$/);
  });

  it.each(NON_STAFF.map((role) => ({ role, label: JSON.stringify(role) ?? "undefined" })))(
    "refuses every sensitive field for role $label",
    async ({ role }) => {
      for (const field of SENSITIVE_USER_FIELDS) {
        if (field === "microsoftOid") continue; // schema-private: the core refuses it for everyone
        await expect(check(role, { filters: { [field]: { $eq: "x" } } })).rejects.toThrow(
          `Invalid key ${field}`,
        );
        await expect(check(role, { sort: `${field}:asc` })).rejects.toThrow(`Invalid key ${field}`);
      }
    },
  );

  it("fails closed without a request context", async () => {
    const { strapi } = host(() => undefined);
    registerSensitiveQueryGuard(strapi);
    await expect(
      strapi.contentAPI?.validate?.query?.({ filters: { email: "x" } }, user(), {}),
    ).rejects.toThrow("Invalid key email");
  });
});

describe("what stays allowed", () => {
  it.each(STAFF)(
    "%s keeps email/phone/hireDate/officeLocation filters, sorts, nested populate filters and _q",
    async (role) => {
      await expect(
        check(role, { filters: { email: { $containsi: "ada" } } }),
      ).resolves.toBeUndefined();
      await expect(
        check(role, {
          filters: { $or: [{ phone: { $containsi: "30" } }, { hireDate: { $lt: "2020-01-01" } }] },
        }),
      ).resolves.toBeUndefined();
      await expect(
        check(role, { sort: ["officeLocation:asc", "email:desc"] }),
      ).resolves.toBeUndefined();
      await expect(check(role, { _q: "ada@" })).resolves.toBeUndefined();
      await expect(
        check(
          role,
          { populate: { author: { filters: { email: { $eq: "x" } }, sort: "phone:asc" } } },
          announcement(),
        ),
      ).resolves.toBeUndefined();
    },
  );

  it("guest keeps the non-sensitive user filters the web relies on (blocked, provider, confirmed, names, ids)", async () => {
    await expect(
      check("guest", {
        filters: {
          blocked: { $eq: false },
          confirmed: { $eq: true },
          provider: { $eq: "local" },
          $or: [
            { displayName: { $containsi: "ad" } },
            { jobTitle: { $containsi: "ad" } },
            { username: { $containsi: "ad" } },
          ],
          id: { $in: [1, 2] },
          department: { name: { $eq: "Engineering" } },
        },
        sort: ["displayName:asc", "id:asc"],
        fields: ["displayName", "email", "blocked"],
        populate: { department: { fields: ["name"] }, manager: { populate: { avatar: true } } },
      }),
    ).resolves.toBeUndefined();
  });

  it("blocked, provider and confirmed are neither sensitive nor schema-private (the web filters users by blocked)", () => {
    for (const field of ["blocked", "provider", "confirmed"]) {
      expect(SENSITIVE_USER_FIELDS).not.toContain(field);
      expect(user().attributes[field]).toBeDefined();
      expect((user().attributes[field] as { private?: boolean }).private).not.toBe(true);
    }
  });

  it("guest keeps fields and populate of contact fields (the output sanitizer cleans them)", async () => {
    await expect(
      check(
        "guest",
        { populate: { author: { fields: ["displayName", "email", "jobTitle"] } } },
        announcement(),
      ),
    ).resolves.toBeUndefined();
    await expect(
      check("guest", { fields: ["email", "phone", "hireDate"] }),
    ).resolves.toBeUndefined();
  });

  it("guest keeps `_q` on content types whose root is not the user model", async () => {
    await expect(check("guest", { _q: "ada@" }, announcement())).resolves.toBeUndefined();
  });

  it("a field named like a contact field on another model is not a user field", async () => {
    const other: CoreModel = {
      modelType: "contentType",
      uid: "api::contact.contact",
      attributes: { email: { type: "email" }, phone: { type: "string" } },
    };
    await expect(
      check("guest", { filters: { email: "x" }, sort: "phone:asc" }, other),
    ).resolves.toBeUndefined();
  });
});

describe("schema-private user fields (FX22): the core refuses them for every role", () => {
  const PRIVATE = [
    "microsoftOid",
    "digestAnnouncements",
    "digestMentions",
    "digestKudos",
    "digestFrequency",
  ] as const;

  it.each(PRIVATE)("%s is private in the user schema", (field) => {
    expect((user().attributes[field] as { private?: boolean }).private).toBe(true);
  });

  it("no private user attribute the db search reads is searchable (`_q` is no oracle for any role)", () => {
    // @strapi/database's `_q` searches every string-typed (enumeration
    // included) and, for a numeric term, every number-typed column unless it
    // is `searchable: false`; `private` is not checked, and the core
    // validator never looks at `_q`. The type lists are the installed ones.
    const { isString, isNumber } = requirePackageFile<{
      isString(type: string): boolean;
      isNumber(type: string): boolean;
    }>(strapiPackageDir("@strapi/database"), "dist/utils/types.js");
    const privateSearchTargets = Object.entries(user().attributes).filter(([, attribute]) => {
      const { type, private: isPrivate } = attribute as { type: string; private?: boolean };
      return isPrivate === true && (isString(type) || isNumber(type));
    });
    expect(privateSearchTargets.map(([name]) => name)).toEqual(
      expect.arrayContaining(["microsoftOid", "digestFrequency", "resetPasswordToken"]),
    );
    for (const [name, attribute] of privateSearchTargets) {
      expect({ name, searchable: (attribute as { searchable?: boolean }).searchable }).toEqual({
        name,
        searchable: false,
      });
    }
  });

  it.each(["admin_role", "member", "guest"])("%s cannot filter or sort by them", async (role) => {
    for (const field of PRIVATE) {
      await expect(check(role, { filters: { [field]: { $eq: "x" } } })).rejects.toThrow(
        `Invalid key ${field}`,
      );
      await expect(check(role, { sort: `${field}:asc` })).rejects.toThrow(`Invalid key ${field}`);
    }
  });

  it("the core output sanitizer removes them from every response", async () => {
    const sanitizers = sanitize.createAPISanitizers({
      getModel: (uid) => getModel(uid) as CoreModel,
    });
    const out = (await sanitizers.output(
      {
        id: 7,
        username: "ada",
        displayName: "Ada",
        microsoftOid: "oid-ada",
        digestAnnouncements: true,
        digestMentions: true,
        digestKudos: false,
        digestFrequency: "daily",
        blocked: false,
      },
      user(),
      {},
    )) as Record<string, unknown>;
    expect(out).toEqual({ id: 7, username: "ada", displayName: "Ada", blocked: false });
  });
});

describe("installed @strapi/database: `_q` on /api/users (FX22)", () => {
  let engine: SqliteEngine | undefined;

  afterEach(async () => {
    await engine?.close();
    engine = undefined;
  });

  it("finds no user by microsoftOid or digestFrequency (below every role check)", async () => {
    // The users-permissions user service (fetchAll) passes `_q`, one of
    // ALLOWED_QUERY_PARAM_KEYS, on to db.query().findMany, and the core
    // validator never checks it: the schema flag is the only stop. The user
    // model as the core builds it, without its relations.
    const { transformContentTypesToModels } = requirePackageFile<{
      transformContentTypesToModels(contentTypes: unknown[], identifiers: unknown): unknown[];
    }>(strapiPackageDir("@strapi/core"), "dist/utils/transform-content-types-to-models.js");
    const scalar = Object.fromEntries(
      Object.entries(user().attributes).filter(
        ([, attribute]) => !["relation", "media"].includes((attribute as { type: string }).type),
      ),
    );
    const userType = {
      ...user(),
      modelName: "user",
      globalId: "UsersPermissionsUser",
      attributes: scalar,
    };
    engine = await openSqliteEngine((identifiers) =>
      transformContentTypesToModels([userType], identifiers),
    );
    const users = engine.db.query(USER_UID);
    await users.create({
      data: {
        documentId: "user-ada",
        username: "ada",
        email: "ada@example.com",
        displayName: "Ada Lovelace",
        microsoftOid: "3f5e1c2a-7b7d-4c1e-9d0f-oid000004711",
        digestFrequency: "daily",
      },
    });
    const search = async (term: string) =>
      (await users.findMany({ _q: term })).map((row) => row.username);

    expect(await search("Lovelace")).toEqual(["ada"]);
    expect(await search("7b7d-4c1e")).toEqual([]);
    expect(await search("oid000004711")).toEqual([]);
    expect(await search("daily")).toEqual([]);
  }, 30_000);
});

describe("registration", () => {
  it("wraps contentAPI.validate.query once and hands the request chain a pass-through", async () => {
    const { strapi } = host(() => as("guest"));
    const factory = sensitiveQueryGuard({}, { strapi });
    const wrapped = strapi.contentAPI?.validate?.query;
    sensitiveQueryGuard({}, { strapi });
    expect(strapi.contentAPI?.validate?.query).toBe(wrapped);

    const next = vi.fn(async () => "downstream");
    await expect(factory({}, next)).resolves.toBe("downstream");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("runs the core validation first: a malformed query keeps the core's own 400", async () => {
    const { strapi } = host(() => as("member"));
    registerSensitiveQueryGuard(strapi);
    await expect(
      strapi.contentAPI?.validate?.query?.({ filters: { nope: "x" } }, user(), {}),
    ).rejects.toThrow("Invalid key nope");
    await expect(
      strapi.contentAPI?.validate?.query?.({ filters: { password: "x" } }, user(), {}),
    ).rejects.toThrow("Invalid key password");
  });

  it("passes the core validator its arguments and this", async () => {
    const calls: unknown[][] = [];
    const validator: { query: ValidateQuery } = {
      async query(this: unknown, ...args) {
        calls.push([this, ...args]);
      },
    };
    const strapi: SensitiveQueryGuardHost = {
      contentAPI: { validate: validator },
      requestContext: { get: () => as("member") },
      getModel,
      log: { warn: vi.fn() },
    };
    registerSensitiveQueryGuard(strapi);
    const options = { auth: { credentials: { id: 7 } } };
    await validator.query({ sort: "email" }, user(), options);
    expect(calls).toEqual([[validator, { sort: "email" }, user(), options]]);
  });

  it("logs each refusal with method, path, model and role, never the value", async () => {
    const { strapi, warn } = host(() => ({
      method: "GET",
      path: "/api/users",
      state: { user: { role: { type: "guest" } } },
    }));
    registerSensitiveQueryGuard(strapi);
    await expect(
      strapi.contentAPI?.validate?.query?.(
        { filters: { email: { $startsWith: "secret-prefix" } } },
        user(),
        {},
      ),
    ).rejects.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      "[sensitive-query-guard] 400 Invalid key email on GET /api/users (plugin::users-permissions.user, role guest)",
    );
    expect(warn.mock.calls[0][0]).not.toContain("secret-prefix");
  });

  it("refuses to boot without contentAPI.validate.query", () => {
    const base = host(() => undefined).strapi;
    expect(() => registerSensitiveQueryGuard({ ...base, contentAPI: undefined })).toThrow(
      /refusing to boot without the FX22 guard/,
    );
    expect(() => registerSensitiveQueryGuard({ ...base, contentAPI: { validate: {} } })).toThrow(
      /refusing to boot without the FX22 guard/,
    );
  });

  it("assertNoSensitiveUserKeys walks without any role check", async () => {
    await expect(
      assertNoSensitiveUserKeys({ filters: { email: "x" } }, user(), getModel),
    ).rejects.toThrow("Invalid key email");
    await expect(
      assertNoSensitiveUserKeys({ filters: { displayName: "x" } }, user(), getModel),
    ).resolves.toBeUndefined();
  });
});

describe("config/middlewares.ts: the global guards are registered", () => {
  /** Strapi's env helper, reduced to the defaults. */
  const env = Object.assign((_key: string, fallback?: unknown) => fallback, {
    int: (_key: string, fallback?: number) => fallback ?? 0,
    bool: (_key: string, fallback?: boolean) => fallback ?? false,
    array: (_key: string, fallback?: string[]) => fallback ?? [],
  });
  const names = () =>
    middlewaresConfig({ env }).map((entry) => (typeof entry === "string" ? entry : entry.name));

  it.each(["global::sensitive-query-guard", "global::uploads-auth", "global::auth-path-guard"])(
    "lists %s exactly once",
    (name) => {
      expect(names().filter((entry) => entry === name)).toHaveLength(1);
    },
  );

  it("every global:: entry names a file in src/middlewares (Strapi resolves it by file name)", () => {
    const globals = names().filter((entry) => entry.startsWith("global::"));
    expect(globals.length).toBeGreaterThanOrEqual(3);
    for (const name of globals) {
      const file = join(CMS_SRC, "middlewares", `${name.slice("global::".length)}.ts`);
      expect({ name, exists: existsSync(file) }).toEqual({ name, exists: true });
    }
  });
});

describe("installed Strapi: where the guard hooks in", () => {
  const source = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

  it("global middlewares run before authentication: each route composes authenticate itself", () => {
    expect(
      source(strapiPackageDir("@strapi/core"), "dist/services/server/compose-endpoint.js"),
    ).toMatch(
      /compose__default\.default\(\[\s*createRouteInfoMiddleware\(route\),\s*authenticate,\s*authorize,/,
    );
  });

  it("the global middleware factories are instantiated at boot, before the routes are registered", async () => {
    expect(source(strapiPackageDir("@strapi/core"), "dist/Strapi.js")).toMatch(
      /await this\.server\.initMiddlewares\(\);\s*this\.server\.initRouting\(\);/,
    );
    const { resolveMiddlewares } = requirePackageFile<{
      resolveMiddlewares(
        config: unknown[],
        strapi: unknown,
      ): Array<{ name: string; handler: unknown }>;
    }>(strapiPackageDir("@strapi/core"), "dist/services/server/middleware.js");
    const { strapi } = host(() => as("guest"));
    const resolved = resolveMiddlewares(["global::sensitive-query-guard"], {
      ...strapi,
      middleware: (name: string) =>
        name === "global::sensitive-query-guard" ? sensitiveQueryGuard : undefined,
    });
    expect(resolved).toHaveLength(1);
    expect(typeof resolved[0].handler).toBe("function");
    // Installed by the instantiation alone, before any request.
    await expect(
      strapi.contentAPI?.validate?.query?.({ filters: { email: "x" } }, user(), {}),
    ).rejects.toThrow("Invalid key email");
  });

  it.each([
    [
      "@strapi/core core-api controller",
      () => strapiPackageDir("@strapi/core"),
      "dist/core-api/controller/index.js",
      "strapi.contentAPI.validate.query(ctx.query, contentType,",
    ],
    [
      "users-permissions user controller",
      () => cmsPackageDir("@strapi/plugin-users-permissions"),
      "dist/server/controllers/user.js",
      "strapi.contentAPI.validate.query(query, schema,",
    ],
    [
      "upload content-api controller",
      () => strapiPackageDir("@strapi/upload"),
      "dist/server/controllers/content-api.js",
      "strapi.contentAPI.validate.query(data, schema,",
    ],
  ])("the %s resolves strapi.contentAPI.validate.query at call time", (_label, dir, file, call) => {
    expect(source(dir(), file)).toContain(call);
  });
});
