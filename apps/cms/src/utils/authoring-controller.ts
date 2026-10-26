import {
  AUTHORING_LIST_MAX_QUERY,
  AUTHORING_LIST_PAGE_SIZE,
  AUTHORING_STATUS_MODES,
  FORM_KEY,
  STATUS_KEY,
  announcementNeedsRetarget,
  eventNeedsRetarget,
  parseQuiz,
  validateDutyShifts,
  validateDutyTemplates,
  isKpiAggregation,
  isKpiPeriod,
  validateKpiValues,
  scopedNeedsRetarget,
  type AuthoringDocumentStatus,
  type AuthoringListRow,
  type AuthoringStatusMode,
  type AuthoringType,
  type OwnerDepartment,
  type EditableMedia,
  type TrainingAuthoringType,
  type TrainingCourseRef,
  type WikiAuthoringType,
  type WikiSpaceRef,
} from "@sinnlos/domain";
import { errors } from "@strapi/utils";
import {
  ANNOUNCEMENT_UID,
  COURSE_UID,
  LESSON_UID,
  DEPARTMENT_AUTHORED_UIDS,
  DOCUMENT_UID,
  EVENT_UID,
  QUICK_LINK_UID,
  DUTY_PLAN_UID,
  KPI_UID,
  WIKI_PAGE_UID,
  WIKI_SPACE_UID,
} from "./authoring-uids";
import { pollHasVotes } from "./authoring-checks";
import {
  CONTENT_VERSION_UID,
  ClassLost,
  DocumentLockError,
  RevisionStale,
  etagOf,
  lockDocument,
  parseIfMatch,
  runInAuthoringScope,
  type AuthoringScope,
  type DocumentLockHost,
} from "./document-lock";
import { isDocumentId, parseEntryRef } from "./entry-id";
import {
  AUTHORING_POPULATE,
  authoringGateOf,
  departmentAuthorOwns,
  type AuthoringGate,
  type AuthoringRow,
  type AuthoringRows,
  type GateIntent,
} from "./write-gate";
import { wikiEditContext } from "./wiki-edit-context";
import {
  DEPARTMENT_AUTHOR_CLASS,
  MODERATOR_CLASS,
  POLL_UID,
  WIKI_SPACE_VISIBILITY_TARGETS,
  refuseKeys,
} from "./write-allowlist";

/**
 * The authoring controller (deep-dive decision 06 §B3, §G, §N2; batch 15
 * plan items 1 and 6): create, update, publish, unpublish, discard-draft,
 * delete, the /manage list and the form read of announcement, event,
 * quick-link, document and poll, and (batch 16) wiki-space and wiki-page,
 * spread into each type's core controller (api/<type>/controllers/
 * <type>.ts). The HTTP contract is @sinnlos/domain authoring/http.ts and
 * authoring/wiki.ts; the wiki pages' draft and history actions are in
 * utils/wiki-authoring.ts.
 *
 * Every write goes through the Document Service with the payload the write
 * gate checked (global::can-author, utils/write-gate.ts; the allowlist
 * REPLACES the core input validation, whose entity validation of types,
 * required fields, lengths and enums still runs, C24), inside an authoring
 * scope (utils/document-lock.ts) that names the document, the client's
 * `If-Match` and what the gate saw (`observedRevision` and its classifier),
 * so the document lock binds the gate's decision to the write (amendment
 * row A2). The answer is computed here, never from a client `populate` or
 * `fields`:
 *   - `data`: { documentId, version, status, publishedAt } plus the
 *     schedule fields of the type (the DTO of @sinnlos/domain
 *     authoring/dto.ts); `version` is the revision THIS request's
 *     transaction committed (the scope's `committedRevision`), and the
 *     DTO is read inside that transaction;
 *   - `ETag: "<version>"`.
 *
 * STATUS (§B3 step 3). The explicit types (announcement, event, quick link,
 * document) need `?status=draft|published` on create and update: without
 * it the Document Service would silently save a draft (C28), so a missing
 * or other value answers 400 `details.keys: ["status"]`. Polls always
 * publish: no status or `published`; `draft` answers 400. Every other
 * query key answers 400 with the keys: no write honours a client populate,
 * fields, filters or sort.
 *
 * REVISION (§G). Every mutation but create needs `If-Match: "<revision>"`:
 * 428 without it, 412 with `details.current` when it is stale. A caller
 * whose class went away between the gate and the lock gets 403 on the
 * generic PUT and 404 on the custom actions (the lock's ClassLost), never
 * 412 and never the new revision. delete keeps global::is-admin-or-editor
 * and compares the token only.
 *
 * DISCARD (§N2, amendment row A1; §J2). A discard of a document without a
 * published row deletes it (C20). A moderator gets that (204); a department
 * author gets 400 `_form: neverPublished`, decided under the document's
 * lock, after the token check: department authors never delete. On a wiki
 * page only its author and moderators may delete that way; the head of its
 * department and the lead of its team get 404 there, decided the same way.
 * Training always refuses with neverPublished: courses and lessons are never
 * deleted through the content API, regardless of the moderator class.
 *
 * WIKI PAGES (batch 16). Every create and update runs inside
 * `wikiEditContext` (the editor and the edit note `revisionSummary`, which
 * the allowlist admits as a controller field and which is stripped here),
 * so the wiki-page lifecycle records the history with its author.
 */

/** How each type's answers and forms are built. */
export interface AuthoringSpec {
  uid: string;
  type: AuthoringType | WikiAuthoringType | TrainingAuthoringType;
  statusMode: AuthoringStatusMode;
  /** The label field (list `label`, `q` filter). */
  labelField: string;
  /** The user relation whose display name the list shows, or null. */
  authorField: string | null;
  /** `publishAt` and `scheduleError`. */
  scheduled: boolean;
  /** `unpublishAt`. */
  unpublishScheduled: boolean;
  /** The targeting flag columns the list reads (needsRetarget). */
  flagColumns: readonly string[];
  /** Further scalar columns the list rows show (the wiki's slug, order, icon, visibility). */
  listColumns?: readonly string[];
}

