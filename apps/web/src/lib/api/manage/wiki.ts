/**
 * The wiki's v2 authoring routes (deep-dive decision 06 §J1, §J2; batch 16
 * plan, lane 16B, contract K18, frozen in @sinnlos/domain
 * authoring/wiki.ts): one typed request per intent, built from the domain
 * route table, so the web sends exactly the paths, methods and
 * preconditions the cms routes carry. Transport only (WD03): the pages read
 * through lib/loaders/manage/wiki.ts, the forms write through
 * lib/manage/wiki-*-actions.ts.
 *
 *   spaces   GET /api/wiki-spaces/authoring?q=&page=          (moderators)
 *            GET /api/wiki-spaces/:id/editable
 *            POST /api/wiki-spaces {data}; PUT, DELETE /:id   If-Match
 *   pages    GET /api/wiki-pages/authoring?space=&status=&q=&page= (moderators)
 *            GET /api/wiki-pages/:id/editable, /drafts/mine,
 *                /:id/revisions?page=, /:id/revisions/:revisionId
 *            POST /api/wiki-pages?status= {data} (create), /drafts {data}
 *            PUT /:id?status= {data}, /:id/draft {data}         If-Match
 *            POST /:id/publish | discard-draft | unpublish      If-Match
 *            POST /:id/restore {revisionId}                     If-Match
 *            DELETE /:id                                        If-Match
 *
 * Spaces are always published (no `?status=`). Page creates and updates
 * on the generic routes always carry `?status=`: moderators choose draft or
 * published (`explicit`), the author classes are pinned to published by
 * the cms whatever they send and draft through createDraft and saveDraft.
 * Every mutation but a create carries `If-Match: "<version>"`. Through
 * strapi(), so every request is no-store, carries the session's JWT and
 * redirects to sign-in on an expired one (D-DC01, WD01).
 */
import {
  AUTHORING_LIST_MAX_QUERY,
  IF_MATCH_HEADER,
  ifMatch,
  wikiPageRoute,
  wikiRequestPath,
  wikiSpaceRoute,
  type AuthoringListStatusFilter,
  type AuthoringWriteStatus,
  type EditableResponse,
  type WikiMyDraftsResponse,
  type WikiPageEditable,
  type WikiPageIntent,
  type WikiPageListResponse,
  type WikiPageResult,
  type WikiRevisionDetail,
  type WikiRevisionListResponse,
  type WikiSpaceEditable,
  type WikiSpaceIntent,
  type WikiSpaceListResponse,
  type WikiSpaceResult,
} from "@sinnlos/domain";
import { strapi } from "@/lib/strapi/client";
import { strapiQuery, withQuery } from "@/lib/strapi/query";

