import type {
  ActivityActorClass,
  ActivityActorKind,
  ActivityTargetUid,
  AuthoringListStatusFilter,
  AuthoringWriteStatus,
} from "./dto.js";
import type { AuthoringType } from "./fields.js";

/**
 * The HTTP contract of v2 authoring (deep-dive decision 06 §B3, §B5, §G;
 * batch 15 plan, contract K7): which route each intent takes, which
 * precondition it needs and how it answers. The cms routes carry exactly
 * this table (apps/cms/src/utils/authoring-routes.test.ts pins it); the
 * web builds its requests from it.
 *
 *   intent              request                                     needs       answer
 *   create a draft      POST   /api/P?status=draft        {data}     –           201, DTO, ETag
 *   create and publish  POST   /api/P?status=published    {data}     –           201
 *   save the draft      PUT    /api/P/:documentId?status=draft {data} If-Match  200
 *   save and publish    PUT    /api/P/:documentId?status=published    If-Match  200
 *   publish as it is    POST   /api/P/:documentId/publish            If-Match  200
 *   unpublish           POST   /api/P/:documentId/unpublish          If-Match  200
 *   discard the draft   POST   /api/P/:documentId/discard-draft      If-Match  200 (no published row: 204,
 *                                                                               deleted; a department author:
 *                                                                               400 _form neverPublished)
 *   delete              DELETE /api/P/:documentId                    If-Match  204
 *   list for /manage    GET    /api/P/authoring?status=&q=&page=&owner=   –     200 AuthoringListResponse
 *   load the form       GET    /api/P/:documentId/editable               –     200 EditableResponse, ETag
 *
 * STATUS. Announcements, events, quick links and documents take an
 * explicit `?status=draft|published` on create and update (`explicit`): a
 * missing or other value answers 400 with `details.keys: ["status"]`.
 * Polls always publish (`alwaysPublished`): no status, or `published`;
 * `draft` answers 400. Polls have no publish, unpublish or discard routes:
 * a poll is published at create and closed through `closesAt`.
 *
 * QUERY. Writes take no other query key: `populate`, `fields`, `filters`,
 * `sort`, `locale`, ... answer 400 with the keys. The list takes only
 * `status`, `q`, `page` and (moderators) `owner`.
 *
 * REVISION. Every mutation but create sends `If-Match: "<version>"` (the
 * `version` of the last answer or of `editable`): without it 428, stale
 * 412 with `details.current` (the current revision; the web offers Reload
 * or Overwrite with it). Every success answers `ETag: "<version>"` and
 * `data.version`, the revision the request's transaction committed.
 *
 * REFUSALS (§B5). 400 `ValidationError` with `details.keys`/`details.codes`
 * (codes.ts); 403 the grant is missing, or a generic route's row gate is
 * false (a department author on an item not theirs: PUT and DELETE); 404 a
 * missing document, or a custom action on an item the caller has no class
 * on; 412 and 428 as above.
 *
 * DEPARTMENT AUTHORS use the same routes on announcements, events and
 * documents: DELETE answers 403, a payload with a moderator-only key (pinned,
 * requiresAck, ackDeadline, publishAt, unpublishAt) the generic 400 for
 * those keys, a discard without a published version 400 neverPublished.
 */

/** The URL segment (`P`) of each type. */
export const AUTHORING_PATHS: Readonly<Record<AuthoringType, string>> = {
  announcement: "announcements",
  event: "events",
  quickLink: "quick-links",
  document: "documents",
  poll: "polls",
};

/** How a type's create and update treat `?status=` (§B3 step 3). */
export type AuthoringStatusMode = "explicit" | "alwaysPublished";

export const AUTHORING_STATUS_MODES: Readonly<Record<AuthoringType, AuthoringStatusMode>> = {
  announcement: "explicit",
  event: "explicit",
  quickLink: "explicit",
  document: "explicit",
  poll: "alwaysPublished",
};

/** The authoring intents of the table above. */
export type AuthoringIntent =
  | "create"
  | "update"
  | "publish"
  | "unpublish"
  | "discardDraft"
  | "delete"
  | "authoringList"
  | "editable";

/** Every intent of the table: the explicit-status types offer them all. */
const EVERY_INTENT: readonly AuthoringIntent[] = [
  "create",
  "update",
  "publish",
  "unpublish",
  "discardDraft",
  "delete",
  "authoringList",
  "editable",
];

