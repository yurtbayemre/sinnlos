/**
 * Entry ids from a request (route param, query or body), checked before they
 * reach a query.
 *
 * Postgres answers a lookup on an int4 `id` column with a malformed value
 * ("abc", "1.5", "2147483648") with an error ("invalid input syntax for type
 * integer", "value out of range for type integer"), not with an empty
 * result, and Strapi turns that into a 500 plus an error in the cms log.
 * SQLite simply finds nothing, so only Postgres shows it. A value these
 * checks refuse must never reach the query: the caller answers it like an
 * unknown entry (404, or `false` in a policy) or, for a body field, with 400.
 *
 * Accepted forms:
 *  - a row id: a positive integer within the int4 range, as a number or as
 *    a canonical decimal string (no sign, leading zero, fraction, exponent
 *    or whitespace);
 *  - a documentId in the shape Strapi 5 generates: @paralleldrive/cuid2
 *    createId() with its default length, i.e. a lowercase letter followed by
 *    23 lowercase letters or digits. The v4 -> v5 migration mints them the
 *    same way. Unlike the row id of a draft & publish entry, it stays the
 *    same across publishes.
 *
 * No imports and no process access, so the file runs in the cms and in the
 * web's server code alike: the web's ICS route refuses exactly the ids the
 * cms handler refuses, before it calls the cms. apps/cms/src/utils/entry-id.ts
 * and apps/web/src/lib/entry-id.ts re-export it (SH01); the Postgres 16 proof
 * of the accepted range stays in the cms (entry-id.pg.test.ts).
 */

/** Largest value of an int4 `id` column (Postgres `integer`). */
export const MAX_ROW_ID = 2147483647;

const ROW_ID_RE = /^[1-9][0-9]{0,9}$/;
const DOCUMENT_ID_RE = /^[a-z][a-z0-9]{23}$/;

/** An entry addressed by its row id or by its documentId. */
export type EntryRef = { id: number } | { documentId: string };

/** A positive integer an int4 `id` column can hold. */
export function isRowId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_ROW_ID;
}

/** The row id in `value` (number or canonical decimal string), else null. */
export function parseRowId(value: unknown): number | null {
  if (typeof value === "number") return isRowId(value) ? value : null;
  if (typeof value !== "string" || !ROW_ID_RE.test(value)) return null;
  const id = Number(value);
  return id <= MAX_ROW_ID ? id : null;
}

/** A documentId in the shape Strapi 5 generates. */
export function isDocumentId(value: unknown): value is string {
  return typeof value === "string" && DOCUMENT_ID_RE.test(value);
}

/**
 * The `where` for an entry addressed by a row id or a documentId, or null
 * when `value` is neither (missing, empty, malformed, out of range).
 */
export function parseEntryRef(value: unknown): EntryRef | null {
  const id = parseRowId(value);
  if (id !== null) return { id };
  return isDocumentId(value) ? { documentId: value } : null;
}