/** `?q=` as the lists take it: trimmed and capped (an empty one is left out). */
function listQuery(q: string | undefined): string | null {
  const trimmed = q?.trim().slice(0, AUTHORING_LIST_MAX_QUERY);
  return trimmed ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Spaces (moderators)

export interface WikiSpaceListQuery {
  q?: string;
  page?: number;
}

/** `GET /api/wiki-spaces/authoring`: one page of spaces (25 rows). */
export function fetchWikiSpaceList(query: WikiSpaceListQuery = {}): Promise<WikiSpaceListResponse> {
  const qs = strapiQuery();
  const q = listQuery(query.q);
  if (q) qs.value("q", q);
  if (query.page && query.page > 1) qs.value("page", query.page);
  return strapi<WikiSpaceListResponse>(
    withQuery(wikiRequestPath(wikiSpaceRoute("authoringList")), qs),
  );
}

/** `GET /api/wiki-spaces/:documentId/editable`. */
export function fetchWikiSpaceEditable(
  documentId: string,
): Promise<EditableResponse<WikiSpaceEditable>> {
  return strapi<EditableResponse<WikiSpaceEditable>>(
    wikiRequestPath(wikiSpaceRoute("editable"), { documentId }),
  );
}

export type WikiSpaceWriteIntent = Extract<WikiSpaceIntent, "create" | "update" | "delete">;

export interface WikiWriteRequest {
  /** Every intent but the creates. */
  documentId?: string;
  /** The version the form last saw; every intent but the creates. */
  version?: string;
  /** create and update. */
  data?: Record<string, unknown>;
}

/** The headers of a write: `If-Match` where the route needs it. */
function writeHeaders(needsIfMatch: boolean, version: string | undefined, label: string) {
  const headers: Record<string, string> = {};
  if (needsIfMatch) {
    if (!version) throw new Error(`[wiki] ${label} needs a version`);
    headers[IF_MATCH_HEADER] = ifMatch(version);
  }
  return headers;
}

/**
 * One wiki-space write: `{ data }` (WikiSpaceResult), or undefined for the
 * delete's 204. Throws strapi()'s StrapiError on a refusal (AC01 maps it).
 */
export function sendWikiSpaceWrite(
  intent: WikiSpaceWriteIntent,
  request: WikiWriteRequest = {},
): Promise<{ data: WikiSpaceResult } | undefined> {
  const route = wikiSpaceRoute(intent);
  const headers = writeHeaders(route.ifMatch, request.version, `space ${intent}`);
  const hasBody = intent !== "delete";
  return strapi<{ data: WikiSpaceResult } | undefined>(
    wikiRequestPath(route, { documentId: request.documentId }),
    {
      method: route.method,
      headers,
      ...(hasBody ? { body: JSON.stringify({ data: request.data ?? {} }) } : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// Pages

export interface WikiPageListQuery {
  /** A space's documentId. */
  space?: string;
  status?: AuthoringListStatusFilter;
  q?: string;
  page?: number;
}

/** `GET /api/wiki-pages/authoring` (moderators): one page of 25 rows. */
export function fetchWikiPageList(query: WikiPageListQuery = {}): Promise<WikiPageListResponse> {
  const qs = strapiQuery();
  if (query.space) qs.value("space", query.space);
  if (query.status) qs.value("status", query.status);
  const q = listQuery(query.q);
  if (q) qs.value("q", q);
  if (query.page && query.page > 1) qs.value("page", query.page);
  return strapi<WikiPageListResponse>(
    withQuery(wikiRequestPath(wikiPageRoute("authoringList")), qs),
  );
}

/** `GET /api/wiki-pages/:documentId/editable` (the row classes and moderators). */
export function fetchWikiPageEditable(documentId: string): Promise<{ data: WikiPageEditable }> {
  return strapi<{ data: WikiPageEditable }>(
    wikiRequestPath(wikiPageRoute("editable"), { documentId }),
  );
}

/** `GET /api/wiki-pages/drafts/mine`: the caller's pages with unpublished changes. */
export function fetchMyWikiDrafts(): Promise<WikiMyDraftsResponse> {
  return strapi<WikiMyDraftsResponse>(wikiRequestPath(wikiPageRoute("myDrafts")));
}

/** `GET /api/wiki-pages/:documentId/revisions?page=`: the history, newest first. */
export function fetchWikiRevisions(
  documentId: string,
  page = 1,
): Promise<WikiRevisionListResponse> {
  const qs = strapiQuery();
  if (page > 1) qs.value("page", page);
  return strapi<WikiRevisionListResponse>(
    withQuery(wikiRequestPath(wikiPageRoute("revisions"), { documentId }), qs),
  );
}

/** `GET /api/wiki-pages/:documentId/revisions/:revisionId`: one revision with its content. */
export function fetchWikiRevision(
  documentId: string,
  revisionId: number,
): Promise<{ data: WikiRevisionDetail }> {
  return strapi<{ data: WikiRevisionDetail }>(
    wikiRequestPath(wikiPageRoute("revision"), { documentId, revisionId }),
  );
}

/** The page intents that write. */
export type WikiPageWriteIntent = Exclude<
  WikiPageIntent,
  "myDrafts" | "editable" | "authoringList" | "revisions" | "revision"
>;

export interface WikiPageWriteRequest extends WikiWriteRequest {
  /** The generic create and update (moderators choose; the author classes are pinned to published). */
  status?: AuthoringWriteStatus;
  /** restore: the revision to bring back. */
  revisionId?: number;
}

/** The intents that send `{ data }`. */
const DATA_INTENTS: readonly WikiPageWriteIntent[] = [
  "create",
  "update",
  "createDraft",
  "saveDraft",
];

/**
 * One wiki-page write: `{ data }` (WikiPageResult), or undefined for a 204
 * (delete; a discard that removed a never-published page). Throws
 * strapi()'s StrapiError on a refusal.
 */
export function sendWikiPageWrite(
  intent: WikiPageWriteIntent,
  request: WikiPageWriteRequest = {},
): Promise<{ data: WikiPageResult } | undefined> {
  const route = wikiPageRoute(intent);
  let path = wikiRequestPath(route, { documentId: request.documentId });
  if (intent === "create" || intent === "update") {
    if (!request.status) throw new Error(`[wiki] page ${intent} needs a status`);
    path = withQuery(path, strapiQuery().value("status", request.status));
  }
  const headers = writeHeaders(route.ifMatch, request.version, `page ${intent}`);
  let body: string | undefined;
  if (DATA_INTENTS.includes(intent)) body = JSON.stringify({ data: request.data ?? {} });
  if (intent === "restore") {
    if (!request.revisionId) throw new Error("[wiki] restore needs a revisionId");
    body = JSON.stringify({ revisionId: request.revisionId });
  }
  return strapi<{ data: WikiPageResult } | undefined>(path, {
    method: route.method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
}