export const AUTHORING_SPECS: Readonly<Record<string, AuthoringSpec>> = {
  [COURSE_UID]: {
    uid: COURSE_UID,
    type: "course",
    statusMode: "explicit",
    labelField: "title",
    authorField: null,
    scheduled: true,
    unpublishScheduled: false,
    flagColumns: ["audience"],
  },
  [LESSON_UID]: {
    uid: LESSON_UID,
    type: "lesson",
    statusMode: "explicit",
    labelField: "title",
    authorField: null,
    scheduled: true,
    unpublishScheduled: false,
    flagColumns: [],
    listColumns: ["order"],
  },
  [ANNOUNCEMENT_UID]: {
    uid: ANNOUNCEMENT_UID,
    type: "announcement",
    statusMode: AUTHORING_STATUS_MODES.announcement,
    labelField: "title",
    authorField: "author",
    scheduled: true,
    unpublishScheduled: false,
    flagColumns: ["audience", "retargetRequired"],
  },
  [EVENT_UID]: {
    uid: EVENT_UID,
    type: "event",
    statusMode: AUTHORING_STATUS_MODES.event,
    labelField: "title",
    authorField: "organizer",
    scheduled: true,
    unpublishScheduled: false,
    flagColumns: ["notifyAudience"],
  },
  [QUICK_LINK_UID]: {
    uid: QUICK_LINK_UID,
    type: "quickLink",
    statusMode: AUTHORING_STATUS_MODES.quickLink,
    labelField: "label",
    authorField: null,
    scheduled: true,
    unpublishScheduled: true,
    flagColumns: ["audience"],
  },
  [DOCUMENT_UID]: {
    uid: DOCUMENT_UID,
    type: "document",
    statusMode: AUTHORING_STATUS_MODES.document,
    labelField: "title",
    authorField: "uploadedBy",
    scheduled: true,
    unpublishScheduled: true,
    flagColumns: ["audience"],
  },
  [DUTY_PLAN_UID]: {
    uid: DUTY_PLAN_UID,
    type: "dutyPlan",
    statusMode: AUTHORING_STATUS_MODES.dutyPlan,
    labelField: "name",
    authorField: "author",
    scheduled: false,
    unpublishScheduled: false,
    flagColumns: [],
  },
  [KPI_UID]: {
    uid: KPI_UID,
    type: "kpi",
    statusMode: AUTHORING_STATUS_MODES.kpi,
    labelField: "name",
    authorField: "author",
    scheduled: false,
    unpublishScheduled: false,
    flagColumns: [],
  },
  [POLL_UID]: {
    uid: POLL_UID,
    type: "poll",
    statusMode: AUTHORING_STATUS_MODES.poll,
    labelField: "question",
    authorField: "author",
    scheduled: false,
    unpublishScheduled: false,
    flagColumns: ["audience"],
  },
  // Always published, like polls (§B3): no publish, unpublish or discard.
  [WIKI_SPACE_UID]: {
    uid: WIKI_SPACE_UID,
    type: "wikiSpace",
    statusMode: "alwaysPublished",
    labelField: "name",
    authorField: null,
    scheduled: false,
    unpublishScheduled: false,
    flagColumns: [],
    listColumns: ["slug", "icon", "visibility"],
  },
  [WIKI_PAGE_UID]: {
    uid: WIKI_PAGE_UID,
    type: "wikiPage",
    statusMode: "explicit",
    labelField: "title",
    authorField: "author",
    scheduled: true,
    unpublishScheduled: false,
    flagColumns: [],
    listColumns: ["slug", "order"],
  },
};

const isTrainingUid = (uid: string) => uid === COURSE_UID || uid === LESSON_UID;

const isWikiUid = (uid: string) => uid === WIKI_PAGE_UID || uid === WIKI_SPACE_UID;

// ---------------------------------------------------------------------------
// The Strapi slices and the Koa context the actions use

interface DocumentServiceApi {
  create(params: Record<string, unknown>): Promise<unknown>;
  update(params: Record<string, unknown>): Promise<unknown>;
  publish(params: Record<string, unknown>): Promise<unknown>;
  unpublish(params: Record<string, unknown>): Promise<unknown>;
  discardDraft(params: Record<string, unknown>): Promise<unknown>;
  delete(params: Record<string, unknown>): Promise<unknown>;
}

/** The slice of the Strapi instance the controller uses. */
export interface AuthoringControllerHost extends DocumentLockHost {
  documents(uid: string): DocumentServiceApi;
  db: Omit<DocumentLockHost["db"], "query"> & {
    query(uid: string): {
      findOne(params: Record<string, unknown>): Promise<Record<string, unknown> | null>;
      findMany(params: Record<string, unknown>): Promise<unknown>;
      count(params: Record<string, unknown>): Promise<number>;
    };
  };
}

/** The slice of Koa's context the actions read and write. */
export interface AuthoringContext {
  state: Record<string, unknown>;
  params: { id?: unknown };
  query: Record<string, unknown>;
  request: { body?: unknown };
  get(header: string): string;
  set(header: string, value: string): void;
  status: number;
  body: unknown;
}

type Action = (ctx: AuthoringContext) => Promise<void>;

export interface AuthoringActions {
  create: Action;
  update: Action;
  delete: Action;
  authoringList: Action;
  editable: Action;
  publish?: Action;
  unpublish?: Action;
  discardDraft?: Action;
}

// ---------------------------------------------------------------------------
// Helpers

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value !== "") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : new Date(ms).toISOString();
  }
  return null;
};

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const bool = (value: unknown): boolean => value === true;

const ms = (value: unknown): number | null => {
  const text = iso(value);
  return text === null ? null : Date.parse(text);
};

/** The Strapi error envelope of a lock refusal (428, 412 with details.current, 403/404). */
function sendLockError(ctx: AuthoringContext, error: DocumentLockError): void {
  if (error instanceof ClassLost && error.status === 403) {
    // Byte-identical to the gate's own refusal on the generic PUT (Strapi's
    // PolicyError for a false policy): a class lost under the lock answers
    // like a class the gate never found.
    ctx.status = 403;
    ctx.body = {
      data: null,
      error: { status: 403, name: "PolicyError", message: "Policy Failed", details: {} },
    };
    return;
  }
  ctx.status = error.status;
  ctx.body = {
    data: null,
    error: {
      status: error.status,
      name: error.name,
      message: error.message,
      details: error.details,
    },
  };
}

/** Strapi's unique check (entity validator) answers this text and no code. */
const STRAPI_UNIQUE_MESSAGE = "This attribute must be unique";

/** The top-level keys Strapi's unique check refused in `error`, if any. */
function uniqueRefusedKeys(error: unknown): string[] {
  if (!(error instanceof Error) || error.name !== "ValidationError") return [];
  const list = (error as { details?: { errors?: unknown } }).details?.errors;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) =>
    entry?.message === STRAPI_UNIQUE_MESSAGE &&
    Array.isArray(entry.path) &&
    entry.path.length === 1 &&
    typeof entry.path[0] === "string"
      ? [entry.path[0]]
      : [],
  );
}

/**
 * Runs `fn`; a lock refusal becomes its answer, Strapi's unique refusal the
 * usual 400 with `taken` on its keys, anything else propagates.
 */
export async function answering(ctx: AuthoringContext, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof DocumentLockError) {
      sendLockError(ctx, error);
      return;
    }
    const taken = uniqueRefusedKeys(error);
    if (taken.length > 0) refuseKeys(taken, Object.fromEntries(taken.map((key) => [key, "taken"])));
    throw error;
  }
}

/** The gate's decision for `intent`, or a 403 when the route was wired without it. */
export function gateFor(ctx: AuthoringContext, uid: string, intent: GateIntent): AuthoringGate {
  const gate = authoringGateOf(ctx.state);
  // A route of this controller without global::can-author is a wiring bug:
  // refuse (fail closed) instead of writing unchecked.
  if (!gate || gate.uid !== uid || gate.intent !== intent) {
    throw new errors.ForbiddenError("Forbidden");
  }
  return gate;
}

