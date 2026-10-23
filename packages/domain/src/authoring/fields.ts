/**
 * Who may write which field of which type (deep-dive decision 06 §A, §B1,
 * §N6; batch 15 plan, contract K7). The cms allowlist rules
 * (apps/cms/src/utils/write-allowlist.ts) carry exactly these keys per
 * (type, role class), pinned by its tests, and the web forms offer exactly
 * these fields per class. A key outside the list is refused with the
 * generic 400 (`details.keys`).
 *
 * The role classes (§B2, §N1):
 *   - `moderator`: admin_role and editor, on every phase-1 type;
 *   - `departmentAuthor`: a `department_head` with a `user.department`, on
 *     announcements, events and documents their department owns (§N3).
 *     No schedule, pinning or acknowledgement fields; the targeting is
 *     pinned to their department by the server (§N4).
 *
 * Never in any payload (server-derived or bookkeeping): `audience`,
 * `notifyAudience`, `retargetRequired` (targeting flags, raised by the
 * server and re-derived only from an explicit targeting key), `author`,
 * `organizer`, `uploadedBy` (the caller, on create), `ownerDepartment` (the
 * department author's department, on create), `scheduleError` (the
 * scheduler), Strapi's own keys.
 *
 * `document.file` is in both document lists since batch 16 (lane 16B,
 * contract K18): a file row id from POST /api/upload (uploads.ts), checked
 * as the caller's own fresh upload when it is newly attached; the stored
 * file passes unchecked (keeping is not attaching), and `null` clears it.
 * The wiki types have their own lists (wiki.ts).
 */

/** The phase-1 authored types, by their web area name. */
export const AUTHORING_TYPES = [
  "announcement",
  "event",
  "quickLink",
  "document",
  "poll",
  "dutyPlan",
  "kpi",
] as const;

export type AuthoringType = (typeof AUTHORING_TYPES)[number];

/** The role classes of the write gate (§B2). */
export const AUTHORING_ROLE_CLASSES = ["moderator", "departmentAuthor"] as const;

export type AuthoringRoleClass = (typeof AUTHORING_ROLE_CLASSES)[number];

/** The types department authors write for their own department (§N2). */
export const DEPARTMENT_AUTHORED_TYPES: readonly AuthoringType[] = [
  "announcement",
  "event",
  "document",
  "dutyPlan",
  "kpi",
];

export const ANNOUNCEMENT_MODERATOR_FIELDS = [
  "title",
  "body",
  "pinned",
  "expiresAt",
  "department",
  "team",
  "audienceRoles",
  "requiresAck",
  "ackDeadline",
  "publishAt",
] as const;

export const ANNOUNCEMENT_DEPARTMENT_AUTHOR_FIELDS = [
  "title",
  "body",
  "expiresAt",
  "department",
  "team",
  "audienceRoles",
] as const;

export const EVENT_MODERATOR_FIELDS = [
  "title",
  "description",
  "start",
  "end",
  "allDay",
  "location",
  "url",
  "rsvpEnabled",
  "capacity",
  "departments",
  "publishAt",
] as const;

export const EVENT_DEPARTMENT_AUTHOR_FIELDS = [
  "title",
  "description",
  "start",
  "end",
  "allDay",
  "location",
  "url",
  "rsvpEnabled",
  "capacity",
  "departments",
] as const;

export const QUICK_LINK_MODERATOR_FIELDS = [
  "label",
  "url",
  "icon",
  "category",
  "order",
  "departments",
  "publishAt",
  "unpublishAt",
] as const;

export const DOCUMENT_MODERATOR_FIELDS = [
  "title",
  "description",
  "category",
  "departments",
  "file",
  "requiresAck",
  "publishAt",
  "unpublishAt",
] as const;

export const DOCUMENT_DEPARTMENT_AUTHOR_FIELDS = [
  "title",
  "description",
  "category",
  "departments",
  "file",
] as const;

/**
 * Duty plans (v0.18): both classes write the same keys. A department
 * author's `department` is pinned to their own department by the server;
 * a moderator's may be any department or null (company-wide).
 */
