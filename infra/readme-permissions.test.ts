import { readFileSync } from "node:fs";
import { join } from "node:path";
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
 * markers; the first row is the header, the second the delimiter row.
 *
 *   - permission-matrix: one row per CONTENT_TYPES entry, labelled by its
 *     API name (`api::<name>.<name>`), one column per matrix role in matrix
 *     order. A cell is the grant in the order C R U D: C = create,
 *     R = find + findOne, U = update, D = delete, `—` = none. A lone find
 *     or findOne has no letter; it would be spelt out (`find`), so the
 *     table can never round it up to R.
 *   - custom-action-grants: one row per action uid (an Endpoint column next
 *     to it is prose and not compared), the same role columns, `✓` or `—`.
 *
 * Together the two tables must name exactly the (role, action) set the
 * boot sync converges to (computeDesiredGrants): no grant the README hides,
 * none it invents.
 *
 * The cms module is loaded at run time, typed by the facade below, like
 * infra/contracts.test.ts does: this file is type-checked by the strict
 * web/infra program (tsconfig.test.json), which must not pull the cms
 * import graph in.
 */

const ROOT = join(__dirname, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8").replace(/\r\n/g, "\n");

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
  join(ROOT, "apps", "cms", "src", "bootstrap", "permission-matrix.ts")
)) as PermissionMatrixModule;

const MATRIX_ROLES = Object.keys(PERMISSION_MATRIX);
const NONE = "—";
const GRANTED = "✓";

interface Table {
  header: string[];
  rows: string[][];
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
  return { header: header.map(plain), rows };
}

/** The README notation of one content type's actions for one role. */
function crudCell(actions: readonly string[] | undefined): string {
  const granted = new Set(actions ?? []);
  const letters: string[] = [];
  if (granted.has("create")) letters.push("C");
  if (granted.has("find") && granted.has("findOne")) letters.push("R");
  if (granted.has("update")) letters.push("U");
  if (granted.has("delete")) letters.push("D");
  const known = new Set(["create", "update", "delete"]);
  if (granted.has("find") && granted.has("findOne")) {
    known.add("find");
    known.add("findOne");
  }
  // Anything the letters cannot express is spelt out, so it never matches.
  const rest = [...granted].filter((action) => !known.has(action)).sort();
  const cell = [letters.join(""), ...rest].filter(Boolean).join("+");
  return cell || NONE;
}

/** api::<name>.<name> → <name>; anything else is not a README row label. */
function apiName(uid: string): string {
  const match = /^api::([a-z-]+)\.([a-z-]+)$/.exec(uid);
  if (!match || match[1] !== match[2]) throw new Error(`unexpected content type uid ${uid}`);
  return match[1];
}

const matrixTable = readmeTable("permission-matrix");
const customTable = readmeTable("custom-action-grants");

/** Role columns of a table: every header cell after the `leading` ones. */
const roleColumns = (table: Table, leading: number): string[] => table.header.slice(leading);

describe("README permission matrix = PERMISSION_MATRIX", () => {
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
});

describe("README permission tables = what the boot sync converges to", () => {
  it("names exactly the (role, action) pairs of computeDesiredGrants()", () => {
    const pairs = new Set<string>();
    for (const row of matrixTable.rows) {
      const uid = `api::${plain(row[0])}.${plain(row[0])}`;
      MATRIX_ROLES.forEach((role, index) => {
        const cell = row[index + 1];
        if (cell === NONE) return;
        if (cell.includes("C")) pairs.add(`${role} ${uid}.create`);
        if (cell.includes("R")) {
          pairs.add(`${role} ${uid}.find`);
          pairs.add(`${role} ${uid}.findOne`);
        }
        if (cell.includes("U")) pairs.add(`${role} ${uid}.update`);
        if (cell.includes("D")) pairs.add(`${role} ${uid}.delete`);
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
