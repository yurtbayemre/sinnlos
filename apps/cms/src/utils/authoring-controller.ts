import {
  AUTHORING_LIST_MAX_QUERY,
  AUTHORING_LIST_PAGE_SIZE,
  AUTHORING_STATUS_MODES,
  FORM_KEY,
  STATUS_KEY,
  announcementNeedsRetarget,
  eventNeedsRetarget,
  scopedNeedsRetarget,
  type AuthoringDocumentStatus,
  type AuthoringListRow,
  type AuthoringStatusMode,
  type AuthoringType,
  type OwnerDepartment,
} from "@sinnlos/domain";
import { errors } from "@strapi/utils";
import {
  ANNOUNCEMENT_UID,
  DEPARTMENT_AUTHORED_UIDS,
  DOCUMENT_UID,
  EVENT_UID,
  QUICK_LINK_UID,
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
import { parseEntryRef } from "./entry-id";
import {
  AUTHORING_POPULATE,
  authoringGateOf,
  departmentAuthorOwns,
  loadDocumentRows,
  type AuthoringGate,
  type AuthoringRow,
  type AuthoringRows,
  type GateIntent,
} from "./write-gate";
import { DEPARTMENT_AUTHOR_CLASS, MODERATOR_CLASS, POLL_UID, refuseKeys } from "./write-allowlist";

/**
 * The authoring controller (deep-dive decision 06 §B3, §G, §N2; batch 15
 * plan items 1 and 6): create, update, publish, unpublish, discard-draft,
 * delete, the /manage list and the form read of announcement, event,
 * quick-link, document and poll, spread into each type's core controller
 * (api/<type>/controllers/<type>.ts). The HTTP contract is @sinnlos/domain
 * authoring/http.ts.
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
 * DISCARD (§N2, amendment row A1). A discard of a document without a
 * published row deletes it (C20). A moderator gets that (204); a department
 * author gets 400 `_form: neverPublished`, decided under the document's
 * lock, after the token check: department authors never delete.
 */

/** How each type's answers and forms are built. */
export interface AuthoringSpec {
  uid: string;
  type: AuthoringType;
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
}

export const AUTHORING_SPECS: Readonly<Record<string, AuthoringSpec>> = {
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
};

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

const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value !== "") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : new Date(ms).toISOString();
  }
  return null;
};

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

/** Runs `fn`; a lock refusal becomes its answer, anything else propagates. */
async function answering(ctx: AuthoringContext, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof DocumentLockError) {
      sendLockError(ctx, error);
      return;
    }
    throw error;
  }
}

/** The gate's decision for `intent`, or a 403 when the route was wired without it. */
function gateFor(ctx: AuthoringContext, uid: string, intent: GateIntent): AuthoringGate {
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
function noQuery(query: Record<string, unknown> | undefined): void {
  const keys = Object.keys(query ?? {});
  if (keys.length > 0) refuseKeys(keys);
}

/** The policy-checked payload (`data`). */
function payloadOf(ctx: AuthoringContext): Record<string, unknown> {
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

/** The write answer of a document (read inside the write's transaction). */
async function resultDto(
  strapi: AuthoringControllerHost,
  spec: AuthoringSpec,
  documentId: string,
  version: number,
) {
  const rows = (await strapi.db.query(spec.uid).findMany({
    where: { documentId },
    select: [
      "id",
      "documentId",
      "publishedAt",
      "updatedAt",
      ...(spec.scheduled ? ["publishAt", "scheduleError"] : []),
      ...(spec.unpublishScheduled ? ["unpublishAt"] : []),
    ],
  })) as Record<string, unknown>[];
  const draft = rows.find((row) => row.publishedAt == null) ?? null;
  const published = rows.find((row) => row.publishedAt != null) ?? null;
  return {
    documentId,
    version: String(version),
    status: documentStatus(draft, published),
    publishedAt: iso(published?.publishedAt),
    ...scheduleFields(spec, draft),
  };
}

const documentIdOf = (value: unknown): string | null =>
  isRecord(value) && typeof value.documentId === "string" ? value.documentId : null;

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

/** Whether a row is restricted with no target left (§N9), by type. */
export function rowNeedsRetarget(uid: string, row: Record<string, unknown> | null): boolean {
  if (!row) return false;
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

const displayNameOf = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  if (typeof value.displayName === "string" && value.displayName !== "") return value.displayName;
  return typeof value.username === "string" ? value.username : null;
};

// ---------------------------------------------------------------------------
// The form read (`editable`, §B3): the draft in the write shape

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const bool = (value: unknown): boolean => value === true;

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
      const file = isRecord(draft.file) ? draft.file : null;
      return {
        title: text(draft.title) ?? "",
        description: text(draft.description),
        category: text(draft.category) ?? "other",
        departments: documentIdsOf(draft.departments),
        file:
          file && typeof file.id === "number"
            ? {
                id: file.id,
                name: text(file.name) ?? "",
                mime: text(file.mime) ?? "",
                size: typeof file.size === "number" ? file.size : Number(file.size ?? 0),
                url: text(file.url) ?? "",
              }
            : null,
        ownerDepartment: ownerOf(draft),
        needsRetarget: retarget,
        ...(moderator
          ? {
              publishAt: iso(draft.publishAt),
              unpublishAt: iso(draft.unpublishAt),
              scheduleError: text(draft.scheduleError),
            }
          : {}),
      };
    }
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
      };
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
const LIST_CHUNK = 200;
/** The highest page the list serves (a bound on `page`, not on the rows). */
const MAX_PAGE = 10_000;

