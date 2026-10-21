/**
 * The web side of the optional Meilisearch backend (v0.21, deep-dive
 * plan-meilisearch.md): ranked candidate documentIds per indexed kind, for
 * lib/search-action.ts to fetch through the Strapi read policies with the
 * user's JWT. Nothing from the index (text, links, totals) reaches the
 * browser. Off unless MEILISEARCH_ENABLED=1 with MEILISEARCH_URL and
 * MEILISEARCH_SEARCH_KEY (server-side env, never NEXT_PUBLIC). Any error or
 * timeout answers null, and the search falls back to the Strapi `$containsi`
 * path; after a failure Meilisearch is skipped for PAUSE_MS, so a dead
 * server does not add the timeout to every keystroke.
 */
import "server-only";
import {
  INDEXED_SEARCH_KINDS,
  SEARCH_INDEX_UID,
  meilisearchEnabled,
  type IndexedSearchKind,
} from "@sinnlos/domain";

/** Candidates per kind before the Strapi policies drop what the viewer may not read. */
export const MEILI_CANDIDATES = 50;
const TIMEOUT_MS = 400;
const PAUSE_MS = 30_000;

let pausedUntil = 0;

/** Tests reset the pause between cases. */
export function resetMeiliPause(): void {
  pausedUntil = 0;
}

function config(env: Record<string, string | undefined>): { url: string; key: string } | null {
  const url = env.MEILISEARCH_URL?.trim().replace(/\/+$/, "");
  const key = env.MEILISEARCH_SEARCH_KEY?.trim();
  return meilisearchEnabled(env) && url && key ? { url, key } : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Ranked documentIds per indexed kind for `term`, or null when Meilisearch
 * is off, paused, failing or answering something unexpected.
 */
export async function meiliCandidates(
  term: string,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Map<IndexedSearchKind, string[]> | null> {
  const meili = config(env);
  if (!meili || Date.now() < pausedUntil) return null;
  try {
    const res = await fetchImpl(`${meili.url}/multi-search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${meili.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        queries: INDEXED_SEARCH_KINDS.map((kind) => ({
          indexUid: SEARCH_INDEX_UID,
          q: term,
          filter: `kind = "${kind}"`,
          limit: MEILI_CANDIDATES,
          attributesToRetrieve: ["documentId"],
          matchingStrategy: "all",
        })),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`multi-search answered ${res.status}`);
    const body: unknown = await res.json();
    const results = isRecord(body) && Array.isArray(body.results) ? body.results : null;
    if (!results || results.length !== INDEXED_SEARCH_KINDS.length) {
      throw new Error("unexpected multi-search answer");
    }
    return new Map(
      INDEXED_SEARCH_KINDS.map((kind, i) => {
        const hits = isRecord(results[i]) && Array.isArray(results[i].hits) ? results[i].hits : [];
        const ids = hits
          .map((hit: unknown) => (isRecord(hit) ? hit.documentId : null))
          .filter((id: unknown): id is string => typeof id === "string" && id !== "");
        return [kind, ids];
      }),
    );
  } catch (e) {
    pausedUntil = Date.now() + PAUSE_MS;
    console.warn(
      `[search] meilisearch unavailable, using the Strapi search: ${(e as Error).message}`,
    );
    return null;
  }
}
