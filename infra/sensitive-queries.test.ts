import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * Cross-app contract of batch 7 (FX22 x WD05/WD06/WD10): the web's user
 * queries against the cms guard that refuses them.
 *
 * `global::sensitive-query-guard` (lane 2C) answers 400 to a guest-class
 * caller (guest, the `authenticated` fallback, unknown roles) whose query
 * filters, sorts or `_q`-searches on a SENSITIVE_USER_FIELDS attribute of a
 * user, at any depth. Lanes 2B and 2C both rewrote web queries that run for
 * such callers: the people grid, the org chart, the kudos picker, the ⌘K
 * search, the bell, the events and the dashboard. A page whose query trips
 * the guard shows an error banner or an empty list for guests only, which
 * no staff account notices. Pinned here:
 *
 *   1. the web's exported user and search query builders, parsed the way
 *      Strapi parses a query string (qs with the core's strapi::query
 *      defaults), pass the cms's own assertNoSensitiveUserKeys against the
 *      real schemas, for every guest-class role; the staff-only e-mail
 *      clause of the people search is refused (so the check is live) and is
 *      sent only to CONTACT_SEARCH_ROLES (contracts.test.ts pins that set);
 *   2. `blocked`, which the kudos picker filters on, stays usable;
 *   3. no other query string in apps/web/src (pages, actions, the bell, the
 *      events and dashboard loaders) filters or sorts on a sensitive field
 *      or uses `_q`: a source scan with one allowlisted clause. `fields[]`
 *      selections are fine (the output sanitizer cleans them).
 *
 * The cms modules are loaded at run time (see contracts.test.ts): this file
 * is type-checked by the strict web/infra program.
 */

// The search module's server imports; only its pure builders run here.
vi.mock("@/lib/strapi", () => ({ strapi: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations: async () => (key: string) => key,
}));

const { liveSearchPaths, preloadPath, PRELOAD_KINDS, canSearchByEmail } = await import(
  "../apps/web/src/lib/search-action"
);
const { kudosRecipientQuery, PEOPLE_QUERY, ORG_CHART_QUERY } = await import(
  "../apps/web/src/lib/people-dto"
);

const ROOT = join(__dirname, "..");
const CMS_SRC = join(ROOT, "apps", "cms", "src");
const WEB_SRC = join(ROOT, "apps", "web", "src");

async function cms<T>(relativePath: string): Promise<T> {
  return (await import(join(CMS_SRC, relativePath))) as T;
}

interface GuardModel {
  uid: string;
  modelType: "contentType";
  kind?: string;
  info?: { pluralName?: string; singularName?: string };
  attributes: Record<string, unknown>;
}

const { assertNoSensitiveUserKeys } = await cms<{
  assertNoSensitiveUserKeys(
    query: Record<string, unknown>,
    schema: GuardModel,
    getModel: (uid: string) => GuardModel | undefined,
  ): Promise<void>;
}>("middlewares/sensitive-query-guard.ts");

const { SENSITIVE_USER_FIELDS, USER_UID, shouldSanitizeForRole } = await cms<{
  SENSITIVE_USER_FIELDS: readonly string[];
  USER_UID: string;
  shouldSanitizeForRole(role: string | null | undefined): boolean;
}>("utils/sanitize-user-contact.ts");

// ---------------------------------------------------------------------------
// Schemas and the query parser, as the cms has them
// ---------------------------------------------------------------------------

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

function loadModels(): Record<string, GuardModel> {
  const models: Record<string, GuardModel> = {};
  const apiDir = join(CMS_SRC, "api");
  for (const api of readdirSync(apiDir)) {
    const typesDir = join(apiDir, api, "content-types");
    if (!existsSync(typesDir)) continue;
    for (const type of readdirSync(typesDir)) {
      const file = join(typesDir, type, "schema.json");
      if (!existsSync(file)) continue;
      const uid = `api::${api}.${type}`;
      models[uid] = {
        ...readJson<Omit<GuardModel, "uid" | "modelType">>(file),
        uid,
        modelType: "contentType",
      };
    }
  }
  models[USER_UID] = {
    ...readJson<Omit<GuardModel, "uid" | "modelType">>(
      join(CMS_SRC, "extensions", "users-permissions", "content-types", "user", "schema.json"),
    ),
    uid: USER_UID,
    modelType: "contentType",
  };
  return models;
}

const MODELS = loadModels();
const getModel = (uid: string): GuardModel | undefined => MODELS[uid];

const requireFromCms = createRequire(join(ROOT, "apps", "cms", "package.json"));
const requireFromCore = createRequire(
  createRequire(requireFromCms.resolve("@strapi/strapi/package.json")).resolve(
    "@strapi/core/package.json",
  ),
);
const qs = requireFromCore("qs") as {
  parse(query: string, options: Record<string, unknown>): Record<string, unknown>;
};
/** @strapi/core dist/middlewares/query.js defaults (config/middlewares.ts sets none). */
const STRAPI_QS = { strictNullHandling: true, arrayLimit: 100, depth: 20 };

/** The root model of a content-API path: /api/users* or /api/<pluralName>. */
function rootModel(path: string): GuardModel {
  const match = /^\/api\/([^/?]+)/.exec(path);
  if (!match) throw new Error(`not a content-API path: ${path}`);
  if (match[1] === "users") return MODELS[USER_UID];
  const model = Object.values(MODELS).find((m) => m.info?.pluralName === match[1]);
  if (!model) throw new Error(`no content type for ${path}`);
  return model;
}

