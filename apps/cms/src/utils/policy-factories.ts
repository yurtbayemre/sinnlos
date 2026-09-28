import { parseEntryRef } from "./entry-id";

/**
 * Lookup primitives the ownership gates and the id-addressed controllers
 * share (PL01).
 */

/** The slice of `strapi` a lookup reads (a db.query, nothing else). */
export interface PolicyDb {
  db: {
    query(uid: string): {
      findOne(params: object): Promise<unknown>;
      findMany(params: object): Promise<unknown>;
    };
  };
}

/** A row as the query engine returns it: always an id and a documentId. */
export interface EntryRow {
  id: number;
  documentId: string;
  [field: string]: unknown;
}

export interface FindByRefOptions {
  /** Columns to read besides id and documentId (default: all, like findOne). */
  select?: readonly string[];
  /** Relations to populate, as the query engine takes them. */
  populate?: Record<string, unknown>;
}

const isEntryRow = (row: unknown): row is EntryRow =>
  typeof row === "object" &&
  row !== null &&
  typeof (row as { id?: unknown }).id === "number" &&
  typeof (row as { documentId?: unknown }).documentId === "string";

/**
 * The row an id from the request names, or null (PL01).
 *
 * `idParam` is a route `:id` (or any id a client sent): a row id or a
 * documentId, checked by parseEntryRef BEFORE any query, so a malformed
 * value never reaches Postgres (utils/entry-id.ts: an int4 `id` lookup with
 * "abc" or "2147483648" was a 500). null means "no such entry" for every
 * reason alike (missing, malformed, out of range, not found), so the
 * caller answers them the same way: 404 in a controller, false in a policy.
 *
 * The id-addressed core routes resolve documentIds only; a controller that
 * accepts a numeric id translates it with the row's documentId before it
 * calls super (the v5 core delete answered 204 and deleted nothing for a
 * numeric id):
 *
 *   const entity = await findByRef(strapi, UID, ctx.params.id);
 *   if (!entity) return ctx.notFound();
 *   ctx.params.id = entity.documentId;
 *
 * Reads through strapi.db.query: no permission gating, draft and published
 * rows alike (the types behind these routes have no draft & publish).
 */
export async function findByRef<T extends EntryRow = EntryRow>(
  strapi: PolicyDb,
  uid: string,
  idParam: unknown,
  options: FindByRefOptions = {},
): Promise<T | null> {
  const where = parseEntryRef(idParam);
  if (!where) return null;
  const row = await strapi.db.query(uid).findOne({
    where,
    ...(options.select ? { select: [...new Set(["id", "documentId", ...options.select])] } : {}),
    ...(options.populate ? { populate: options.populate } : {}),
  });
  return isEntryRow(row) ? (row as T) : null;
}