export const DUTY_PLAN_FIELDS = ["name", "note", "department", "shiftTemplates", "shifts"] as const;

/**
 * KPIs (v0.19): both classes write the same keys. A department author's
 * `department` is pinned to their own department by the server.
 */
export const KPI_FIELDS = [
  "name",
  "unit",
  "description",
  "department",
  "period",
  "aggregation",
  "values",
] as const;

export const POLL_MODERATOR_FIELDS = [
  "question",
  "options",
  "closesAt",
  "anonymous",
  "departments",
  "visibleToGuests",
  "guestsCanVote",
] as const;

/** type → class → the payload keys that class may send (create and update alike). */
export const AUTHORING_FIELDS: Readonly<
  Record<AuthoringType, Readonly<Partial<Record<AuthoringRoleClass, readonly string[]>>>>
> = {
  announcement: {
    moderator: ANNOUNCEMENT_MODERATOR_FIELDS,
    departmentAuthor: ANNOUNCEMENT_DEPARTMENT_AUTHOR_FIELDS,
  },
  event: {
    moderator: EVENT_MODERATOR_FIELDS,
    departmentAuthor: EVENT_DEPARTMENT_AUTHOR_FIELDS,
  },
  quickLink: { moderator: QUICK_LINK_MODERATOR_FIELDS },
  document: {
    moderator: DOCUMENT_MODERATOR_FIELDS,
    departmentAuthor: DOCUMENT_DEPARTMENT_AUTHOR_FIELDS,
  },
  poll: { moderator: POLL_MODERATOR_FIELDS },
  dutyPlan: { moderator: DUTY_PLAN_FIELDS, departmentAuthor: DUTY_PLAN_FIELDS },
  kpi: { moderator: KPI_FIELDS, departmentAuthor: KPI_FIELDS },
};

/**
 * The targeting keys of each type: a payload carrying one re-derives the
 * type's targeting flag, and only such a payload lowers it (§B1.2,
 * "targeting flags never widen implicitly"). The web sends them only when
 * the author changed the targeting. For announcements, `audienceRoles` also
 * lowers the `retargetRequired` marker (§N9), but does not re-derive
 * `audience`.
 */
export const TARGETING_KEYS: Readonly<Record<AuthoringType, readonly string[]>> = {
  announcement: ["department", "team", "audienceRoles"],
  event: ["departments"],
  quickLink: ["departments"],
  document: ["departments"],
  poll: ["departments"],
  dutyPlan: [],
  kpi: [],
};

/** The `enumeration` values the forms offer (the schemas' enums, pinned by the cms tests). */
export const QUICK_LINK_CATEGORIES = ["hr", "it", "tools", "extern"] as const;
export const DOCUMENT_CATEGORIES = ["policy", "form", "template", "guide", "other"] as const;

/** Most departments one payload may name (event, quick link, document, poll). */
export const MAX_TARGET_DEPARTMENTS = 50;

// Batch 17 contracts; live authoring registration stays with each guarded endpoint.

/** Training writers are the existing moderators (admin_role and editor). */
export const TRAINING_FIELDS = {
  course: {
    moderator: [
      "title",
      "description",
      "mandatory",
      "completionMode",
      "validityMonths",
      "contact",
      "departments",
      "coverImage",
      "publishAt",
    ],
  },
  lesson: {
    moderator: ["title", "body", "order", "course", "videoUrl", "quiz", "publishAt"],
  },
} as const;

export type TrainingAuthoringType = keyof typeof TRAINING_FIELDS;

/**
 * Org moderator means admin_role only: the structure (name, head, lead,
 * members, a team's department) since v0.22; heads/leads keep their row grants.
 */
export const ORG_FIELDS = {
  department: {
    moderator: ["name", "description", "color", "headerImage", "head"],
    departmentHead: ["description", "color"],
  },
  team: {
    moderator: ["name", "description", "avatar", "department", "lead", "members"],
    departmentHead: ["description"],
    teamLead: ["description"],
  },
} as const;

export type OrgAuthoringType = keyof typeof ORG_FIELDS;
export type OrgEditorClass = keyof (typeof ORG_FIELDS)["team"];