/** The intents each type offers. */
export const AUTHORING_INTENTS: Readonly<Record<AuthoringType, readonly AuthoringIntent[]>> = {
  announcement: EVERY_INTENT,
  event: EVERY_INTENT,
  quickLink: EVERY_INTENT,
  document: EVERY_INTENT,
  poll: ["create", "update", "delete", "authoringList", "editable"],
};

/** One route of the table: method and path below `/api` (`:documentId` as written). */
export interface AuthoringRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  /** Whether the request needs `If-Match`. */
  ifMatch: boolean;
}

/** The route of `intent` on `type` (path with `:documentId`, without the query). */
export function authoringRoute(type: AuthoringType, intent: AuthoringIntent): AuthoringRoute {
  const base = `/${AUTHORING_PATHS[type]}`;
  switch (intent) {
    case "create":
      return { method: "POST", path: base, ifMatch: false };
    case "update":
      return { method: "PUT", path: `${base}/:documentId`, ifMatch: true };
    case "publish":
      return { method: "POST", path: `${base}/:documentId/publish`, ifMatch: true };
    case "unpublish":
      return { method: "POST", path: `${base}/:documentId/unpublish`, ifMatch: true };
    case "discardDraft":
      return { method: "POST", path: `${base}/:documentId/discard-draft`, ifMatch: true };
    case "delete":
      return { method: "DELETE", path: `${base}/:documentId`, ifMatch: true };
    case "authoringList":
      return { method: "GET", path: `${base}/authoring`, ifMatch: false };
    case "editable":
      return { method: "GET", path: `${base}/:documentId/editable`, ifMatch: false };
  }
}

/** The request path of `intent` on `type` for `documentId`, with `/api` (no query). */
export function authoringPath(
  type: AuthoringType,
  intent: AuthoringIntent,
  documentId?: string,
): string {
  const { path } = authoringRoute(type, intent);
  if (path.includes(":documentId")) {
    if (!documentId) throw new Error(`authoringPath: ${type} ${intent} needs a documentId`);
    return `/api${path.replace(":documentId", encodeURIComponent(documentId))}`;
  }
  return `/api${path}`;
}

/** The request header that carries the expected revision. */
export const IF_MATCH_HEADER = "If-Match";

/** `If-Match` for a `version` from an answer: the version in double quotes. */
export function ifMatch(version: string | number): string {
  return `"${version}"`;
}

/** The version an `ETag` value names (`"7"` → `"7"` without quotes), or null. */
export function versionFromEtag(etag: string | null | undefined): string | null {
  if (typeof etag !== "string") return null;
  const match = /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/.exec(etag);
  return match ? match[1] : null;
}

/** Rows per page of the authoring list. */
export const AUTHORING_LIST_PAGE_SIZE = 25;
/** Longest `q` the list takes. */
export const AUTHORING_LIST_MAX_QUERY = 100;

// Batch 17 contracts, not additional live entries in AUTHORING_TYPES.

/** Training has draft/publish and nondeleting discard, but no content-API delete. */
export const TRAINING_AUTHORING_INTENTS = [
  "create",
  "update",
  "publish",
  "unpublish",
  "discardDraft",
  "authoringList",
  "editable",
] as const;

export type TrainingAuthoringIntent = (typeof TRAINING_AUTHORING_INTENTS)[number];

export const TRAINING_PATHS = { course: "courses", lesson: "lessons" } as const;

/** Required on training create/update; all other query keys are refused. */
export interface TrainingWriteQuery {
  status: AuthoringWriteStatus;
}

export interface TrainingAuthoringListQuery {
  status?: AuthoringListStatusFilter;
  q?: string;
  page?: number;
}

export interface LessonAuthoringListQuery extends TrainingAuthoringListQuery {
  /** Canonical course documentId; applied before pagination and count. */
  course?: string;
}

/** Single-row organisation content has only editable and If-Match update. */
export const ORG_AUTHORING_INTENTS = ["update", "editable"] as const;
export type OrgAuthoringIntent = (typeof ORG_AUTHORING_INTENTS)[number];

export const ORG_PATHS = { department: "departments", team: "teams" } as const;

/** Every query key is refused, including status. */
export type OrgWriteQuery = Record<string, never>;

/** GET /api/audit-events, admin_role only; no generic Strapi query keys. */
export interface ActivityListQuery {
  /** Integer 1..10000; fixed page size 25. */
  page?: number;
  targetUid?: ActivityTargetUid;
  actorKind?: ActivityActorKind;
  /** Positive int4; requires actorKind=user or admin, which scopes this id. */
  actorId?: number;
  actorClass?: ActivityActorClass;
  /** Offset-bearing ISO instants, with from <= to (inclusive). */
  from?: string;
  to?: string;
}