interface ListQuery {
  status?: ListStatus;
  q?: string;
  page: number;
  owner?: (typeof OWNER_FILTERS)[number];
}

/** The list's query (status, q, page; owner for moderators of the owned types); 400 otherwise. */
export function parseListQuery(
  query: Record<string, unknown> | undefined,
  allowOwner: boolean,
): ListQuery {
  const allowed = ["status", "q", "page", ...(allowOwner ? ["owner"] : [])];
  const raw = query ?? {};
  const refused = Object.keys(raw).filter((key) => !allowed.includes(key));
  const codes: Record<string, string> = {};
  const out: ListQuery = { page: 1 };
  if (raw.status !== undefined) {
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
  if (allowOwner && raw.owner !== undefined) {
    if (typeof raw.owner === "string" && (OWNER_FILTERS as readonly string[]).includes(raw.owner)) {
      out.owner = raw.owner as ListQuery["owner"];
    } else refused.push("owner");
  }
  if (refused.length > 0) refuseKeys(refused, codes);
  return out;
}

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** Every revision of `documentIds` of `uid` (0 without a version row). */
async function revisionsOf(
  strapi: AuthoringControllerHost,
  uid: string,
  documentIds: readonly string[],
): Promise<Map<string, number>> {
  const revisions = new Map<string, number>();
  for (const chunk of chunks(documentIds, LIST_CHUNK)) {
    const rows = (await strapi.db.query(CONTENT_VERSION_UID).findMany({
      where: { targetUid: uid, targetDocumentId: { $in: chunk } },
      select: ["targetDocumentId", "revision"],
    })) as Record<string, unknown>[];
    for (const row of rows) {
      const revision = Number(row.revision);
      if (typeof row.targetDocumentId === "string" && Number.isInteger(revision)) {
        revisions.set(row.targetDocumentId, revision);
      }
    }
  }
  return revisions;
}

/** Every document of `uid` the list may show, as rows, newest draft first. */
async function listDocuments(
  strapi: AuthoringControllerHost,
  spec: AuthoringSpec,
  gate: AuthoringGate,
  query: ListQuery,
): Promise<AuthoringRows[]> {
  const where: Record<string, unknown> = { publishedAt: { $null: true } };
  if (gate.roleClass === DEPARTMENT_AUTHOR_CLASS && gate.callerDepartment) {
    where.ownerDepartment = { id: gate.callerDepartment.id };
  } else if (query.owner === "department") {
    where.ownerDepartment = { id: { $notNull: true } };
  } else if (query.owner === "moderators") {
    where.ownerDepartment = { id: { $null: true } };
  }
  const populate = AUTHORING_POPULATE[spec.uid] ?? {};
  // The columns a list row needs (never a Markdown body): the label, the
  // state and schedule, and the targeting flags.
  const select = [
    "id",
    "documentId",
    "publishedAt",
    "updatedAt",
    spec.labelField,
    ...(spec.scheduled ? ["publishAt", "scheduleError"] : []),
    ...(spec.unpublishScheduled ? ["unpublishAt"] : []),
    ...spec.flagColumns,
  ];
  const drafts = (
    (await strapi.db.query(spec.uid).findMany({ where, select, populate })) as unknown[]
  )
    .filter(isRecord)
    .filter((row) => {
      if (!query.q) return true;
      const label = row[spec.labelField];
      return typeof label === "string" && label.toLowerCase().includes(query.q.toLowerCase());
    }) as AuthoringRow[];
  const published = new Map<string, AuthoringRow>();
  for (const chunk of chunks(
    drafts.map((row) => row.documentId),
    LIST_CHUNK,
  )) {
    const rows = (await strapi.db.query(spec.uid).findMany({
      where: { documentId: { $in: chunk }, publishedAt: { $notNull: true } },
      select,
      populate,
    })) as AuthoringRow[];
    for (const row of rows) published.set(row.documentId, row);
  }
  const documents = drafts.map((draft) => ({
    documentId: draft.documentId,
    draft,
    published: published.get(draft.documentId) ?? null,
  }));
  return gate.roleClass === DEPARTMENT_AUTHOR_CLASS
    ? documents.filter((rows) => departmentAuthorOwns(spec.uid, rows, gate.callerDepartment))
    : documents;
}

function listStatusMatches(rows: AuthoringRows, status: ListStatus | undefined): boolean {
  if (!status) return true;
  if (status === "scheduled") return rows.draft?.publishAt != null;
  if (status === "failed") return typeof rows.draft?.scheduleError === "string";
  return documentStatus(rows.draft, rows.published) === status;
}

function listRow(spec: AuthoringSpec, rows: AuthoringRows, revision: number): AuthoringListRow {
  const draft = rows.draft ?? ({} as AuthoringRow);
  const owned = (DEPARTMENT_AUTHORED_UIDS as readonly string[]).includes(spec.uid);
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
  };
}

