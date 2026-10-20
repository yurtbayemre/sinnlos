import type { AuthoringRoleClass, OrgEditorClass } from "./fields.js";
import type { WikiEditorClass, WikiSpaceVisibility } from "./wiki.js";

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
  /**
   * The display name of the item's author (announcement, poll, wiki page),
   * organiser (event) or uploader (document), for the preview (batch 16,
   * K18). null for quick links, wiki spaces and items created in the admin
   * panel without one. Optional: a cms before batch 16 does not send it.
   */
  authorName?: string | null;
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

/**
 * A duty plan (v0.18): its shift templates and shifts as the cms stores them
 * (the shapes of duty.ts DutyShiftTemplate and DutyShift, spelled out: this
 * module imports siblings only).
 */
export interface DutyPlanEditable extends EditableBase {
  name: string;
  note: string | null;
  /** The department (documentId), or null for a company-wide plan. */
  department: string | null;
  shiftTemplates: { label: string; start: string; end: string }[];
  shifts: { userId: number; startsAt: string; endsAt: string }[];
  ownerDepartment: OwnerDepartment | null;
}

export interface DocumentEditable extends EditableBase {
  title: string;
  description: string | null;
  category: string;
  departments: string[];
  /**
   * The draft's file. Since batch 16 writable: send a file row id from
   * POST /api/upload to attach a new upload (the caller's own, unattached;
   * else 400 `invalid` on `file`), the stored id to keep it, null to clear.
   */
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

// ---------------------------------------------------------------------------
// The wiki (batch 16, lane 16B; contract K18). Routes and fields: wiki.ts.

/** A wiki space as a page row or a draft row names it. */
export interface WikiSpaceRef {
  documentId: string;
  slug: string;
  name: string;
}

/** `data` of a wiki-space write: the result plus the (derived, fixed) slug. */
export interface WikiSpaceResult extends AuthoringResult {
  slug: string;
}

/**
 * `data` of a wiki-page write (create, update, createDraft, saveDraft,
 * publish, unpublish, discardDraft, restore): the result with the page's
 * `publishAt` and `scheduleError`, its slug and its space's slug (null when
 * the space is gone), so the web can link the published page.
 */
export interface WikiPageResult extends AuthoringResult {
  slug: string;
  spaceSlug: string | null;
}

/** `GET /api/wiki-spaces/:documentId/editable` (moderators). */
export interface WikiSpaceEditable extends EditableBase {
  name: string;
  slug: string;
  /** An icon key (icons.ts), or a legacy value the admin panel stored. */
  icon: string | null;
  description: string | null;
  visibility: WikiSpaceVisibility;
  /** Role types (`member`, `team_lead`, ...): who reads a `role` space. */
  allowedRoles: string[];
  department: string | null;
  team: string | null;
  /** The visibility's target is gone (a deleted department or team): only moderators read it. */
  needsRetarget: boolean;
  /** Page documents in the space: a space with pages cannot be deleted (`spaceNotEmpty`). */
  pageCount: number;
}

/** One row of `GET /api/wiki-spaces/authoring`: `label` is the space's name. */
export interface WikiSpaceListRow extends AuthoringListRow {
  slug: string;
  icon: string | null;
  visibility: WikiSpaceVisibility;
  pageCount: number;
}

export interface WikiSpaceListResponse {
  data: WikiSpaceListRow[];
  meta: { pagination: AuthoringPagination };
}

/**
 * `GET /api/wiki-pages/:documentId/editable` (the row classes and
 * moderators): the draft in the write shape. `parent` is a documentId of
 * the same space. `department`, `team`, `publishAt` and `scheduleError`
 * only for moderators, who write them.
 */
export interface WikiPageEditable extends Omit<EditableBase, "roleClass"> {
  /** The class the caller edits as (WIKI_FIELDS lists its keys). */
  roleClass: WikiEditorClass;
  title: string;
  slug: string;
  body: string | null;
  summary: string | null;
  tags: string[];
  tocEnabled: boolean;
  order: number;
  space: WikiSpaceRef | null;
  parent: string | null;
  /**
   * Whether the caller may discard while no published row exists (that
   * deletes the page): its author and moderators only (§J2).
   */
  canDiscardUnpublished: boolean;
  /** Moderators only. */
  department?: string | null;
  team?: string | null;
  publishAt?: string | null;
  scheduleError?: string | null;
}

/** One row of `GET /api/wiki-pages/authoring` (moderators): `label` is the title. */
export interface WikiPageListRow extends AuthoringListRow {
  slug: string;
  /** The space documentId (the list filters by `space`). */
  space: string | null;
  parent: string | null;
  order: number;
}

export interface WikiPageListResponse {
  data: WikiPageListRow[];
  meta: { pagination: AuthoringPagination };
}

/** One row of `GET /api/wiki-pages/drafts/mine`: the caller's pages with unpublished changes. */
export interface WikiMyDraftRow {
  documentId: string;
  title: string;
  slug: string;
  space: WikiSpaceRef | null;
  /** `draft`: no published row (never published, or unpublished); `modified`: changes pending. */
  status: Extract<AuthoringDocumentStatus, "draft" | "modified">;
  updatedAt: string | null;
  version: string;
}

export interface WikiMyDraftsResponse {
  data: WikiMyDraftRow[];
}

/**
 * The kind of a history entry: `after` and `baseline` hold the page's
 * title, body and summary at that point (a save, or the state at an
 * upgrade); `before` is a legacy entry from before batch 16 that holds only
 * the body before an edit ("state before an edit (older format)").
 */
export type WikiRevisionKind = "before" | "after" | "baseline";

/** Who saved a revision: a user, an admin-panel account, or nobody recorded (a baseline). */
export type WikiRevisionEditor = { id: number; displayName: string } | { admin: true } | null;

/** One entry of `GET /api/wiki-pages/:documentId/revisions`, newest first, without the body. */
export interface WikiRevisionEntry {
  id: number;
  createdAt: string;
  /** The page title at that point; null for a legacy `before` entry. */
  title: string | null;
  /** The edit note the editor gave (`revisionSummary`). */
  changeSummary: string | null;
  kind: WikiRevisionKind;
  editor: WikiRevisionEditor;
  /** The revision a restore brought back. */
  restoredFrom: number | null;
}

export interface WikiRevisionListResponse {
  data: WikiRevisionEntry[];
  meta: { pagination: AuthoringPagination };
}

/** `GET /api/wiki-pages/:documentId/revisions/:revisionId`: one entry with its content. */
export interface WikiRevisionDetail extends WikiRevisionEntry {
  body: string | null;
  /** The page summary at that point; null for a legacy `before` entry. */
  pageSummary: string | null;
}

// ---------------------------------------------------------------------------
// Batch 17 single-row organisation and activity contracts.

/** Raw descriptions stay unchanged when saving another field. No draft/publication state. */
export interface OrgEditableBase {
  documentId: string;
  version: string;
  updatedAt: string | null;
  name: string;
  slug: string;
  description: string | null;
  roleClass: OrgEditorClass;
}

export interface DepartmentEditable extends OrgEditableBase {
  roleClass: Exclude<OrgEditorClass, "teamLead">;
  color: string | null;
  /** Present only for the admin_role moderator. */
  headerImage?: EditableMedia | null;
}

export interface TeamEditable extends OrgEditableBase {
  /** Present only for the admin_role moderator. */
  avatar?: EditableMedia | null;
}

export interface OrgEditableResponse<T extends OrgEditableBase> {
  data: T;
}

/** PUT /api/{departments,teams}/:id, with ETag matching version. */
export interface OrgWriteResponse {
  data: { documentId: string; version: string };
}

/** Existing audit vocabulary (cms/utils/audit.ts); no new recorder or grants. */
export type ActivityAction =
  | "create"
  | "update"
  | "delete"
  | "clone"
  | "publish"
  | "unpublish"
  | "discardDraft"
  | "restore"
  | "schedulePublish"
  | "scheduleUnpublish"
  | "scheduleFailed";

export type ActivityActorKind = "user" | "admin" | "system";
export type ActivitySource = "content-api" | "admin" | "cron" | "system";
export type ActivityActorClass = AuthoringRoleClass | WikiEditorClass;

export type ActivityTargetUid =
  | "api::announcement.announcement"
  | "api::event.event"
  | "api::quick-link.quick-link"
  | "api::document.document"
  | "api::poll.poll"
  | "api::duty-plan.duty-plan"
  | "api::wiki-space.wiki-space"
  | "api::wiki-page.wiki-page"
  | "api::course.course"
  | "api::lesson.lesson"
  | "api::department.department"
  | "api::team.team"
  | "api::classified.classified"
  | "plugin::upload.file";

/** No user/admin objects or email; deleted actors retain their kind, id and a display label. */
export interface ActivityActor {
  kind: ActivityActorKind;
  id: number | null;
  displayName: string;
  class: ActivityActorClass | null;
}

export interface ActivityListRow {
  id: number;
  createdAt: string;
  action: ActivityAction;
  targetUid: ActivityTargetUid;
  targetDocumentId: string;
  revision: number | null;
  source: ActivitySource;
  keys: string[];
  detail: string | null;
  actor: ActivityActor;
}

/** Newest createdAt first, then descending id; exact count and fixed page size 25. */
export interface ActivityListResponse {
  data: ActivityListRow[];
  meta: { pagination: AuthoringPagination };
}
