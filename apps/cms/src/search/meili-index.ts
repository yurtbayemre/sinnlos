import { createHash } from "node:crypto";
import type { Core } from "@strapi/strapi";
import {
  INDEXED_SEARCH_KINDS,
  SEARCH_BUILD_INDEX_UID,
  SEARCH_INDEX_SETTINGS,
  SEARCH_INDEX_UID,
  meilisearchEnabled,
  type IndexedSearchKind,
  type SearchIndexDocument,
} from "@sinnlos/domain";

/**
 * The Meilisearch index of the optional search backend (v0.21, deep-dive
 * plan-meilisearch.md, owner decisions 2026-10-21). The index only ranks:
 * the web fetches every candidate through the Strapi read policies with the
 * user's JWT, so it holds published content and no access rules, and a
 * stale entry can never show anyone what they may not read.
 *
 * Kept current by the `search-index` cron (every minute, only registered
 * with MEILISEARCH_ENABLED=1): a fingerprint of the published content
 * (searchFingerprint); when it changed, or the live index is missing, the
 * whole index is rebuilt into SEARCH_BUILD_INDEX_UID and swapped in. One
 * mechanism covers edits, publish/unpublish, deletes, the scheduler, raw
 * updateMany, cascades and database restores.
 * shortcut: changes are findable within about a minute; add after-commit
 * upserts in the Document Service chain if that is ever too slow.
 * Plain fetch against Meilisearch's HTTP API, no SDK.
 */

export type SearchStrapi = Pick<Core.Strapi, "db" | "log">;
type Fetch = typeof fetch;

interface Source {
  uid: string;
  title: string;
  text: readonly string[];
}

/** Where each kind comes from: the fields the live search matched before v0.21, plus a few. */
const SOURCES: Readonly<Record<IndexedSearchKind, Source>> = {
  announcement: { uid: "api::announcement.announcement", title: "title", text: ["body"] },
  "wiki-page": { uid: "api::wiki-page.wiki-page", title: "title", text: ["summary", "body"] },
  document: { uid: "api::document.document", title: "title", text: ["description"] },
  event: { uid: "api::event.event", title: "title", text: ["description", "location"] },
  poll: { uid: "api::poll.poll", title: "question", text: [] },
};

// Generous: a timed-out wait would restart the rebuild from scratch; the cron's
// overlap guard skips the minutes a long rebuild takes.
const TASK_TIMEOUT_MS = 10 * 60_000;
const PUBLISHED = { publishedAt: { $notNull: true } };

export class SearchConfigError extends Error {}

export interface MeiliConfig {
  url: string;
  key: string;
}

/**
 * The cms side of the switch. Off (null) unless MEILISEARCH_ENABLED=1; on,
 * MEILISEARCH_URL and MEILISEARCH_WRITE_KEY are required, otherwise the
 * boot is refused (register()), naming only the variables.
 */
export function parseMeiliConfig(env: Record<string, string | undefined>): MeiliConfig | null {
  if (!meilisearchEnabled(env)) return null;
  const url = env.MEILISEARCH_URL?.trim() ?? "";
  const key = env.MEILISEARCH_WRITE_KEY?.trim() ?? "";
  const missing = [!url && "MEILISEARCH_URL", !key && "MEILISEARCH_WRITE_KEY"].filter(Boolean);
  if (missing.length) {
    throw new SearchConfigError(`[search] MEILISEARCH_ENABLED=1 needs ${missing.join(" and ")}`);
  }
  if (!/^https?:\/\/[^/]+/.test(url)) {
    throw new SearchConfigError("[search] MEILISEARCH_URL must be an http(s) URL");
  }
  return { url: url.replace(/\/+$/, ""), key };
}

