import type { AuthoringRoute } from "./http.js";

/**
 * The wiki's v2 authoring contract (deep-dive decision 06 §B3, §J1, §J2;
 * batch 16 plan, lane 16B, contracts K18 and K21): which fields each class
 * writes, which route each intent takes and what it needs. The cms routes
 * carry exactly this table (apps/cms/src/utils/authoring-routes.test.ts
 * pins it); the web builds its wiki requests from it. The response shapes
 * are in dto.ts, the shared row-gate rule in ../wiki-edit.ts.
 *
 * WIKI SPACES (moderators only, through global::can-author). Like polls:
 * always published (no `?status=`, or `published`), so a space has no
 * publish, unpublish or discard route. Name, icon, description, visibility
 * and its target; the slug is derived from the name on create and fixed
 * afterwards. A space with pages is neither deleted (DELETE answers 400
 * `_form: spaceNotEmpty`) nor unpublished (the admin panel gets the same
 * refusal).
 *
 *   intent          request                                 needs     answer
 *   create          POST   /api/wiki-spaces          {data}  –         201 WikiSpaceResult, ETag
 *   update          PUT    /api/wiki-spaces/:id      {data}  If-Match  200 WikiSpaceResult
 *   delete          DELETE /api/wiki-spaces/:id              If-Match  204; 400 spaceNotEmpty
 *   authoringList   GET    /api/wiki-spaces/authoring?q=&page=  –      200 WikiSpaceListResponse
 *   editable        GET    /api/wiki-spaces/:id/editable        –      200 WikiSpaceEditable, ETag
 *
 * WIKI PAGES (§J2). Who: M = moderators (admin_role, editor); Row = the
 * page's row-gate classes (its author, the head of its department, the
 * lead of its team; ../wiki-edit.ts); DH, TL = department heads and team
 * leads (the create grant).
 *
 *   intent        request                                       who        needs     answer
 *   create        POST   /api/wiki-pages?status=      {data}    DH TL M    –         201 WikiPageResult
 *   update        PUT    /api/wiki-pages/:id?status=  {data}    Row M      If-Match  200 WikiPageResult
 *   delete        DELETE /api/wiki-pages/:id                    M          If-Match  204
 *   createDraft   POST   /api/wiki-pages/drafts       {data}    DH TL M    –         201 WikiPageResult
 *   myDrafts      GET    /api/wiki-pages/drafts/mine            updaters   –         200 WikiMyDraftsResponse
 *   editable      GET    /api/wiki-pages/:id/editable           Row M      –         200 WikiPageEditable, ETag
 *   saveDraft     PUT    /api/wiki-pages/:id/draft    {data}    Row M      If-Match  200 WikiPageResult
 *   publish       POST   /api/wiki-pages/:id/publish            Row M      If-Match  200 WikiPageResult
 *   discardDraft  POST   /api/wiki-pages/:id/discard-draft      Row M      If-Match  200; 204 deleted
 *   unpublish     POST   /api/wiki-pages/:id/unpublish          M          If-Match  200 WikiPageResult
 *   authoringList GET    /api/wiki-pages/authoring?space=&status=&q=&page=  M  –     200 WikiPageListResponse
 *   revisions     GET    /api/wiki-pages/:id/revisions?page=    Row M      –         200 WikiRevisionListResponse
 *   revision      GET    /api/wiki-pages/:id/revisions/:revisionId  Row M  –         200 { data: WikiRevisionDetail }
 *   restore       POST   /api/wiki-pages/:id/restore {revisionId}  Row M   If-Match  200 WikiPageResult
 *
 *   - STATUS. `create` and `update` take `?status=draft|published` for
 *     moderators (`explicit`, as the other authored types; a missing or
 *     other value answers 400 `details.keys: ["status"]`). For the author
 *     classes the generic routes stay pinned to published (FX07): whatever
 *     they send, the write publishes; they draft through `createDraft` and
 *     `saveDraft`, which never publish and take no status.
 *   - QUERY. No write takes a query key but `status` (400 with the keys).
 *     The lists take only the keys shown; `myDrafts` ignores its query.
 *   - REVISIONS. `If-Match: "<version>"` on every mutation but the two
 *     creates (428 without it, 412 with `details.current` when stale).
 *     `restore` runs the draft update and the publish in one transaction
 *     under that one token, and answers 404 for another page's revision.
 *   - NOT YOURS. A custom action on a page the caller has no class on
 *     answers 404, like a hidden page; the generic PUT answers 403.
 *   - DISCARD. A page without a published row is deleted by a discard
 *     (204); only its author and moderators may do that, every other class
 *     gets 404 (§J2).
 *   - CODES. `parentCycle` on `parent` (the page would sit below itself);
 *     `notPublishable` on `parent` (the parent has no published version);
 *     `invalid` on `space` (missing, hidden, or deleted under the write).
 *
 * THE STRUCTURE LOCK (K21, cms utils/wiki-structure-lock.ts): every
 * mutating wiki-page and wiki-space action takes one reserved lock row,
 * from every source (content API, admin panel, scheduler), so a parent
 * loop, a page in a vanishing space or a page that loses its space to a
 * space publish cannot be committed by two writers at once.
 */