/**
 * The write status of a create or update (§B3 step 3); every other query
 * key is refused (400 with the keys).
 */
export function writeStatus(
  query: Record<string, unknown> | undefined,
  mode: AuthoringStatusMode,
): "draft" | "published" {
  const keys = Object.keys(query ?? {});
  const extra = keys.filter((key) => key !== STATUS_KEY);
  if (extra.length > 0) refuseKeys(extra);
  const raw = query?.[STATUS_KEY];
  if (mode === "alwaysPublished") {
    if (raw === undefined || raw === "published") return "published";
    refuseKeys([STATUS_KEY], { [STATUS_KEY]: "invalid" });
  }
  if (raw === undefined || raw === "") refuseKeys([STATUS_KEY], { [STATUS_KEY]: "required" });
  if (raw === "draft" || raw === "published") return raw;
  refuseKeys([STATUS_KEY], { [STATUS_KEY]: "invalid" });
}

/** A custom action takes no query at all. */
export function noQuery(query: Record<string, unknown> | undefined): void {
  const keys = Object.keys(query ?? {});
  if (keys.length > 0) refuseKeys(keys);
}

/** The policy-checked payload (`data`). */
export function payloadOf(ctx: AuthoringContext): Record<string, unknown> {
  const body = ctx.request.body;
  const data = isRecord(body) ? body.data : undefined;
  if (!isRecord(data))
    throw new errors.ValidationError('Missing "data" payload in the request body');
  return data;
}

/**
 * The publication state (the Content Manager's rule, C14): no published
 * row is a draft; a draft saved after the published row is "modified".
 */
export function documentStatus(
  draft: Record<string, unknown> | null,
  published: Record<string, unknown> | null,
): AuthoringDocumentStatus {
  if (!published) return "draft";
  const draftAt = ms(draft?.updatedAt);
  const publishedAt = ms(published.updatedAt);
  return draftAt !== null && publishedAt !== null && draftAt > publishedAt
    ? "modified"
    : "published";
}

/** The schedule fields of a type, from the draft row (§D rule 2: the draft is authoritative). */
function scheduleFields(spec: AuthoringSpec, draft: Record<string, unknown> | null) {
  return {
    ...(spec.scheduled
      ? {
          publishAt: iso(draft?.publishAt),
          scheduleError: (draft?.scheduleError as string) ?? null,
        }
      : {}),
    ...(spec.unpublishScheduled ? { unpublishAt: iso(draft?.unpublishAt) } : {}),
  };
}

/**
 * The write answer of a document (read inside the write's transaction).
 * The wiki types add their slug, a wiki page its space's slug (@sinnlos/
 * domain WikiSpaceResult, WikiPageResult).
 */
export async function resultDto(
  strapi: AuthoringControllerHost,
  spec: AuthoringSpec,
  documentId: string,
  version: number,
) {
  const wiki = isWikiUid(spec.uid);
  const rows = (await strapi.db.query(spec.uid).findMany({
    where: { documentId },
    select: [
      "id",
      "documentId",
      "publishedAt",
      "updatedAt",
      ...(spec.scheduled ? ["publishAt", "scheduleError"] : []),
      ...(spec.unpublishScheduled ? ["unpublishAt"] : []),
      ...(wiki ? ["slug"] : []),
    ],
    ...(spec.uid === WIKI_PAGE_UID ? { populate: { space: { select: ["slug"] } } } : {}),
  })) as Record<string, unknown>[];
  const draft = rows.find((row) => row.publishedAt == null) ?? null;
  const published = rows.find((row) => row.publishedAt != null) ?? null;
  const space = isRecord(draft?.space) ? draft.space : null;
  return {
    documentId,
    version: String(version),
    status: documentStatus(draft, published),
    publishedAt: iso(published?.publishedAt),
    ...scheduleFields(spec, draft),
    ...(wiki ? { slug: text(draft?.slug) ?? "" } : {}),
    ...(spec.uid === WIKI_PAGE_UID ? { spaceSlug: text(space?.slug) } : {}),
  };
}

export const documentIdOf = (value: unknown): string | null =>
  isRecord(value) && typeof value.documentId === "string" ? value.documentId : null;

/** A populated wiki space as a page's form and the drafts list name it, or null. */
export function wikiSpaceRefOf(value: unknown): WikiSpaceRef | null {
  if (!isRecord(value) || typeof value.documentId !== "string") return null;
  return {
    documentId: value.documentId,
    slug: text(value.slug) ?? "",
    name: text(value.name) ?? "",
  };
}

/** Fixed media DTO for author forms; never expose upload ownership or related content. */
export function editableMediaOf(value: unknown): EditableMedia | null {
  if (!isRecord(value) || typeof value.id !== "number") return null;
  return {
    id: value.id,
    name: text(value.name) ?? "",
    mime: text(value.mime) ?? "",
    size: typeof value.size === "number" ? value.size : Number(value.size ?? 0),
    url: text(value.url) ?? "",
  };
}

function trainingCourseRefOf(value: unknown): TrainingCourseRef | null {
  if (!isRecord(value) || typeof value.documentId !== "string") return null;
  return {
    documentId: value.documentId,
    title: text(value.title) ?? "",
    slug: text(value.slug) ?? "",
  };
}

const ownerOf = (row: AuthoringRow | null): OwnerDepartment | null => {
  const owner = row?.ownerDepartment;
  return isRecord(owner) && typeof owner.documentId === "string"
    ? { documentId: owner.documentId, name: typeof owner.name === "string" ? owner.name : "" }
    : null;
};

const documentIdsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(documentIdOf).filter((id): id is string => id !== null) : [];

const roleTypesOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .map((role) => (isRecord(role) ? role.type : null))
        .filter((type): type is string => typeof type === "string")
    : [];

/**
 * Whether a wiki space's visibility lost its target (a deleted department
 * or team, every allowed role gone): only moderators read it then
 * (utils/visible-ids.ts).
 */
export function spaceNeedsRetarget(row: Record<string, unknown> | null): boolean {
  if (!row) return false;
  const target = WIKI_SPACE_VISIBILITY_TARGETS[String(row.visibility)];
  if (!target) return false;
  const value = row[target];
  return Array.isArray(value) ? value.length === 0 : !isRecord(value);
}

/** Whether a row is restricted with no target left (§N9), by type. */
export function rowNeedsRetarget(uid: string, row: Record<string, unknown> | null): boolean {
  if (!row) return false;
  if (uid === WIKI_SPACE_UID) return spaceNeedsRetarget(row);
  // A wiki page has no targeting: its space decides who reads it; a lesson
  // follows its course.
  if (uid === WIKI_PAGE_UID || uid === LESSON_UID) return false;
  if (uid === ANNOUNCEMENT_UID) {
    return announcementNeedsRetarget({
      audience: row.audience as string | null,
      department: (row.department as object | null) ?? null,
      team: (row.team as object | null) ?? null,
      retargetRequired: row.retargetRequired as boolean | null,
    });
  }
  const departments = Array.isArray(row.departments) ? row.departments : [];
  if (uid === EVENT_UID) {
    return eventNeedsRetarget({ notifyAudience: row.notifyAudience as string | null, departments });
  }
  return scopedNeedsRetarget({ audience: row.audience as string | null, departments });
}

