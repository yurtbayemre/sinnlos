/**
 * Meilisearch, the optional search backend (v0.21, deep-dive
 * plan-meilisearch.md): Meilisearch only ranks; the web fetches the ranked
 * candidates through the Strapi read policies with the user's JWT, so the
 * index holds no access rules. The cms builds the index, the web queries it;
 * both switch on with MEILISEARCH_ENABLED=1 exactly (like ENTRA_ENABLED).
 */

/** The live index the web searches. */
export const SEARCH_INDEX_UID = "sinnlos_search";

/** The index a rebuild fills before it is swapped with the live one. */
export const SEARCH_BUILD_INDEX_UID = "sinnlos_search_build";

/** The search kinds the index holds: the content kinds of the live search, not people. */
export const INDEXED_SEARCH_KINDS = [
  "announcement",
  "wiki-page",
  "document",
  "event",
  "poll",
] as const;

export type IndexedSearchKind = (typeof INDEXED_SEARCH_KINDS)[number];

/** One index document: published content only, never access fields or contact data. */
export interface SearchIndexDocument {
  /** `<kind>_<documentId>`: stable across re-publishes (the row id is not). */
  id: string;
  kind: IndexedSearchKind;
  documentId: string;
  title: string;
  text: string;
}

/** Whether the env switches Meilisearch on: exactly "1", anything else is off. */
export function meilisearchEnabled(env: Record<string, string | undefined>): boolean {
  return env.MEILISEARCH_ENABLED === "1";
}
