/**
 * Test support for the id checks of utils/entry-id.ts (EVT-ICS-ID class).
 * Named *.test.helper.ts so the Strapi build skips it (tsconfig excludes
 * **\/*.test.*) and Vitest does not collect it as a suite.
 */

/**
 * Route params that name no entry: none of them is a canonical row id within
 * int4 or a documentId in Strapi's shape. "abc", "1.5", "1e3", "2147483648"
 * and "99999999999999999999" make a Postgres lookup on the int4 `id` column
 * fail (entry-id.pg.test.ts), which Strapi answered with a 500.
 */
export const MALFORMED_ENTRY_IDS: readonly string[] = [
  "abc",
  "doc-1",
  "1.5",
  "1e3",
  "0",
  "01",
  "-1",
  " 1",
  "2147483648",
  "99999999999999999999",
  "K3V9Q2M8X7C4B1N6P5Z0R2T8",
];

/**
 * The numeric-looking subset: refused by every id check, including the
 * FX07 write policies, whose documentId rule is wider (targetRowWhere).
 */
export const MALFORMED_ROW_IDS: readonly string[] = [
  "1.5",
  "1e3",
  "0",
  "01",
  "-1",
  " 1",
  "2147483648",
  "99999999999999999999",
];

const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

/**
 * Throws the error Postgres raises when a `where.id` value cannot be read
 * as an int4 (22P02 invalid input syntax, 22003 out of range). A db.query
 * stub calls it, so a guard that lets such a value through fails the test
 * the way production failed, instead of quietly finding nothing.
 */
export function failLikePostgres(where: unknown): void {
  if (typeof where !== "object" || where === null || !("id" in where)) return;
  const id: unknown = (where as { id: unknown }).id;
  if (typeof id === "object" && id !== null) return; // operators such as $in
  const text = String(id).trim();
  if (!/^[+-]?\d+$/.test(text)) {
    throw Object.assign(new Error(`invalid input syntax for type integer: "${String(id)}"`), {
      code: "22P02",
    });
  }
  const value = Number(text);
  if (value < INT4_MIN || value > INT4_MAX) {
    throw Object.assign(new Error(`value "${text}" is out of range for type integer`), {
      code: "22003",
    });
  }
}