const needsRetarget = (uid: string, rows: AuthoringRows) =>
  rowNeedsRetarget(uid, rows.draft) || rowNeedsRetarget(uid, rows.published);

export const displayNameOf = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  if (typeof value.displayName === "string" && value.displayName !== "") return value.displayName;
  return typeof value.username === "string" ? value.username : null;
};

// ---------------------------------------------------------------------------
// The form read (`editable`, §B3): the draft in the write shape

/** The type's editable fields for `roleClass` (department authors: their rule's fields only). */
export async function editableFields(
  strapi: AuthoringControllerHost,
  uid: string,
  rows: AuthoringRows,
  roleClass: string,
): Promise<Record<string, unknown>> {
  const draft = rows.draft ?? ({} as AuthoringRow);
  const moderator = roleClass === MODERATOR_CLASS;
  const retarget = needsRetarget(uid, rows);
  switch (uid) {
    case COURSE_UID:
      return {
        title: text(draft.title) ?? "",
        slug: text(draft.slug) ?? "",
        description: text(draft.description),
        mandatory: draft.mandatory !== false,
        completionMode: text(draft.completionMode) ?? "confirm",
        validityMonths: typeof draft.validityMonths === "number" ? draft.validityMonths : null,
        contact: text(draft.contact),
        departments: documentIdsOf(draft.departments),
        needsRetarget: retarget,
        coverImage: editableMediaOf(draft.coverImage),
        publishAt: iso(draft.publishAt),
        scheduleError: text(draft.scheduleError),
      };
    case LESSON_UID:
      return {
        title: text(draft.title) ?? "",
        body: text(draft.body),
        order: typeof draft.order === "number" ? draft.order : 0,
        course: trainingCourseRefOf(draft.course),
        videoUrl: text(draft.videoUrl),
        quiz: parseQuiz(draft.quiz),
        publishAt: iso(draft.publishAt),
        scheduleError: text(draft.scheduleError),
      };
    case ANNOUNCEMENT_UID:
      return {
        title: text(draft.title) ?? "",
        body: text(draft.body),
        expiresAt: iso(draft.expiresAt),
        department: documentIdOf(draft.department),
        team: documentIdOf(draft.team),
        audienceRoles: roleTypesOf(draft.audienceRoles),
        ownerDepartment: ownerOf(draft),
        needsRetarget: retarget,
        ...(moderator
          ? {
              pinned: bool(draft.pinned),
              requiresAck: bool(draft.requiresAck),
              ackDeadline: text(draft.ackDeadline),
              publishAt: iso(draft.publishAt),
              scheduleError: text(draft.scheduleError),
            }
          : {}),
      };
    case EVENT_UID:
      return {
        title: text(draft.title) ?? "",
        description: text(draft.description),
        start: iso(draft.start),
        end: iso(draft.end),
        allDay: bool(draft.allDay),
        location: text(draft.location),
        url: text(draft.url),
        rsvpEnabled: bool(draft.rsvpEnabled),
        capacity: typeof draft.capacity === "number" ? draft.capacity : null,
        departments: documentIdsOf(draft.departments),
        ownerDepartment: ownerOf(draft),
        needsRetarget: retarget,
        ...(moderator
          ? { publishAt: iso(draft.publishAt), scheduleError: text(draft.scheduleError) }
          : {}),
      };
    case QUICK_LINK_UID:
      return {
        label: text(draft.label) ?? "",
        url: text(draft.url) ?? "",
        icon: text(draft.icon),
        category: text(draft.category) ?? "tools",
        order: typeof draft.order === "number" ? draft.order : 0,
        departments: documentIdsOf(draft.departments),
        needsRetarget: retarget,
        publishAt: iso(draft.publishAt),
        unpublishAt: iso(draft.unpublishAt),
        scheduleError: text(draft.scheduleError),
      };
    case DOCUMENT_UID: {
      return {
        title: text(draft.title) ?? "",
        description: text(draft.description),
        category: text(draft.category) ?? "other",
        departments: documentIdsOf(draft.departments),
        file: editableMediaOf(draft.file),
        ownerDepartment: ownerOf(draft),
        needsRetarget: retarget,
        ...(moderator
          ? {
              requiresAck: draft.requiresAck === true,
              publishAt: iso(draft.publishAt),
              unpublishAt: iso(draft.unpublishAt),
              scheduleError: text(draft.scheduleError),
            }
          : {}),
      };
    }
    case WIKI_SPACE_UID:
      return {
        name: text(draft.name) ?? "",
        slug: text(draft.slug) ?? "",
        icon: text(draft.icon),
        description: text(draft.description),
        visibility: text(draft.visibility) ?? "public",
        allowedRoles: roleTypesOf(draft.allowedRoles),
        department: documentIdOf(draft.department),
        team: documentIdOf(draft.team),
        needsRetarget: spaceNeedsRetarget(draft),
        pageCount: (await spacePageCounts(strapi, [rows.documentId])).get(rows.documentId) ?? 0,
      };
    case WIKI_PAGE_UID:
      return {
        title: text(draft.title) ?? "",
        slug: text(draft.slug) ?? "",
        body: text(draft.body),
        summary: text(draft.summary),
        tags: Array.isArray(draft.tags)
          ? (draft.tags as unknown[]).filter((tag): tag is string => typeof tag === "string")
          : [],
        // The schema default is true: a NULL column reads as on.
        tocEnabled: draft.tocEnabled !== false,
        order: typeof draft.order === "number" ? draft.order : 0,
        space: wikiSpaceRefOf(draft.space),
        parent: documentIdOf(draft.parent),
        canDiscardUnpublished: mayDeleteByDiscard(roleClass),
        ...(moderator
          ? {
              department: documentIdOf(draft.department),
              team: documentIdOf(draft.team),
              publishAt: iso(draft.publishAt),
              scheduleError: text(draft.scheduleError),
            }
          : {}),
      };
    case POLL_UID:
      return {
        question: text(draft.question) ?? "",
        options: Array.isArray(draft.options)
          ? (draft.options as unknown[]).filter((o): o is string => typeof o === "string")
          : [],
        closesAt: iso(draft.closesAt),
        anonymous: bool(draft.anonymous),
        departments: documentIdsOf(draft.departments),
        visibleToGuests: bool(draft.visibleToGuests),
        guestsCanVote: bool(draft.guestsCanVote),
        needsRetarget: retarget,
        hasVotes: await pollHasVotes(strapi, rows.documentId),
        // v0.28: closesAt is frozen too (poll-audience-guard.ts votersRemoved).
        votersRemoved: draft.votersRemovedAt != null || rows.published?.votersRemovedAt != null,
      };
    case DUTY_PLAN_UID: {
      // The stored lists passed the lifecycle; anything else reads as empty.
      const templates = validateDutyTemplates(draft.shiftTemplates);
      const shifts = validateDutyShifts(draft.shifts);
      return {
        name: text(draft.name) ?? "",
        note: text(draft.note),
        department: documentIdOf(draft.department),
        shiftTemplates: "error" in templates ? [] : templates.templates,
        shifts: "error" in shifts ? [] : shifts.shifts,
        ownerDepartment: ownerOf(draft),
      };
    }
    case KPI_UID: {
      // The stored values passed the lifecycle; anything else reads as none.
      const values = validateKpiValues(draft.values);
      return {
        name: text(draft.name) ?? "",
        unit: text(draft.unit),
        description: text(draft.description),
        department: documentIdOf(draft.department),
        period: isKpiPeriod(draft.period) ? draft.period : "month",
        aggregation: isKpiAggregation(draft.aggregation) ? draft.aggregation : "sum",
        values: "error" in values ? {} : values.values,
        ownerDepartment: ownerOf(draft),
      };
    }
    default:
      throw new Error(`authoring controller: no editable shape for ${uid}`);
  }
}

