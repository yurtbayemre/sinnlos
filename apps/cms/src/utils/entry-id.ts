/**
 * Entry ids from a request (route param, query or body), checked before they
 * reach a query: a row id within the int4 range or a documentId in the shape
 * Strapi 5 generates. Postgres answers a malformed or out-of-range int4
 * lookup with an error (a 500), not with an empty result, so a value these
 * checks refuse never reaches the query: the caller answers it like an
 * unknown entry (404, or `false` in a policy) or, for a body field, with 400.
 *
 * The rules live in @sinnlos/domain (SH01, packages/domain/src/entry-id.ts),
 * shared with the web's ICS route; entry-id.pg.test.ts proves them against
 * Postgres 16.
 */
export {
  MAX_ROW_ID,
  isDocumentId,
  isRowId,
  parseEntryRef,
  parseRowId,
  type EntryRef,
} from "@sinnlos/domain";