/** The wiki's authored types, by their web name. */
export const WIKI_AUTHORING_TYPES = ["wikiSpace", "wikiPage"] as const;

export type WikiAuthoringType = (typeof WIKI_AUTHORING_TYPES)[number];

/** The URL segment of each wiki type. */
export const WIKI_PATHS: Readonly<Record<WikiAuthoringType, string>> = {
  wikiSpace: "wiki-spaces",
  wikiPage: "wiki-pages",
};

/** The page's row-gate classes plus moderators (§J2; ../wiki-edit.ts decides them). */
export const WIKI_EDITOR_CLASSES = ["moderator", "author", "departmentHead", "teamLead"] as const;

export type WikiEditorClass = (typeof WIKI_EDITOR_CLASSES)[number];

/** The values of a wiki space's `visibility` (§B6, the schema enum). */
export const WIKI_SPACE_VISIBILITIES = ["public", "role", "department", "team"] as const;

export type WikiSpaceVisibility = (typeof WIKI_SPACE_VISIBILITIES)[number];

// ---------------------------------------------------------------------------
// Fields per class (the cms allowlist rules carry exactly these keys).

/** A wiki space (moderators; create and update alike). `allowedRoles` as role types. */
export const WIKI_SPACE_MODERATOR_FIELDS = [
  "name",
  "icon",
  "description",
  "visibility",
  "allowedRoles",
  "department",
  "team",
] as const;

/** The page content every class writes. */
export const WIKI_PAGE_CONTENT_FIELDS = [
  "title",
  "body",
  "summary",
  "tags",
  "tocEnabled",
  "order",
] as const;

/**
 * A page created by a department head or team lead (class `author`): the
 * content, a `space` they can read (required) and a `parent` readable in
 * it. author, lastEditor and the slug are set by the server.
 */
export const WIKI_PAGE_AUTHOR_CREATE_FIELDS = [
  ...WIKI_PAGE_CONTENT_FIELDS,
  "space",
  "parent",
] as const;

/**
 * A page edited by its author, the head of its department or the lead of
 * its team: the content, a `parent` in the page's own space and the edit
 * note `revisionSummary` (not an attribute: the history's change summary).
 */
export const WIKI_PAGE_ROW_EDIT_FIELDS = [
  ...WIKI_PAGE_CONTENT_FIELDS,
  "parent",
  "revisionSummary",
] as const;

/** A page created by a moderator: `space` required; department, team and the schedule too. */
export const WIKI_PAGE_MODERATOR_CREATE_FIELDS = [
  ...WIKI_PAGE_CONTENT_FIELDS,
  "space",
  "parent",
  "department",
  "team",
  "publishAt",
  "revisionSummary",
] as const;

/** A page edited by a moderator: no space move and no slug edit (both stay in the admin panel). */
export const WIKI_PAGE_MODERATOR_UPDATE_FIELDS = [
  ...WIKI_PAGE_CONTENT_FIELDS,
  "parent",
  "department",
  "team",
  "publishAt",
  "revisionSummary",
] as const;

/** type → write → class → the payload keys that class may send. */
export const WIKI_FIELDS: Readonly<{
  wikiSpace: { create: { moderator: readonly string[] }; update: { moderator: readonly string[] } };
  wikiPage: {
    create: { moderator: readonly string[]; author: readonly string[] };
    update: Readonly<Record<WikiEditorClass, readonly string[]>>;
  };
}> = {
  wikiSpace: {
    create: { moderator: WIKI_SPACE_MODERATOR_FIELDS },
    update: { moderator: WIKI_SPACE_MODERATOR_FIELDS },
  },
  wikiPage: {
    create: {
      moderator: WIKI_PAGE_MODERATOR_CREATE_FIELDS,
      author: WIKI_PAGE_AUTHOR_CREATE_FIELDS,
    },
    update: {
      moderator: WIKI_PAGE_MODERATOR_UPDATE_FIELDS,
      author: WIKI_PAGE_ROW_EDIT_FIELDS,
      departmentHead: WIKI_PAGE_ROW_EDIT_FIELDS,
      teamLead: WIKI_PAGE_ROW_EDIT_FIELDS,
    },
  },
};

// ---------------------------------------------------------------------------
// Routes.