// ---------------------------------------------------------------------------
// The actions

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

  /** A mutation of an existing document inside an authoring scope and one transaction. */
  const mutate = async (
    ctx: AuthoringContext,
    gate: AuthoringGate,
    missingClass: 403 | 404,
    run: (scope: AuthoringScope) => Promise<"deleted" | void>,
  ) => {
    const expectedRevision = parseIfMatch(ctx.get("If-Match"));
    const documentId = gate.documentId as string;
    const scope: AuthoringScope = {
      uid,
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
  };

  const actions: AuthoringActions = {
    async create(ctx) {
      await answering(ctx, async () => {
        const gate = gateFor(ctx, uid, "create");
        const status = writeStatus(ctx.query, spec.statusMode);
        const data = payloadOf(ctx);
        const scope: AuthoringScope = { uid, roleClass: gate.roleClass, source: "content-api" };
        const answer = await strapi.db.transaction(async () =>
          runInAuthoringScope(scope, async () => {
            const created = await documents().create({ data, status });
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
          await documents().update({ documentId: scope.documentId, data, status });
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
      const owned = (DEPARTMENT_AUTHORED_UIDS as readonly string[]).includes(uid);
      const query = parseListQuery(ctx.query, owned && gate.roleClass === MODERATOR_CLASS);
      const documentsList = (await listDocuments(strapi, spec, gate, query)).filter((rows) =>
        listStatusMatches(rows, query.status),
      );
      documentsList.sort((a, b) => {
        const delta = (ms(b.draft?.updatedAt) ?? 0) - (ms(a.draft?.updatedAt) ?? 0);
        return delta !== 0 ? delta : a.documentId.localeCompare(b.documentId);
      });
      const total = documentsList.length;
      const pageSize = AUTHORING_LIST_PAGE_SIZE;
      const page = documentsList.slice((query.page - 1) * pageSize, query.page * pageSize);
      const revisions = await revisionsOf(
        strapi,
        uid,
        page.map((rows) => rows.documentId),
      );
      ctx.status = 200;
      ctx.body = {
        data: page.map((rows) => listRow(spec, rows, revisions.get(rows.documentId) ?? 0)),
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
          ...(await editableFields(strapi, uid, rows, gate.roleClass)),
        },
      };
    },
  };

  if (spec.statusMode === "explicit") {
    actions.publish = async (ctx) => {
      await answering(ctx, async () => {
        noQuery(ctx.query);
        const gate = gateFor(ctx, uid, "publish");
        await mutate(ctx, gate, 404, async (scope) => {
          await documents().publish({ documentId: scope.documentId });
        });
      });
    };

    actions.unpublish = async (ctx) => {
      await answering(ctx, async () => {
        noQuery(ctx.query);
        const gate = gateFor(ctx, uid, "unpublish");
        await mutate(ctx, gate, 404, async (scope) => {
          await documents().unpublish({ documentId: scope.documentId });
        });
      });
    };

    actions.discardDraft = async (ctx) => {
      await answering(ctx, async () => {
        noQuery(ctx.query);
        const gate = gateFor(ctx, uid, "discardDraft");
        await mutate(ctx, gate, 404, async (scope) => {
          const documentId = scope.documentId as string;
          if (gate.roleClass === DEPARTMENT_AUTHOR_CLASS) {
            // Under the document's lock and after the token check
            // (amendment row A1): a discard without a published row
            // would delete the document, which department authors never
            // do. A caller who lost the class learns nothing here.
            const locked = await lockDocument(strapi, uid, documentId);
            if (locked !== scope.expectedRevision || locked !== scope.observedRevision) {
              const roleClass = scope.classify ? await scope.classify({ uid, documentId }) : null;
              if (!roleClass) throw new ClassLost(404);
              throw new RevisionStale(locked);
            }
            const published = await strapi.db
              .query(uid)
              .count({ where: { documentId, publishedAt: { $notNull: true } } });
            if (published === 0) {
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
      });
    };
  }

  return actions;
}

/** Re-exported for the controllers' tests. */
export { loadDocumentRows };