/** Runs the cms guard's walk over a path the way a guest-class request would hit it. */
async function guard(path: string): Promise<void> {
  const [, query = ""] = path.split("?");
  await assertNoSensitiveUserKeys(qs.parse(query, STRAPI_QS), rootModel(path), getModel);
}

const GUEST_CLASS: ReadonlyArray<string | null> = ["guest", "authenticated", null];

// ---------------------------------------------------------------------------
// 1-2. The exported builders against the real guard
// ---------------------------------------------------------------------------

describe("web query builders pass the cms sensitive-query guard for guest-class callers", () => {
  it("the roles here are the ones the cms sanitizes", () => {
    for (const role of GUEST_CLASS) expect(shouldSanitizeForRole(role), String(role)).toBe(true);
  });

  it("⌘K live search: every kind, every guest-class role", async () => {
    for (const role of GUEST_CLASS) {
      for (const [kind, path] of Object.entries(liveSearchPaths("ada@example", role))) {
        await expect(guard(path), `${kind} as ${role}`).resolves.toBeUndefined();
      }
    }
  });

  it("⌘K preload: every kind", async () => {
    for (const kind of PRELOAD_KINDS) {
      await expect(
        guard(preloadPath(kind, 1, "2026-09-28T00:00:00.000Z")),
        kind,
      ).resolves.toBeUndefined();
    }
  });

  it("/people, the org chart and the kudos picker (which filters on blocked)", async () => {
    await expect(guard(`/api/users?${PEOPLE_QUERY}&start=0&limit=100`)).resolves.toBeUndefined();
    await expect(guard(`/api/users?${ORG_CHART_QUERY}&start=0&limit=100`)).resolves.toBeUndefined();
    await expect(guard(`/api/users?${kudosRecipientQuery(7)}`)).resolves.toBeUndefined();
    await expect(guard(`/api/users?${kudosRecipientQuery(null)}`)).resolves.toBeUndefined();
    expect(kudosRecipientQuery(7)).toContain("filters[$or][0][blocked][$ne]=true");
    expect(SENSITIVE_USER_FIELDS).not.toContain("blocked");
  });

  it("the staff e-mail clause is refused by the guard, so it goes to staff only", async () => {
    const staff = liveSearchPaths("ada@example", "member").person;
    expect(staff).toContain("[email][$containsi]");
    await expect(guard(staff)).rejects.toThrow(/Invalid key email/);
    for (const role of GUEST_CLASS) expect(canSearchByEmail(role)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Every other web query string: a source scan
// ---------------------------------------------------------------------------

/** Non-test sources of apps/web/src. */
function webSources(dir = WEB_SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...webSources(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts"))
      out.push(path);
  }
  return out;
}

/**
 * The one sensitive clause a web query may carry: the people search's
 * e-mail filter, which liveSearchPaths adds only for CONTACT_SEARCH_ROLES
 * (tested above and in apps/web/src/lib/search.test.ts).
 */
const ALLOWED = new Set(["lib/search-action.ts filters[$or][2][email][$containsi]"]);

/** Query keys (and sort values) in a source text that touch a sensitive user field. */
function sensitiveClauses(source: string): string[] {
  const found: string[] = [];
  const sensitive = new Set(SENSITIVE_USER_FIELDS);
  const keyRe = /(?<![\w\]])((?:filters|sort|populate)(?:\[[^\]\s"'`]*\])*)(?:=([^&"'`\s]*))?/g;
  for (const match of source.matchAll(keyRe)) {
    const [, key, value = ""] = match;
    const segments = [...key.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);
    const filters = key.startsWith("filters") || segments.includes("filters");
    const sort = key.startsWith("sort") || segments.includes("sort");
    if (!filters && !sort) continue;
    const words = [...segments, ...(sort ? value.split(/[,:.]/) : [])];
    if (words.some((word) => sensitive.has(word)))
      found.push(key + (sort && value ? `=${value}` : ""));
  }
  return found;
}

describe("no other web query filters or sorts on a sensitive user field", () => {
  const sources = webSources();

  it("scans the web sources (sanity: the known clause is found)", () => {
    expect(sources.length).toBeGreaterThan(50);
    const search = readFileSync(join(WEB_SRC, "lib", "search-action.ts"), "utf8");
    expect(sensitiveClauses(search)).toEqual(["filters[$or][2][email][$containsi]"]);
    expect(sensitiveClauses("`/api/users?sort=email:asc`")).toEqual(["sort=email:asc"]);
    expect(sensitiveClauses('"populate[author][filters][phone][$eq]=1"')).toEqual([
      "populate[author][filters][phone][$eq]",
    ]);
    expect(sensitiveClauses('"fields[0]=email&filters[blocked][$ne]=true"')).toEqual([]);
  });

  it("finds only the allowlisted e-mail clause, and no `_q`", () => {
    const offending: string[] = [];
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      const rel = relative(WEB_SRC, file).split("\\").join("/");
      for (const clause of sensitiveClauses(source)) {
        if (!ALLOWED.has(`${rel} ${clause}`)) offending.push(`${rel}: ${clause}`);
      }
      if (/[?&"'`]_q=/.test(source)) offending.push(`${rel}: _q`);
    }
    expect(offending).toEqual([]);
  });

  it("the allowlist names files that exist", () => {
    for (const entry of ALLOWED) {
      expect(existsSync(join(WEB_SRC, entry.split(" ")[0])), entry).toBe(true);
    }
    expect(dirname(WEB_SRC)).toBe(join(ROOT, "apps", "web"));
  });
});
