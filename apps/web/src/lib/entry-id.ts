/**
 * Entry ids from a request, checked before they reach the cms: the web's ICS
 * route refuses exactly the ids the cms handler refuses (a row id within the
 * int4 range or a documentId in the shape Strapi 5 generates).
 *
 * The rules live in @sinnlos/domain (SH01, packages/domain/src/entry-id.ts),
 * shared with the cms (apps/cms/src/utils/entry-id.ts).
 */
export {
  MAX_ROW_ID,
  isDocumentId,
  isRowId,
  parseEntryRef,
  parseRowId,
  type EntryRef,
} from "@sinnlos/domain";