/** bootstrap(): one status line, without the key. */
export function searchStatusLine(config: MeiliConfig | null): string {
  return config
    ? `[search] meilisearch enabled url=${new URL(config.url).origin}`
    : "[search] meilisearch disabled";
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** One published row as an index document; null without a documentId or any text. */
export function toSearchDocument(
  kind: IndexedSearchKind,
  row: Record<string, unknown>,
): SearchIndexDocument | null {
  const source = SOURCES[kind];
  const documentId = text(row.documentId);
  const title = text(row[source.title]);
  if (!documentId || !title) return null;
  return {
    id: `${kind}_${documentId}`,
    kind,
    documentId,
    title,
    text: source.text
      .map((field) => text(row[field]))
      .filter(Boolean)
      .join("\n\n"),
  };
}

/** Every published row of every indexed kind as index documents. */
export async function loadSearchDocuments(strapi: SearchStrapi): Promise<SearchIndexDocument[]> {
  const documents: SearchIndexDocument[] = [];
  for (const kind of INDEXED_SEARCH_KINDS) {
    const { uid, title, text: fields } = SOURCES[kind];
    const rows = await strapi.db.query(uid).findMany({
      where: PUBLISHED,
      select: ["documentId", title, ...fields],
    });
    for (const row of rows as Record<string, unknown>[]) {
      const document = toSearchDocument(kind, row);
      if (document) documents.push(document);
    }
  }
  // A stable order: the fingerprint must not change with the database's row order.
  return documents.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * A fingerprint of exactly what the index holds: it changes with every
 * published change and with nothing else (a draft save, a republish that
 * keeps the draft's updatedAt, a raw write all count only by their effect).
 * shortcut: reads every published row each minute; at many thousand rows,
 * compare per-type counts and publishedAt first.
 */
export function searchFingerprint(documents: readonly SearchIndexDocument[]): string {
  return createHash("sha256").update(JSON.stringify(documents)).digest("hex");
}

/** One Meilisearch call; null for a 404 when `allowMissing`, otherwise any non-2xx throws. */
async function meili(
  config: MeiliConfig,
  fetchImpl: Fetch,
  method: string,
  path: string,
  body?: unknown,
  allowMissing = false,
): Promise<Record<string, unknown> | null> {
  const res = await fetchImpl(`${config.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (allowMissing && res.status === 404) return null;
  if (!res.ok) throw new Error(`[search] ${method} ${path} answered ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Waits for an enqueued Meilisearch task; a failed or slow task throws,
 * except a failure with the code `tolerate` (deleting an index that is not
 * there is accepted with 202 and fails later with index_not_found).
 */
async function settle(
  config: MeiliConfig,
  fetchImpl: Fetch,
  enqueued: Record<string, unknown> | null,
  sleep: (ms: number) => Promise<void>,
  tolerate?: string,
): Promise<void> {
  const taskUid = enqueued?.taskUid;
  if (typeof taskUid !== "number") return;
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  for (;;) {
    const task = await meili(config, fetchImpl, "GET", `/tasks/${taskUid}`);
    if (task?.status === "succeeded") return;
    if (task?.status === "failed" || task?.status === "canceled") {
      const error = (task.error as { code?: string } | undefined)?.code ?? task.status;
      if (error === tolerate) return;
      throw new Error(`[search] task ${taskUid} ${String(error)}`);
    }
    if (Date.now() > deadline) throw new Error(`[search] task ${taskUid} did not finish`);
    await sleep(100);
  }
}

/** Fills the build index with `documents` and swaps it in; returns the document count. */
export async function rebuildSearchIndex(
  documents: readonly SearchIndexDocument[],
  config: MeiliConfig,
  fetchImpl: Fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<number> {
  const call = (method: string, path: string, body?: unknown, allowMissing = false) =>
    meili(config, fetchImpl, method, path, body, allowMissing);
  const run = async (method: string, path: string, body?: unknown) =>
    settle(config, fetchImpl, await call(method, path, body), sleep);
  const dropBuild = async () =>
    settle(
      config,
      fetchImpl,
      await call("DELETE", `/indexes/${SEARCH_BUILD_INDEX_UID}`, undefined, true),
      sleep,
      "index_not_found",
    );

  await dropBuild();
  await run("POST", "/indexes", { uid: SEARCH_BUILD_INDEX_UID, primaryKey: "id" });
  await run("PATCH", `/indexes/${SEARCH_BUILD_INDEX_UID}/settings`, SEARCH_INDEX_SETTINGS);
  if (documents.length)
    await run("POST", `/indexes/${SEARCH_BUILD_INDEX_UID}/documents`, documents);
  // A swap needs both indexes: the very first rebuild creates an empty live one.
  if (!(await call("GET", `/indexes/${SEARCH_INDEX_UID}`, undefined, true))) {
    await run("POST", "/indexes", { uid: SEARCH_INDEX_UID, primaryKey: "id" });
  }
  await run("POST", "/swap-indexes", [{ indexes: [SEARCH_INDEX_UID, SEARCH_BUILD_INDEX_UID] }]);
  await dropBuild();
  return documents.length;
}

/** The fingerprint of the last successful rebuild in this process. */
export interface SyncState {
  signature: string | null;
}

const processState: SyncState = { signature: null };

/**
 * The cron task: rebuild when the content changed since the last rebuild of
 * this process (the first run always rebuilds) or the live index is gone.
 */
export async function syncSearchIndex(
  strapi: SearchStrapi,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: Fetch = fetch,
  state: SyncState = processState,
): Promise<void> {
  const config = parseMeiliConfig(env);
  if (!config) return;
  const documents = await loadSearchDocuments(strapi);
  const signature = searchFingerprint(documents);
  const live = await meili(
    config,
    fetchImpl,
    "GET",
    `/indexes/${SEARCH_INDEX_UID}`,
    undefined,
    true,
  );
  if (live && signature === state.signature) return;
  const count = await rebuildSearchIndex(documents, config, fetchImpl);
  state.signature = signature;
  strapi.log.info(`[search] index rebuilt: ${count} document(s)`);
}
