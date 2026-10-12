import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The README permission tables (roadmap S05, DO03) against the grants the
 * cms bootstrap writes. README.md "Roles and permissions" states, per role,
 * the content-type CRUD grants of PERMISSION_MATRIX and the custom-action
 * and plugin grants of CUSTOM_ACTION_GRANTS plus the user reads every role
 * gets (USER_READ_ACTIONS), all in apps/cms/src/bootstrap/permission-matrix.ts.
 * Change a grant there and this file fails until the README says the same,
 * in the same commit.
 *
 * Each table sits between `<!-- <name>:start -->` and `<!-- <name>:end -->`
 * markers; the first row is the header, the second the delimiter row. The
 * paragraph right before the start marker is the table's legend.
 *
 *   - permission-matrix: one row per CONTENT_TYPES entry, labelled by its
 *     API name (`api::<name>.<name>`), one column per matrix role in matrix
 *     order. A cell is the grant in CRUD_LETTERS order (C R U D), `—` for
 *     none; a lone find or findOne has no letter and would be spelt out
 *     (`find`), so the table can never round it up to R. The legend is
 *     built from the same CRUD_LETTERS, so the letters cannot change
 *     meaning in the README alone.
 *   - custom-action-grants: one row per action uid, its Endpoint (method and
 *     path as a client calls it), the same role columns, `✓` or `—`. The
 *     Endpoint is compared with the route that serves the action: the cms's
 *     own route files for api:: actions, the installed plugin's route
 *     definitions for plugin:: actions.
 *
 * Together the two tables must name exactly the (role, action) set the
 * boot sync converges to (computeDesiredGrants): no grant the README hides,
 * none it invents.
 *
 * The cms modules are loaded at run time, typed by the facades below, like
 * infra/contracts.test.ts does: this file is type-checked by the strict
 * web/infra program (tsconfig.test.json), which must not pull the cms
 * import graph in.
 */

