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

/**
 * The index settings. German segmentation for every field: it splits
 * compound words ("Antrag" finds "Urlaubsantrag", "Stapler" finds
 * "Gabelstapler"), and English still matches; measured on a German corpus
 * 2026-10-21 (deep-dive plan-meilisearch.md: 23 of 25 against 17 with the
 * automatic language detection). "Mueller" for "Müller" and "Strasse" for a
 * compound with "straße" stay unfound.
 */
export const SEARCH_INDEX_SETTINGS = {
  searchableAttributes: ["title", "text"],
  filterableAttributes: ["kind"],
  localizedAttributes: [{ attributePatterns: ["*"], locales: ["deu"] }],
};

/**
 * The multi-search the web sends: one query per indexed kind, the ranked
 * documentIds only. Meilisearch's default matching strategy ("last") drops
 * trailing words when all of them match nothing, so "Führerschein Stapler"
 * still finds the forklift licence.
 */
export function searchIndexQueries(term: string, limit: number) {
  return INDEXED_SEARCH_KINDS.map((kind) => ({
    indexUid: SEARCH_INDEX_UID,
    q: term,
    filter: `kind = "${kind}"`,
    limit,
    attributesToRetrieve: ["documentId"],
  }));
}

/** Whether the env switches Meilisearch on: exactly "1", anything else is off. */
export function meilisearchEnabled(env: Record<string, string | undefined>): boolean {
  return env.MEILISEARCH_ENABLED === "1";
}
