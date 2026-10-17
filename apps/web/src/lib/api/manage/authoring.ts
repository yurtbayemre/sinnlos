/**
 * The v2 authoring routes (deep-dive decision 06 §B3; batch 15 plan,
 * contract K7, frozen by lane 15A in @sinnlos/domain authoring/http.ts):
 * one typed request per intent, built from the domain route table, so the
 * web sends exactly the paths, methods and preconditions the cms routes
 * carry. Transport only (WD03): the pages read through
 * lib/loaders/manage/*, the forms write through lib/manage/*-actions.ts.
 *
 *   list     GET    /api/P/authoring?status=&q=&page=&owner=
 *   form     GET    /api/P/:documentId/editable
 *   create   POST   /api/P[?status=draft|published]            {data}
 *   update   PUT    /api/P/:documentId[?status=…]               {data}  If-Match
 *   publish, unpublish, discard-draft
 *            POST   /api/P/:documentId/<action>                        If-Match
 *   delete   DELETE /api/P/:documentId                                 If-Match
 *
 * `status` is sent on the create and update of the explicit types (a
 * missing one answers 400, K7) and never for polls, which always publish.
 * Every mutation but create carries `If-Match: "<version>"` with the
 * version the form last saw (428 without it, 412 when stale). Through
 * strapi(), so every request is no-store, carries the session's JWT and
 * redirects to sign-in on an expired one (D-DC01, WD01); the header goes
 * through the existing `headers` option (lib/strapi/client.ts is
 * unchanged).
 */
import {
  AUTHORING_LIST_MAX_QUERY,
  AUTHORING_STATUS_MODES,
  IF_MATCH_HEADER,
  authoringPath,
  authoringRoute,
  ifMatch,
  type AuthoringIntent,
  type AuthoringListResponse,
  type AuthoringListStatusFilter,
  type AuthoringOwnerFilter,
  type AuthoringType,
  type TrainingAuthoringType,
  type AuthoringWriteResponse,
  type AuthoringWriteStatus,
  type EditableBase,
  type EditableResponse,
} from "@sinnlos/domain";
import { strapi } from "@/lib/strapi/client";
import { strapiQuery, withQuery } from "@/lib/strapi/query";

/** The list filters of /manage/<area> (K7 §B3: status, q, page; owner for moderators). */
export interface AuthoringListQuery {
  status?: AuthoringListStatusFilter;
  q?: string;
  page?: number;
  owner?: AuthoringOwnerFilter;
  course?: string;
}

/** `GET /api/P/authoring`: one page of the area's list (25 rows, K7). */
export function fetchAuthoringList(
  type: AuthoringType | TrainingAuthoringType,
  query: AuthoringListQuery = {},
): Promise<AuthoringListResponse> {
  const qs = strapiQuery();
  if (query.status) qs.value("status", query.status);
  const q = query.q?.trim().slice(0, AUTHORING_LIST_MAX_QUERY);
  if (q) qs.value("q", q);
  if (query.page && query.page > 1) qs.value("page", query.page);
  if (query.owner && type !== "course" && type !== "lesson") qs.value("owner", query.owner);
  if (type === "lesson" && query.course) qs.value("course", query.course);
  return strapi<AuthoringListResponse>(withQuery(authoringPath(type, "authoringList"), qs));
}

/** `GET /api/P/:documentId/editable`: the draft in the write shape (K7). */
export function fetchEditable<T extends EditableBase>(
  type: AuthoringType | TrainingAuthoringType,
  documentId: string,
): Promise<EditableResponse<T>> {
  return strapi<EditableResponse<T>>(authoringPath(type, "editable", documentId));
}

/** The intents that write (everything but the two reads). */
export type AuthoringWriteIntent = Exclude<AuthoringIntent, "authoringList" | "editable">;

export interface AuthoringWriteRequest {
  /** Every intent but create. */
  documentId?: string;
  /** The version the form last saw; required for every intent but create. */
  version?: string;
  /** create and update of the explicit types. */
  status?: AuthoringWriteStatus;
  /** create and update. */
  data?: Record<string, unknown>;
}

/**
 * One authoring write. Resolves to the cms's answer: `{ data }` (the K7
 * DTO), or undefined for a 204 (delete; a discard that removed a document
 * without a published version). Throws strapi()'s StrapiError on a refusal,
 * which runCmsAction maps (AC01).
 */
export function sendAuthoringWrite(
  type: AuthoringType | TrainingAuthoringType,
  intent: AuthoringWriteIntent,
  request: AuthoringWriteRequest = {},
): Promise<AuthoringWriteResponse | undefined> {
  const route = authoringRoute(type, intent);
  let path = authoringPath(type, intent, request.documentId);
  if (
    (intent === "create" || intent === "update") &&
    (type === "course" || type === "lesson" || AUTHORING_STATUS_MODES[type] === "explicit")
  ) {
    if (!request.status) throw new Error(`[authoring] ${type} ${intent} needs a status`);
    path = withQuery(path, strapiQuery().value("status", request.status));
  }
  const headers: Record<string, string> = {};
  if (route.ifMatch) {
    if (!request.version) throw new Error(`[authoring] ${type} ${intent} needs a version`);
    headers[IF_MATCH_HEADER] = ifMatch(request.version);
  }
  const hasBody = intent === "create" || intent === "update";
  return strapi<AuthoringWriteResponse | undefined>(path, {
    method: route.method,
    headers,
    ...(hasBody ? { body: JSON.stringify({ data: request.data ?? {} }) } : {}),
  });
}