// ---------------------------------------------------------------------------
// The /manage list (`authoringList`, §B3)

const LIST_STATUSES = ["draft", "published", "modified", "scheduled", "failed"] as const;
type ListStatus = (typeof LIST_STATUSES)[number];
const OWNER_FILTERS = ["department", "moderators"] as const;
/** documentIds per `$in` (well below every bind limit). */
export const LIST_CHUNK = 200;
/** The highest page the list serves (a bound on `page`, not on the rows). */
const MAX_PAGE = 10_000;

interface ListQuery {
  status?: ListStatus;
  q?: string;
  page: number;
  owner?: (typeof OWNER_FILTERS)[number];
  /** Wiki pages: the space's documentId. */
  space?: string;
  /** Lessons: filter by the parent before pagination and count. */
  course?: string;
}

/** Which keys a type's list takes besides `q` and `page`. */
export interface ListKeys {
  /** `status` (every type but wiki spaces, which are always published). */
  status?: boolean;
  /** `owner` (moderators of the department-authored types). */
  owner?: boolean;
  /** `space` (wiki pages). */
  space?: boolean;
  /** `course` (lessons). */
  course?: boolean;
}

/** A space documentId as the list filter takes it (the documentId shape of entry-id.ts). */
const SPACE_FILTER = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The list's query (status, q, page; owner for moderators of the owned
 * types; space for wiki pages; wiki spaces without status); 400 otherwise.
 * A boolean second argument is the batch-15 form: `owner` allowed or not.
 */
export function parseListQuery(
  query: Record<string, unknown> | undefined,
  keys: boolean | ListKeys,
): ListQuery {
  const options: ListKeys = typeof keys === "boolean" ? { status: true, owner: keys } : keys;
  const allowOwner = options.owner === true;
  const allowed = [
    "q",
    "page",
    ...(options.status === false ? [] : ["status"]),
    ...(allowOwner ? ["owner"] : []),
    ...(options.space ? ["space"] : []),
    ...(options.course ? ["course"] : []),
  ];
  const raw = query ?? {};
  const refused = Object.keys(raw).filter((key) => !allowed.includes(key));
  const codes: Record<string, string> = {};
  const out: ListQuery = { page: 1 };
  if (raw.status !== undefined && allowed.includes("status")) {
    if (
      typeof raw.status === "string" &&
      (LIST_STATUSES as readonly string[]).includes(raw.status)
    ) {
      out.status = raw.status as ListStatus;
    } else refused.push("status");
  }
  if (raw.q !== undefined) {
    if (typeof raw.q === "string" && raw.q.length <= AUTHORING_LIST_MAX_QUERY) {
      if (raw.q.trim() !== "") out.q = raw.q.trim();
    } else {
      refused.push("q");
      if (typeof raw.q === "string") codes.q = "tooLong";
    }
  }
  if (raw.page !== undefined) {
    const page =
      typeof raw.page === "string" && /^\d{1,5}$/.test(raw.page) ? Number(raw.page) : NaN;
    if (Number.isInteger(page) && page >= 1 && page <= MAX_PAGE) out.page = page;
    else refused.push("page");
  }
  if (options.space && raw.space !== undefined) {
    if (typeof raw.space === "string" && SPACE_FILTER.test(raw.space)) out.space = raw.space;
    else refused.push("space");
  }
  if (options.course && raw.course !== undefined) {
    if (isDocumentId(raw.course)) out.course = raw.course;
    else refused.push("course");
  }
  if (allowOwner && raw.owner !== undefined) {
    if (typeof raw.owner === "string" && (OWNER_FILTERS as readonly string[]).includes(raw.owner)) {
      out.owner = raw.owner as ListQuery["owner"];
    } else refused.push("owner");
  }
  if (refused.length > 0) refuseKeys(refused, codes);
  return out;
}