export type WikiSpaceIntent = "create" | "update" | "delete" | "authoringList" | "editable";

export const WIKI_SPACE_INTENTS: readonly WikiSpaceIntent[] = [
  "create",
  "update",
  "delete",
  "authoringList",
  "editable",
];

export type WikiPageIntent =
  | "create"
  | "update"
  | "delete"
  | "createDraft"
  | "myDrafts"
  | "editable"
  | "saveDraft"
  | "publish"
  | "discardDraft"
  | "unpublish"
  | "authoringList"
  | "revisions"
  | "revision"
  | "restore";

export const WIKI_PAGE_INTENTS: readonly WikiPageIntent[] = [
  "create",
  "update",
  "delete",
  "createDraft",
  "myDrafts",
  "editable",
  "saveDraft",
  "publish",
  "discardDraft",
  "unpublish",
  "authoringList",
  "revisions",
  "revision",
  "restore",
];

/** The route of a wiki-space intent (path below `/api`, `:documentId` as written). */
export function wikiSpaceRoute(intent: WikiSpaceIntent): AuthoringRoute {
  const base = `/${WIKI_PATHS.wikiSpace}`;
  switch (intent) {
    case "create":
      return { method: "POST", path: base, ifMatch: false };
    case "update":
      return { method: "PUT", path: `${base}/:documentId`, ifMatch: true };
    case "delete":
      return { method: "DELETE", path: `${base}/:documentId`, ifMatch: true };
    case "authoringList":
      return { method: "GET", path: `${base}/authoring`, ifMatch: false };
    case "editable":
      return { method: "GET", path: `${base}/:documentId/editable`, ifMatch: false };
  }
}

/** The route of a wiki-page intent (`:documentId` and `:revisionId` as written). */
export function wikiPageRoute(intent: WikiPageIntent): AuthoringRoute {
  const base = `/${WIKI_PATHS.wikiPage}`;
  const page = `${base}/:documentId`;
  switch (intent) {
    case "create":
      return { method: "POST", path: base, ifMatch: false };
    case "update":
      return { method: "PUT", path: page, ifMatch: true };
    case "delete":
      return { method: "DELETE", path: page, ifMatch: true };
    case "createDraft":
      return { method: "POST", path: `${base}/drafts`, ifMatch: false };
    case "myDrafts":
      return { method: "GET", path: `${base}/drafts/mine`, ifMatch: false };
    case "editable":
      return { method: "GET", path: `${page}/editable`, ifMatch: false };
    case "saveDraft":
      return { method: "PUT", path: `${page}/draft`, ifMatch: true };
    case "publish":
      return { method: "POST", path: `${page}/publish`, ifMatch: true };
    case "discardDraft":
      return { method: "POST", path: `${page}/discard-draft`, ifMatch: true };
    case "unpublish":
      return { method: "POST", path: `${page}/unpublish`, ifMatch: true };
    case "authoringList":
      return { method: "GET", path: `${base}/authoring`, ifMatch: false };
    case "revisions":
      return { method: "GET", path: `${page}/revisions`, ifMatch: false };
    case "revision":
      return { method: "GET", path: `${page}/revisions/:revisionId`, ifMatch: false };
    case "restore":
      return { method: "POST", path: `${page}/restore`, ifMatch: true };
  }
}

/** Fills `:documentId` and `:revisionId` of a wiki route and prefixes `/api` (no query). */
export function wikiRequestPath(
  route: AuthoringRoute,
  ids: { documentId?: string; revisionId?: number | string } = {},
): string {
  let path = route.path;
  if (path.includes(":documentId")) {
    if (!ids.documentId) throw new Error(`wikiRequestPath: ${route.path} needs a documentId`);
    path = path.replace(":documentId", encodeURIComponent(ids.documentId));
  }
  if (path.includes(":revisionId")) {
    if (ids.revisionId === undefined || ids.revisionId === "") {
      throw new Error(`wikiRequestPath: ${route.path} needs a revisionId`);
    }
    path = path.replace(":revisionId", encodeURIComponent(String(ids.revisionId)));
  }
  return `/api${path}`;
}

/** The body of `restore`: the revision to bring back (a revision `id` of the history). */
export interface WikiRestoreRequest {
  revisionId: number;
}

/** The query keys of the wiki lists (anything else answers 400 with the keys). */
export const WIKI_SPACE_LIST_QUERY_KEYS = ["q", "page"] as const;
export const WIKI_PAGE_LIST_QUERY_KEYS = ["space", "status", "q", "page"] as const;
export const WIKI_REVISIONS_QUERY_KEYS = ["page"] as const;

/** History entries per page of `revisions`. */
export const WIKI_REVISIONS_PAGE_SIZE = 25;
