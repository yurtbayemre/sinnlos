import type { AuthoringRoleClass } from "./fields.js";

/**
 * The response shapes of v2 authoring (deep-dive decision 06 §B3; batch 15
 * plan, contract K7). The cms authoring controller builds every response
 * itself from the rows it read (never from a client `populate` or
 * `fields`); the web types its transport with these. Instants are ISO-8601
 * strings with `Z`, calendar dates `YYYY-MM-DD`, relations documentIds,
 * audience roles role types.
 *
 * `version` is the document revision (§G) as a decimal string, opaque to
 * the web: it goes back unchanged as `If-Match: "<version>"` (http.ts) and
 * equals the response's `ETag` without its quotes.
 */

/**
 * The publication state of a document (§B3, the Content Manager's rule):
 *   - draft: no published row;
 *   - published: a published row, and the draft not saved after it;
 *   - modified: a published row, and the draft saved after it (draft
 *     `updatedAt` > published `updatedAt`): "Changes pending".
 */
export type AuthoringDocumentStatus = "draft" | "published" | "modified";

export const AUTHORING_DOCUMENT_STATUSES: readonly AuthoringDocumentStatus[] = [
  "draft",
  "published",
  "modified",
];

/** The write the `?status=` of a create or update asks for (explicit types). */
export type AuthoringWriteStatus = "draft" | "published";

/** The department that owns a department author's item (§N3), as lists and forms show it. */
export interface OwnerDepartment {
  documentId: string;
  name: string;
}

/**
 * `data` of every write answer (create, update, publish, unpublish,
 * discard-draft): the document after the write. The scheduled types add
 * `publishAt` and `scheduleError`, documents and quick links `unpublishAt`.
 */
export interface AuthoringResult {
  documentId: string;
  version: string;
  status: AuthoringDocumentStatus;
  /** The published row's `publishedAt`, or null without one. */
  publishedAt: string | null;
  publishAt?: string | null;
  unpublishAt?: string | null;
  scheduleError?: string | null;
}

/** The answer of a write: `{ data }`, with `ETag: "<version>"`. */
export interface AuthoringWriteResponse {
  data: AuthoringResult;
}

/** One row of `GET /api/<plural>/authoring`. */
export interface AuthoringListRow {
  documentId: string;
  /** The type's label field: `title` (announcement, event, document), `label` (quick link), `question` (poll). */
  label: string;
  status: AuthoringDocumentStatus;
  publishedAt: string | null;
  /** The draft's last save. */
  updatedAt: string | null;
  version: string;
  /** Scheduled types only (not poll). */
  publishAt?: string | null;
  /** Documents and quick links only. */
  unpublishAt?: string | null;
  /** Scheduled types only: the code of a failed scheduled publish. */
  scheduleError?: string | null;
  /** The display name of the author (announcement, poll), organiser (event) or uploader (document); quick links have none. */
  authorName: string | null;
  /** Announcement, event and document: the owning department, or null for moderator content. */
  ownerDepartment?: OwnerDepartment | null;
  /**
   * A targeting flag is set but no target is left, or the announcement
   * carries `retargetRequired` (§N9): readable by moderators only and
   * notified to nobody until re-targeted ("Needs re-targeting").
   */
  needsRetarget: boolean;
}

export interface AuthoringPagination {
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
}

/** The answer of `GET /api/<plural>/authoring`. */
export interface AuthoringListResponse {
  data: AuthoringListRow[];
  meta: { pagination: AuthoringPagination };
}

/** The list filter `owner` (moderators only): department-owned items, or moderator content. */
export type AuthoringOwnerFilter = "department" | "moderators";

/** The list filter `status`. `scheduled`: a pending `publishAt`; `failed`: a `scheduleError`. */
export type AuthoringListStatusFilter = AuthoringDocumentStatus | "scheduled" | "failed";

/** A media value as `editable` shows it. */
export interface EditableMedia {
  id: number;
  name: string;
  mime: string;
  /** Kilobytes, as Strapi stores it. */
  size: number;
  url: string;
}

/** What every `editable` answer carries besides the type's fields. */
export interface EditableBase {
  documentId: string;
  version: string;
  status: AuthoringDocumentStatus;
  publishedAt: string | null;
  updatedAt: string | null;
  /** The class the caller edits as: the form offers exactly that class's fields (fields.ts). */
  roleClass: AuthoringRoleClass;
}

export interface AnnouncementEditable extends EditableBase {
  title: string;
  body: string | null;
  expiresAt: string | null;
  department: string | null;
  team: string | null;
  /** Role types (`member`, `team_lead`, ...). */
  audienceRoles: string[];
  ownerDepartment: OwnerDepartment | null;
  needsRetarget: boolean;
  /** Moderators only (absent for a department author). */
  pinned?: boolean;
  requiresAck?: boolean;
  ackDeadline?: string | null;
  publishAt?: string | null;
  scheduleError?: string | null;
}

export interface EventEditable extends EditableBase {
  title: string;
  description: string | null;
  start: string;
  end: string | null;
  allDay: boolean;
  location: string | null;
  url: string | null;
  rsvpEnabled: boolean;
  capacity: number | null;
  /** The departments to notify (documentIds); readability stays calendar-wide. */
  departments: string[];
  ownerDepartment: OwnerDepartment | null;
  needsRetarget: boolean;
  /** Moderators only. */
  publishAt?: string | null;
  scheduleError?: string | null;
}

export interface QuickLinkEditable extends EditableBase {
  label: string;
  url: string;
  icon: string | null;
  category: string;
  order: number;
  departments: string[];
  needsRetarget: boolean;
  publishAt: string | null;
  unpublishAt: string | null;
  scheduleError: string | null;
}

export interface DocumentEditable extends EditableBase {
  title: string;
  description: string | null;
  category: string;
  departments: string[];
  /** Read-only until batch 16 (set in the admin panel). */
  file: EditableMedia | null;
  ownerDepartment: OwnerDepartment | null;
  needsRetarget: boolean;
  /** Moderators only. */
  publishAt?: string | null;
  unpublishAt?: string | null;
  scheduleError?: string | null;
}

export interface PollEditable extends EditableBase {
  question: string;
  options: string[];
  closesAt: string | null;
  anonymous: boolean;
  departments: string[];
  visibleToGuests: boolean;
  guestsCanVote: boolean;
  needsRetarget: boolean;
  /** A vote exists: `options` and `anonymous` are frozen (frozenAfterVotes). */
  hasVotes: boolean;
}

/** The answer of `GET /api/<plural>/:documentId/editable`, with `ETag: "<version>"`. */
export interface EditableResponse<T extends EditableBase> {
  data: T;
}