export const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * Every revision of `uid`'s documents (a document without a version row:
 * 0). The list reads them BEFORE the rows (Codex review of 15A, finding
 * 2): the reads are separate statements, and a write that commits between
 * them must leave the list with newer content under an older version (its
 * next write answers 412 and the client reloads), never with older content
 * under the newer version, which would authorise a change the caller never
 * saw. A document created in between has no version here: 0, which no
 * stored revision matches. `documentIds` narrows the read to those
 * documents (the list's page, v0.31); without it the read is type-wide.
 */
export async function revisionsOf(
  strapi: AuthoringControllerHost,
  uid: string,
  documentIds?: readonly string[],
): Promise<Map<string, number>> {
  const revisions = new Map<string, number>();
  if (documentIds?.length === 0) return revisions;
  const rows = (await strapi.db.query(CONTENT_VERSION_UID).findMany({
    where: {
      targetUid: uid,
      ...(documentIds ? { targetDocumentId: { $in: [...documentIds] } } : {}),
    },
    select: ["targetDocumentId", "revision"],
  })) as Record<string, unknown>[];
  for (const row of rows) {
    const revision = Number(row.revision);
    if (typeof row.targetDocumentId === "string" && Number.isInteger(revision)) {
      revisions.set(row.targetDocumentId, revision);
    }
  }
  return revisions;
}

/** The drafts the list may show: a department author's own, then the owner, space and course filters. */
function listWhere(gate: AuthoringGate, query: ListQuery): Record<string, unknown> {
  const where: Record<string, unknown> = { publishedAt: { $null: true } };
  if (gate.roleClass === DEPARTMENT_AUTHOR_CLASS && gate.callerDepartment) {
    where.ownerDepartment = { id: gate.callerDepartment.id };
  } else if (query.owner === "department") {
    where.ownerDepartment = { id: { $notNull: true } };
  } else if (query.owner === "moderators") {
    where.ownerDepartment = { id: { $null: true } };
  }
  if (query.space !== undefined) where.space = { documentId: query.space };
  if (query.course !== undefined) where.course = { documentId: query.course };
  return where;
}

/** `q`: the draft's label contains it, ignoring case (in JS, not in SQL: one rule on both engines). */
function labelMatches(spec: AuthoringSpec, q: string | undefined) {
  const needle = q?.toLowerCase();
  return (row: Record<string, unknown>): boolean => {
    if (!needle) return true;
    const label = row[spec.labelField];
    return typeof label === "string" && label.toLowerCase().includes(needle);
  };
}

// The columns a list row needs (never a Markdown body): the label, the
// state and schedule, and the targeting flags.
const listSelect = (spec: AuthoringSpec): string[] => [
  "id",
  "documentId",
  "publishedAt",
  "updatedAt",
  spec.labelField,
  ...(spec.scheduled ? ["publishAt", "scheduleError"] : []),
  ...(spec.unpublishScheduled ? ["unpublishAt"] : []),
  ...spec.flagColumns,
  ...(spec.listColumns ?? []),
];

/**
 * The drafts with their published twins. A twin is read by documentId
 * alone, never by the list's filters: a draft moved to another space keeps
 * its published row in the old one, and that row still decides its status.
 */
async function withPublished(
  strapi: AuthoringControllerHost,
  spec: AuthoringSpec,
  drafts: readonly AuthoringRow[],
): Promise<AuthoringRows[]> {
  const published = new Map<string, AuthoringRow>();
  for (const chunk of chunks(
    drafts.map((row) => row.documentId),
    LIST_CHUNK,
  )) {
    const rows = (await strapi.db.query(spec.uid).findMany({
      where: { documentId: { $in: chunk }, publishedAt: { $notNull: true } },
      select: listSelect(spec),
      populate: AUTHORING_POPULATE[spec.uid] ?? {},
    })) as AuthoringRow[];
    for (const row of rows) published.set(row.documentId, row);
  }
  return drafts.map((draft) => ({
    documentId: draft.documentId,
    draft,
    published: published.get(draft.documentId) ?? null,
  }));
}

/** Every document of `uid` the list may show, as rows (unsorted). */
async function listDocuments(
  strapi: AuthoringControllerHost,
  spec: AuthoringSpec,
  gate: AuthoringGate,
  query: ListQuery,
): Promise<AuthoringRows[]> {
  const drafts = (
    (await strapi.db.query(spec.uid).findMany({
      where: listWhere(gate, query),
      select: listSelect(spec),
      populate: AUTHORING_POPULATE[spec.uid] ?? {},
    })) as unknown[]
  )
    .filter(isRecord)
    .filter(labelMatches(spec, query.q)) as AuthoringRow[];
  const documents = await withPublished(strapi, spec, drafts);
  return gate.roleClass === DEPARTMENT_AUTHOR_CLASS
    ? documents.filter((rows) => departmentAuthorOwns(spec.uid, rows, gate.callerDepartment))
    : documents;
}

/** The list's order: the newest draft first (no readable updatedAt: last), then documentId. */
function newestDraftFirst(a: AuthoringRows, b: AuthoringRows): number {
  const delta = (ms(b.draft?.updatedAt) ?? 0) - (ms(a.draft?.updatedAt) ?? 0);
  return delta !== 0 ? delta : a.documentId.localeCompare(b.documentId);
}

const pageOf = <T>(items: readonly T[], page: number): T[] =>
  items.slice((page - 1) * AUTHORING_LIST_PAGE_SIZE, page * AUTHORING_LIST_PAGE_SIZE);

/** One page of the list, its total and the revisions of its documents. */
interface ListPage {
  total: number;
  page: AuthoringRows[];
  revisions: Map<string, number>;
}

/**
 * The list without a light path (a `status` filter needs both rows of
 * every document; a department author's rule reads the relations): every
 * revision of the type, then every document, then the page.
 */
async function fullListPage(
  strapi: AuthoringControllerHost,
  spec: AuthoringSpec,
  gate: AuthoringGate,
  query: ListQuery,
): Promise<ListPage> {
  // Versions first, then the rows (see revisionsOf).
  const revisions = await revisionsOf(strapi, spec.uid);
  const documents = (await listDocuments(strapi, spec, gate, query))
    .filter((rows) => listStatusMatches(rows, query.status))
    .sort(newestDraftFirst);
  return { total: documents.length, page: pageOf(documents, query.page), revisions };
}

/**
 * The list's light path (#170, v0.31): only the page's documents are read
 * in full. Three reads, in this order:
 *  1. every matching draft's documentId, updatedAt and label (listWhere and
 *     `q` as the full path), sorted by newestDraftFirst: the total and the
 *     page's documentIds;
 *  2. the revisions of exactly those documents;
 *  3. their drafts and published twins with every list column, read AFTER
 *     the revisions (the version rule of revisionsOf). A draft gone in
 *     between leaves the page; the total stays the one of step 1.
 */
async function lightListPage(
  strapi: AuthoringControllerHost,
  spec: AuthoringSpec,
  gate: AuthoringGate,
  query: ListQuery,
): Promise<ListPage> {
  const light = (
    (await strapi.db.query(spec.uid).findMany({
      where: listWhere(gate, query),
      select: ["documentId", "updatedAt", spec.labelField],
    })) as unknown[]
  )
    .filter(isRecord)
    .filter(labelMatches(spec, query.q)) as AuthoringRow[];
  const ordered = light
    .map((draft) => ({ documentId: draft.documentId, draft, published: null }))
    .sort(newestDraftFirst);
  const ids = pageOf(ordered, query.page).map((rows) => rows.documentId);
  const revisions = await revisionsOf(strapi, spec.uid, ids);
  const drafts =
    ids.length === 0
      ? []
      : ((await strapi.db.query(spec.uid).findMany({
          where: { documentId: { $in: ids }, publishedAt: { $null: true } },
          select: listSelect(spec),
          populate: AUTHORING_POPULATE[spec.uid] ?? {},
        })) as AuthoringRow[]);
  const byId = new Map(drafts.map((draft) => [draft.documentId, draft]));
  const present = ids.flatMap((id) => {
    const draft = byId.get(id);
    return draft ? [draft] : [];
  });
  return { total: ordered.length, page: await withPublished(strapi, spec, present), revisions };
}

function listStatusMatches(rows: AuthoringRows, status: ListStatus | undefined): boolean {
  if (!status) return true;
  if (status === "scheduled") return rows.draft?.publishAt != null;
  if (status === "failed") return typeof rows.draft?.scheduleError === "string";
  return documentStatus(rows.draft, rows.published) === status;
}

/** The page documents of each space (any row of a page linking any row of the space). */
export async function spacePageCounts(
  strapi: AuthoringControllerHost,
  spaceDocumentIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (spaceDocumentIds.length === 0) return counts;
  const pages = new Map<string, Set<string>>();
  for (const chunk of chunks(spaceDocumentIds, LIST_CHUNK)) {
    const rows = (await strapi.db.query(WIKI_PAGE_UID).findMany({
      where: { space: { documentId: { $in: chunk } } },
      select: ["documentId"],
      populate: { space: { select: ["documentId"] } },
    })) as unknown[];
    for (const row of rows) {
      if (!isRecord(row) || typeof row.documentId !== "string") continue;
      const space = documentIdOf(row.space);
      if (!space) continue;
      const set = pages.get(space) ?? new Set<string>();
      set.add(row.documentId);
      pages.set(space, set);
    }
  }
  for (const [space, set] of pages) counts.set(space, set.size);
  return counts;
}

function listRow(
  spec: AuthoringSpec,
  rows: AuthoringRows,
  revision: number,
  pageCounts?: ReadonlyMap<string, number>,
): AuthoringListRow & Record<string, unknown> {
  const draft = rows.draft ?? ({} as AuthoringRow);
  const owned = DEPARTMENT_AUTHORED_UIDS.includes(spec.uid);
  return {
    documentId: rows.documentId,
    label: text(draft[spec.labelField]) ?? "",
    status: documentStatus(rows.draft, rows.published),
    publishedAt: iso(rows.published?.publishedAt),
    updatedAt: iso(draft.updatedAt),
    version: String(revision),
    ...scheduleFields(spec, draft),
    authorName: spec.authorField ? displayNameOf(draft[spec.authorField]) : null,
    ...(owned ? { ownerDepartment: ownerOf(draft) } : {}),
    needsRetarget: needsRetarget(spec.uid, rows),
    ...(spec.uid === LESSON_UID
      ? {
          course: trainingCourseRefOf(draft.course),
          order: typeof draft.order === "number" ? draft.order : 0,
        }
      : {}),
    ...(spec.uid === WIKI_SPACE_UID
      ? {
          slug: text(draft.slug) ?? "",
          icon: text(draft.icon),
          visibility: text(draft.visibility) ?? "public",
          pageCount: pageCounts?.get(rows.documentId) ?? 0,
        }
      : {}),
    ...(spec.uid === WIKI_PAGE_UID
      ? {
          slug: text(draft.slug) ?? "",
          space: documentIdOf(draft.space),
          parent: documentIdOf(draft.parent),
          order: typeof draft.order === "number" ? draft.order : 0,
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// The actions

/**
 * Whether a class may discard a document that has no published row (which
 * deletes it, C20): moderators, and a wiki page's author (§J2). Department
 * authors never (§N2); a wiki page's department head and team lead neither.
 */
export function mayDeleteByDiscard(roleClass: string | null | undefined): boolean {
  return roleClass === MODERATOR_CLASS || roleClass === "author";
}

/** A controller action as Strapi calls it (Koa's context; typed inside as AuthoringContext). */
export type AuthoringHandler = (ctx: unknown) => Promise<void>;

/**
 * The actions of `uid`'s authoring controller, spread into
 * createCoreController: `authoringActions(strapi, UID)` with the Strapi
 * instance of the controller factory.
 */
export function authoringActions(strapi: unknown, uid: string): Record<string, AuthoringHandler> {
  const actions = authoringActionsFor(strapi as AuthoringControllerHost, uid);
  return Object.fromEntries(
    Object.entries(actions)
      .filter((entry): entry is [string, Action] => typeof entry[1] === "function")
      .map(([name, action]) => [name, (ctx: unknown) => action(ctx as AuthoringContext)]),
  );
}

/**
 * A mutation of an existing document inside an authoring scope and one
 * transaction (§G): the client's `If-Match`, what the gate saw and its
 * classifier go into the scope, the document lock compares under the lock,
 * and the answer is the DTO read inside the transaction (204 when `run`
 * deleted the document).
 */
export async function runDocumentMutation(
  strapi: AuthoringControllerHost,
  spec: AuthoringSpec,
  ctx: AuthoringContext,
  gate: AuthoringGate,
  missingClass: 403 | 404,
  run: (scope: AuthoringScope) => Promise<"deleted" | void>,
): Promise<void> {
  const expectedRevision = parseIfMatch(ctx.get("If-Match"));
  const documentId = gate.documentId as string;
  const scope: AuthoringScope = {
    uid: spec.uid,
    documentId,
    expectedRevision,
    observedRevision: gate.observedRevision,
    classify: gate.classify,
    roleClass: gate.roleClass,
    missingClass,
    source: "content-api",
  };
  const answer = await strapi.db.transaction(async () =>
    runInAuthoringScope(scope, async () => {
      const outcome = await run(scope);
      if (outcome === "deleted") return null;
      return resultDto(strapi, spec, documentId, scope.committedRevision ?? 0);
    }),
  );
  if (answer === null) {
    ctx.status = 204;
    ctx.body = null;
    return;
  }
  ctx.set("ETag", etagOf(Number(answer.version)));
  ctx.status = 200;
  ctx.body = { data: answer };
}

/**
 * Runs a wiki-page write inside `wikiEditContext` (contract K16): the
 * editor is the caller, the edit note is `data.revisionSummary` (a
 * controller field the allowlist admitted; it is no attribute, so it leaves
 * the payload here), `restoredFrom` names a restored revision. Other types
 * run `fn` as it is.
 */
export function withWikiEdit<T>(
  uid: string,
  gate: AuthoringGate,
  data: Record<string, unknown> | null,
  fn: () => Promise<T>,
  restoredFrom?: number,
): Promise<T> {
  if (uid !== WIKI_PAGE_UID) return fn();
  let revisionSummary: string | undefined;
  if (data && "revisionSummary" in data) {
    if (typeof data.revisionSummary === "string") revisionSummary = data.revisionSummary;
    delete data.revisionSummary;
  }
  return wikiEditContext.run(
    {
      editorId: gate.callerId,
      ...(revisionSummary !== undefined ? { revisionSummary } : {}),
      ...(restoredFrom !== undefined ? { restoredFrom } : {}),
    },
    fn,
  );
}

/** The typed actions (authoringActions wraps them for Strapi). */
export function authoringActionsFor(
  strapi: AuthoringControllerHost,
  uid: string,
): AuthoringActions {
  const spec = AUTHORING_SPECS[uid];
  if (!spec) throw new Error(`authoring controller: ${uid} is not an authored type`);
  const documents = () => strapi.documents(uid);
  // No `fields` on the Document Service call: the answer is built from the
  // rows read afterwards, and `fields` would also narrow the rows the
  // lifecycles see (an afterCreate without `publishedAt` notifies nobody).

  const mutate = (
    ctx: AuthoringContext,
    gate: AuthoringGate,
    missingClass: 403 | 404,
    run: (scope: AuthoringScope) => Promise<"deleted" | void>,
  ) => runDocumentMutation(strapi, spec, ctx, gate, missingClass, run);

  const actions: AuthoringActions = {
    async create(ctx) {
      await answering(ctx, async () => {
        const gate = gateFor(ctx, uid, "create");
        const status = writeStatus(ctx.query, spec.statusMode);
        const data = payloadOf(ctx);
        const scope: AuthoringScope = { uid, roleClass: gate.roleClass, source: "content-api" };
        const answer = await strapi.db.transaction(async () =>
          runInAuthoringScope(scope, async () => {
            const created = await withWikiEdit(uid, gate, data, () =>
              documents().create({ data, status }),
            );
            const documentId = documentIdOf(created);
            if (!documentId)
              throw new Error(`authoring controller: ${uid} create returned no document`);
            return resultDto(strapi, spec, documentId, scope.committedRevision ?? 1);
          }),
        );
        ctx.set("ETag", etagOf(Number(answer.version)));
        ctx.status = 201;
        ctx.body = { data: answer };
      });
    },

    async update(ctx) {
      await answering(ctx, async () => {
        const gate = gateFor(ctx, uid, "update");
        const status = writeStatus(ctx.query, spec.statusMode);
        const data = payloadOf(ctx);
        await mutate(ctx, gate, 403, async (scope) => {
          await withWikiEdit(uid, gate, data, () =>
            documents().update({ documentId: scope.documentId, data, status }),
          );
        });
      });
    },

    async delete(ctx) {
      await answering(ctx, async () => {
        noQuery(ctx.query);
        const ref = parseEntryRef(ctx.params.id);
        const row = ref
          ? await strapi.db.query(uid).findOne({ where: ref, select: ["id", "documentId"] })
          : null;
        const documentId = documentIdOf(row);
        if (!documentId) throw new errors.NotFoundError("Not Found");
        const expectedRevision = parseIfMatch(ctx.get("If-Match"));
        // is-admin-or-editor is the gate; the lock compares the token only.
        const scope: AuthoringScope = {
          uid,
          documentId,
          expectedRevision,
          roleClass: MODERATOR_CLASS,
          missingClass: 404,
          source: "content-api",
        };
        await strapi.db.transaction(async () =>
          runInAuthoringScope(scope, () => documents().delete({ documentId })),
        );
        ctx.status = 204;
        ctx.body = null;
      });
    },

    async authoringList(ctx) {
      const gate = gateFor(ctx, uid, "authoringList");
      const owned = DEPARTMENT_AUTHORED_UIDS.includes(uid);
      const query = parseListQuery(ctx.query, {
        status: uid !== WIKI_SPACE_UID,
        owner: owned && gate.roleClass === MODERATOR_CLASS,
        space: uid === WIKI_PAGE_UID,
        course: uid === LESSON_UID,
      });
      // The light path whenever the page follows from the drafts alone.
      const { total, page, revisions } =
        query.status === undefined && gate.roleClass !== DEPARTMENT_AUTHOR_CLASS
          ? await lightListPage(strapi, spec, gate, query)
          : await fullListPage(strapi, spec, gate, query);
      const pageSize = AUTHORING_LIST_PAGE_SIZE;
      const pageCounts =
        uid === WIKI_SPACE_UID
          ? await spacePageCounts(
              strapi,
              page.map((rows) => rows.documentId),
            )
          : undefined;
      ctx.status = 200;
      ctx.body = {
        data: page.map((rows) =>
          listRow(spec, rows, revisions.get(rows.documentId) ?? 0, pageCounts),
        ),
        meta: {
          pagination: {
            page: query.page,
            pageSize,
            pageCount: Math.max(1, Math.ceil(total / pageSize)),
            total,
          },
        },
      };
    },

    async editable(ctx) {
      noQuery(ctx.query);
      const gate = gateFor(ctx, uid, "editable");
      const rows = gate.rows as AuthoringRows;
      const version = gate.observedRevision ?? 0;
      ctx.set("ETag", etagOf(version));
      ctx.status = 200;
      ctx.body = {
        data: {
          documentId: rows.documentId,
          version: String(version),
          status: documentStatus(rows.draft, rows.published),
          publishedAt: iso(rows.published?.publishedAt),
          updatedAt: iso(rows.draft?.updatedAt),
          roleClass: gate.roleClass,
          // The preview's author (batch 16, S13): the author, organiser or
          // uploader; null for types without one and panel-made items.
          authorName: spec.authorField ? displayNameOf(rows.draft?.[spec.authorField]) : null,
          ...(await editableFields(strapi, uid, rows, gate.roleClass)),
        },
      };
    },
  };

  /** A custom document action: no query, the gate's decision, then `run` (a lost class: 404). */
  const documentAction =
    (
      intent: "publish" | "unpublish" | "discardDraft",
      run: (scope: AuthoringScope, gate: AuthoringGate) => Promise<"deleted" | void>,
    ): Action =>
    async (ctx) => {
      await answering(ctx, async () => {
        noQuery(ctx.query);
        const gate = gateFor(ctx, uid, intent);
        await mutate(ctx, gate, 404, (scope) => run(scope, gate));
      });
    };

  if (spec.statusMode === "explicit") {
    actions.publish = documentAction("publish", async (scope) => {
      await documents().publish({ documentId: scope.documentId });
    });

    actions.unpublish = documentAction("unpublish", async (scope) => {
      await documents().unpublish({ documentId: scope.documentId });
    });

    actions.discardDraft = documentAction("discardDraft", async (scope, gate) => {
      const documentId = scope.documentId as string;
      if (isTrainingUid(uid) || !mayDeleteByDiscard(gate.roleClass)) {
        // Under the document's lock and after the lock's own checks, in
        // its order (amendment row A1; K2 since 15B a3bfd5c: the class
        // on every scoped mutation, then the tokens): a discard without
        // a published row would delete the document, which department
        // authors and training never do, and on a wiki page only its author and
        // moderators may (§J2). A caller who lost the class learns
        // nothing here, not even with current tokens.
        const locked = await lockDocument(strapi, uid, documentId);
        const roleClass = scope.classify ? await scope.classify({ uid, documentId }) : null;
        if (!roleClass) throw new ClassLost(404);
        if (locked !== scope.expectedRevision || locked !== scope.observedRevision) {
          throw new RevisionStale(locked);
        }
        const published = await strapi.db
          .query(uid)
          .count({ where: { documentId, publishedAt: { $notNull: true } } });
        if (published === 0 && (isTrainingUid(uid) || !mayDeleteByDiscard(roleClass))) {
          // The page's other row classes: like a page they have no class on.
          if (!isTrainingUid(uid) && roleClass !== DEPARTMENT_AUTHOR_CLASS)
            throw new ClassLost(404);
          throw new errors.ValidationError("There is no published version to return to", {
            keys: [FORM_KEY],
            codes: { [FORM_KEY]: "neverPublished" },
          });
        }
      }
      await documents().discardDraft({ documentId });
      const remaining = await strapi.db.query(uid).count({ where: { documentId } });
      return remaining === 0 ? "deleted" : undefined;
    });
  }

  return actions;
}