const ROOT = join(__dirname, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8").replace(/\r\n/g, "\n");
const CMS_DIR = join(ROOT, "apps", "cms");

type Grants = Readonly<Record<string, Readonly<Partial<Record<string, readonly string[]>>>>>;

interface PermissionMatrixModule {
  CONTENT_TYPES: readonly string[];
  PERMISSION_MATRIX: Grants;
  CUSTOM_ACTION_GRANTS: Readonly<Record<string, readonly string[] | "*">>;
  USER_READ_ACTIONS: readonly string[];
  USER_UID: string;
  computeDesiredGrants(): { role: string; action: string }[];
}

const {
  CONTENT_TYPES,
  PERMISSION_MATRIX,
  CUSTOM_ACTION_GRANTS,
  USER_READ_ACTIONS,
  USER_UID,
  computeDesiredGrants,
} = (await import(
  join(CMS_DIR, "src", "bootstrap", "permission-matrix.ts")
)) as PermissionMatrixModule;

const MATRIX_ROLES = Object.keys(PERMISSION_MATRIX);
const NONE = "—";
const GRANTED = "✓";

/** The README's grant letters, in cell order, and the actions each stands for. */
const CRUD_LETTERS: readonly { letter: string; actions: readonly string[] }[] = [
  { letter: "C", actions: ["create"] },
  { letter: "R", actions: ["find", "findOne"] },
  { letter: "U", actions: ["update"] },
  { letter: "D", actions: ["delete"] },
];

/** The legends the README must print before each table, built from the notation above. */
const MATRIX_LEGEND =
  "Content types: " +
  CRUD_LETTERS.map(({ letter, actions }) => `\`${letter}\` = ${actions.join(" + ")}`).join(", ") +
  `, \`${NONE}\` = no grant.`;
const CUSTOM_LEGEND = `Custom actions and plugin routes (\`${GRANTED}\` = granted, \`${NONE}\` = not granted):`;

interface Table {
  header: string[];
  rows: string[][];
  /** The paragraph right before the start marker, whitespace collapsed. */
  legend: string;
}

/** Strip the inline-code backticks a cell may carry. */
const plain = (cell: string): string => cell.replace(/`/g, "").trim();

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** The Markdown table between the two markers of `name`. */
function readmeTable(name: string): Table {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const from = README.indexOf(start);
  const to = README.indexOf(end);
  if (from < 0 || to < from) {
    throw new Error(`README.md has no ${start} … ${end} block`);
  }
  const lines = README.slice(from + start.length, to)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  const [header, delimiter, ...rows] = lines.map(splitRow);
  if (!header || !delimiter || !delimiter.every((cell) => /^:?-+:?$/.test(cell))) {
    throw new Error(`README.md ${name}: expected a header and a delimiter row`);
  }
  for (const row of rows) {
    if (row.length !== header.length) {
      throw new Error(
        `README.md ${name}: row "${row[0]}" has ${row.length} cells, not ${header.length}`,
      );
    }
  }
  const legend = (
    README.slice(0, from)
      .trimEnd()
      .split(/\n\s*\n/)
      .pop() ?? ""
  )
    .replace(/\s+/g, " ")
    .trim();
  return { header: header.map(plain), rows, legend };
}

/** The README notation of one content type's actions for one role. */
function crudCell(actions: readonly string[] | undefined): string {
  const granted = new Set(actions ?? []);
  const covered = new Set<string>();
  let letters = "";
  for (const { letter, actions: meant } of CRUD_LETTERS) {
    if (meant.every((action) => granted.has(action))) {
      letters += letter;
      for (const action of meant) covered.add(action);
    }
  }
  // Anything the letters cannot express is spelt out, so it never matches.
  const rest = [...granted].filter((action) => !covered.has(action)).sort();
  const cell = [letters, ...rest].filter(Boolean).join("+");
  return cell || NONE;
}

/** The actions a README cell states, read back through the same letters. */
function cellActions(cell: string): string[] {
  if (cell === NONE) return [];
  return CRUD_LETTERS.filter(({ letter }) => cell.includes(letter)).flatMap(({ actions }) => [
    ...actions,
  ]);
}

/** api::<name>.<name> → <name>; anything else is not a README row label. */
function apiName(uid: string): string {
  const match = /^api::([a-z-]+)\.([a-z-]+)$/.exec(uid);
  if (!match || match[1] !== match[2]) throw new Error(`unexpected content type uid ${uid}`);
  return match[1];
}

// ---------------------------------------------------------------------------
// Endpoints: what serves each custom action, as a client calls it.
// ---------------------------------------------------------------------------

interface RouteDef {
  method: string;
  path: string;
  handler: string;
  config?: { prefix?: string };
}

/**
 * "<METHOD> <path>" as a client calls a content-API route: `/api`, then the
 * route's own `config.prefix` if it has one, else its router's prefix (none
 * for the cms's APIs, `/<plugin name>` for a plugin), then the route's path
 * (@strapi/core 5.55.1 services/server/register-routes.js and routing.js:
 * a route with `config.prefix` is mounted on the parent router). A trailing
 * slash is dropped, as the router matches without it (`POST /api/upload`).
 */
function endpoint(route: RouteDef, routerPrefix: string): string {
  const prefix = route.config?.prefix ?? routerPrefix;
  const path = `/api${prefix}${route.path}`.replace(/(.)\/+$/, "$1");
  return `${route.method.toUpperCase()} ${path}`;
}

const addEndpoint = (map: Map<string, string[]>, action: string, value: string) =>
  map.set(action, [...(map.get(action) ?? []), value]);

/**
 * The custom routes of the cms's own APIs (apps/cms/src/api/<api>/routes),
 * by handler, which is the action uid. Core router files
 * (createCoreRouter) serve the CRUD actions of the matrix table and are
 * skipped: importing them would load @strapi/strapi.
 */
async function apiEndpoints(): Promise<Map<string, string[]>> {
  const endpoints = new Map<string, string[]>();
  const apiDir = join(CMS_DIR, "src", "api");
  for (const api of readdirSync(apiDir)) {
    const routesDir = join(apiDir, api, "routes");
    if (!existsSync(routesDir)) continue;
    for (const file of readdirSync(routesDir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const source = readFileSync(join(routesDir, file), "utf8");
      if (source.includes("createCoreRouter")) continue;
      const mod = (await import(join(routesDir, file))) as { default: { routes: RouteDef[] } };
      for (const route of mod.default.routes) {
        addEndpoint(endpoints, route.handler, endpoint(route, ""));
      }
    }
  }
  return endpoints;
}

const requireFromCms = createRequire(join(CMS_DIR, "package.json"));
const requireFromStrapi = createRequire(requireFromCms.resolve("@strapi/strapi/package.json"));

/** The content-API route files of the installed plugins the README names. */
const PLUGIN_ROUTE_FILES: Record<string, string[]> = (() => {
  const usersPermissions = join(
    dirname(requireFromCms.resolve("@strapi/plugin-users-permissions/package.json")),
    "dist",
    "server",
    "routes",
    "content-api",
  );
  const upload = dirname(requireFromStrapi.resolve("@strapi/upload/package.json"));
  return {
    "users-permissions": ["auth.js", "user.js", "role.js", "permissions.js"].map((file) =>
      join(usersPermissions, file),
    ),
    upload: [join(upload, "dist", "server", "routes", "content-api.js")],
  };
})();

/**
 * A plugin route definition in the installed dist: method, path and handler
 * in this order, and optionally a `config` block with a `prefix`. Read from
 * the source text because the route factories need a running Strapi; a
 * format change after an upgrade finds no routes and fails below.
 */
const PLUGIN_ROUTE_RE =
  /method:\s*'([A-Z]+)',\s*path:\s*'([^']*)',\s*handler:\s*'([^']+)'(?:,\s*config:\s*\{[^{}]*?\bprefix:\s*'([^']*)')?/g;

function pluginEndpoints(): Map<string, string[]> {
  const endpoints = new Map<string, string[]>();
  for (const [plugin, files] of Object.entries(PLUGIN_ROUTE_FILES)) {
    let found = 0;
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(PLUGIN_ROUTE_RE)) {
        const [, method, path, handler, prefix] = match;
        const route: RouteDef = {
          method,
          path,
          handler,
          config: prefix === undefined ? undefined : { prefix },
        };
        addEndpoint(endpoints, `plugin::${plugin}.${handler}`, endpoint(route, `/${plugin}`));
        found++;
      }
    }
    if (found === 0) throw new Error(`no route definitions found for plugin ${plugin}: ${files}`);
  }
  return endpoints;
}

const matrixTable = readmeTable("permission-matrix");
const customTable = readmeTable("custom-action-grants");

/** Role columns of a table: every header cell after the `leading` ones. */
const roleColumns = (table: Table, leading: number): string[] => table.header.slice(leading);

describe("README permission matrix = PERMISSION_MATRIX", () => {
  it("prints the legend of its letters", () => {
    expect(matrixTable.legend).toBe(MATRIX_LEGEND);
  });

  it("has one column per matrix role, in matrix order", () => {
    expect(matrixTable.header[0]).toBe("Content type");
    expect(roleColumns(matrixTable, 1)).toEqual(MATRIX_ROLES);
  });

  it("has one row per content type of the matrix, and no other", () => {
    const labels = matrixTable.rows.map((row) => plain(row[0]));
    expect([...labels].sort()).toEqual(CONTENT_TYPES.map(apiName).sort());
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("states every role's grants on every content type", () => {
    const readme: Record<string, Record<string, string>> = {};
    for (const row of matrixTable.rows) {
      const cells: Record<string, string> = {};
      MATRIX_ROLES.forEach((role, index) => {
        cells[role] = row[index + 1];
      });
      readme[plain(row[0])] = cells;
    }

    const code: Record<string, Record<string, string>> = {};
    for (const uid of CONTENT_TYPES) {
      const cells: Record<string, string> = {};
      for (const role of MATRIX_ROLES) cells[role] = crudCell(PERMISSION_MATRIX[role]?.[uid]);
      code[apiName(uid)] = cells;
    }

    expect(readme).toEqual(code);
  });
});

describe("README custom actions = CUSTOM_ACTION_GRANTS + the user reads", () => {
  it("prints the legend of its marks", () => {
    expect(customTable.legend).toBe(CUSTOM_LEGEND);
  });

  it("has the action and endpoint columns, then one column per matrix role", () => {
    expect(customTable.header.slice(0, 2)).toEqual(["Action", "Endpoint"]);
    expect(roleColumns(customTable, 2)).toEqual(MATRIX_ROLES);
  });

  it("marks every cell as granted or not", () => {
    const odd = customTable.rows.flatMap((row) =>
      row
        .slice(2)
        .filter((cell) => cell !== GRANTED && cell !== NONE)
        .map((cell) => `${plain(row[0])}: ${cell}`),
    );
    expect(odd).toEqual([]);
  });

  it("lists exactly the granted roles of every custom action and user read", () => {
    const readme: Record<string, string[]> = {};
    for (const row of customTable.rows) {
      const action = plain(row[0]);
      expect(readme, `${action} is listed twice`).not.toHaveProperty([action]);
      readme[action] = MATRIX_ROLES.filter((_role, index) => row[index + 2] === GRANTED);
    }

    const code: Record<string, string[]> = {};
    for (const [action, grant] of Object.entries(CUSTOM_ACTION_GRANTS)) {
      code[action] =
        grant === "*" ? [...MATRIX_ROLES] : MATRIX_ROLES.filter((role) => grant.includes(role));
    }
    for (const action of USER_READ_ACTIONS) code[`${USER_UID}.${action}`] = [...MATRIX_ROLES];

    expect(readme).toEqual(code);
  });

  it("names, for every action, the method and path of the one route that serves it", async () => {
    const served = new Map([...(await apiEndpoints()), ...pluginEndpoints()]);
    const readme: Record<string, string[]> = {};
    const code: Record<string, string[]> = {};
    for (const row of customTable.rows) {
      const action = plain(row[0]);
      readme[action] = [plain(row[1])];
      code[action] = served.get(action) ?? [];
    }
    expect(readme).toEqual(code);
  });
});

describe("README permission tables = what the boot sync converges to", () => {
  it("names exactly the (role, action) pairs of computeDesiredGrants()", () => {
    const pairs = new Set<string>();
    for (const row of matrixTable.rows) {
      const uid = `api::${plain(row[0])}.${plain(row[0])}`;
      MATRIX_ROLES.forEach((role, index) => {
        for (const action of cellActions(row[index + 1])) pairs.add(`${role} ${uid}.${action}`);
      });
    }
    for (const row of customTable.rows) {
      MATRIX_ROLES.forEach((role, index) => {
        if (row[index + 2] === GRANTED) pairs.add(`${role} ${plain(row[0])}`);
      });
    }

    const desired = computeDesiredGrants().map(({ role, action }) => `${role} ${action}`);
    expect([...pairs].sort()).toEqual([...new Set(desired)].sort());
  });
});
