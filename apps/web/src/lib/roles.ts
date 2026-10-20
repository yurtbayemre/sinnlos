/**
 * Web-side role gates and capabilities (SH02). UX only: the CMS permission
 * matrix and route policies (apps/cms/src/bootstrap/permission-matrix.ts
 * PERMISSION_MATRIX / CUSTOM_ACTION_GRANTS, the route policies) enforce
 * every rule on their own; these helpers keep the UI from offering what the
 * CMS would refuse, and keep pages from requesting what it would answer
 * with a 403.
 *
 * `role` is the viewer's role type from getViewer() (lib/viewer.ts), never
 * a value frozen into the session (D-SESSION-01). Every `can*` predicate,
 * `isAdmin` and capabilitiesFor() are FAIL-CLOSED and exact: null,
 * undefined, an unknown or differently-cased value never grants anything.
 * Exclusion checks such as `role !== "guest"` are not allowed — they let
 * every session without a readable role through (investigations.md #1:
 * Microsoft sessions carried role undefined). The one deliberate exception
 * is isReadDenied(), which never grants: it only lets a page skip a read
 * the CMS would refuse for a KNOWN role (see there).
 *
 * Every set and predicate is pinned to the CMS grants by
 * roles-matrix-parity.test.ts; a matrix change that is not mirrored here
 * fails that test. The Capabilities shape follows decision 06 §L2
 * (approved 2026-09-29, with the additive `authorScope`): the shape is
 * fixed, the values per batch are in §L1 and §L2. Batch 15 (lane 15A) set
 * the authoring values (moderators: publish, unpublish and discard; the
 * department authors' "ownDepartment" areas), and lane 15C opened the
 * /manage shell (`manage`) to moderators and department authors.
 */
import {
  AUTHENTICATED,
  DEPARTMENT_AUTHOR_ROLES,
  DUTY_PLAN_AUTHOR_ROLES,
  MODERATORS,
  ROLE_PRIVILEGE_ORDER,
  SCHEDULER_ROLES,
  type MatrixRoleType,
} from "@sinnlos/domain";

type Role = string | null | undefined;

/** A role set of the matrix vocabulary: a misspelt role fails `tsc`. */
const roleSet = (...roles: readonly MatrixRoleType[]): ReadonlySet<string> => new Set(roles);

/** The five employee roles: every seeded role but guest. */
const STAFF: readonly MatrixRoleType[] = [
  "admin_role",
  "editor",
  "department_head",
  "team_lead",
  "member",
];

/** The employee roles plus the `authenticated` fallback: the baseline readers. */
const STAFF_AND_FALLBACK: readonly MatrixRoleType[] = [...STAFF, AUTHENTICATED];

/**
 * Every role type the CMS PERMISSION_MATRIX grants to: the six seeded roles
 * and the users-permissions fallback `authenticated`. A role outside this
 * set (null, a typo, a role an admin created by hand) is UNKNOWN: the gates
 * deny it, and isReadDenied() lets the CMS decide its reads.
 */
export const KNOWN_ROLES: ReadonlySet<string> = roleSet(...ROLE_PRIVILEGE_ORDER, AUTHENTICATED);

export const ADMIN_ROLES: ReadonlySet<string> = roleSet("admin_role");

/** Poll create: global::is-admin-or-editor on the CMS route. */
export const POLL_CREATOR_ROLES: ReadonlySet<string> = roleSet(...MODERATORS);

/**
 * event-rsvp create/update grants. guest has none (the RSVP fetch would 403);
 * the `authenticated` fallback role does hold them.
 */
export const RSVP_ROLES: ReadonlySet<string> = roleSet(...STAFF_AND_FALLBACK);

/**
 * Posting an ad needs classified create AND the content-api upload grant:
 * the five staff roles only — never guest or the `authenticated` fallback.
 */
export const AD_POSTER_ROLES: ReadonlySet<string> = roleSet(...STAFF);

/**
 * Taking down someone else's ad: the classified delete route's
 * is-classified-author bypass (moderation), admin_role and editor.
 */
export const AD_MODERATOR_ROLES: ReadonlySet<string> = roleSet(...MODERATORS);

/**
 * Editing someone else's ad: the classified update route's bypass,
 * admin_role only (editors keep only the takedown).
 */
export const AD_EDITOR_ROLES: ReadonlySet<string> = roleSet("admin_role");

/** comment create: every employee role and the fallback, never guest. */
export const COMMENTER_ROLES: ReadonlySet<string> = roleSet(...STAFF_AND_FALLBACK);

/**
 * comment delete (the author's own comment, is-comment-author): the five
 * staff roles. The `authenticated` fallback may comment but not delete.
 */
export const COMMENT_DELETER_ROLES: ReadonlySet<string> = roleSet(...STAFF);

/** reaction create (which also takes a reaction back, FX28): never guest. */
export const REACTOR_ROLES: ReadonlySet<string> = roleSet(...STAFF_AND_FALLBACK);

/**
 * announcement.find: only these roles can ever see, and so be expected to
 * confirm, a mandatory announcement. The acknowledgement report counts
 * them; `guest` has no announcement read.
 */
export const ANNOUNCEMENT_READER_ROLES: ReadonlySet<string> = roleSet(...STAFF_AND_FALLBACK);

/**
 * Roles that get e-mail digests: the announcement readers (the cms digest
 * run skips every other role, and PUT /api/me ignores a guest's opt-ins,
 * FX19). The profile form offers the digest options to these roles only.
 */
export const DIGEST_ROLES: ReadonlySet<string> = ANNOUNCEMENT_READER_ROLES;

/** acknowledgement find and create: the caller's own read receipts. */
export const ACKNOWLEDGER_ROLES: ReadonlySet<string> = roleSet(...STAFF_AND_FALLBACK);

/**
 * Training: course and lesson reads plus the own lesson-progress rows. The
 * training report counts these roles; `guest` has no training grant
 * (issue #29).
 */
export const TRAINING_ROLES: ReadonlySet<string> = roleSet(...STAFF_AND_FALLBACK);

/** department.find and team.find: the org pages. */
export const ORG_READER_ROLES: ReadonlySet<string> = roleSet(...STAFF_AND_FALLBACK);

/** duty-plan.find (v0.18): every staff role and `authenticated`; guests none. */
export const DUTY_READER_ROLES: ReadonlySet<string> = roleSet(...STAFF_AND_FALLBACK);

/** kpi.find (v0.19): every staff role and `authenticated`; guests none. */
export const KPI_READER_ROLES: ReadonlySet<string> = roleSet(...STAFF_AND_FALLBACK);

/** kudos.find: the kudos wall. */
export const KUDOS_READER_ROLES: ReadonlySet<string> = roleSet(...STAFF_AND_FALLBACK);

/**
 * kudos.celebrations (birthdays and anniversaries): the staff roles only.
 * The `authenticated` fallback reads kudos but not the celebrations, which
 * would reconstruct every hire date.
 */
export const CELEBRATION_ROLES: ReadonlySet<string> = roleSet(...STAFF);

/** classified.find: the marketplace. guest reads no ads (they carry contact data). */
export const AD_READER_ROLES: ReadonlySet<string> = roleSet(...STAFF_AND_FALLBACK);

/**
 * The guest role, for wording only (the poll card says why a guest cannot
 * vote). Never a gate: what a guest may see or do is decided by the CMS.
 */
export const GUEST_ROLES: ReadonlySet<string> = roleSet("guest");

function hasRole(allowed: ReadonlySet<string>, role: Role): boolean {
  return typeof role === "string" && allowed.has(role);
}

export function isAdmin(role: Role): boolean {
  return hasRole(ADMIN_ROLES, role);
}

export function canCreatePolls(role: Role): boolean {
  return hasRole(POLL_CREATOR_ROLES, role);
}

export function canRsvp(role: Role): boolean {
  return hasRole(RSVP_ROLES, role);
}

export function canPostAds(role: Role): boolean {
  return hasRole(AD_POSTER_ROLES, role);
}

/** The takedown of any ad (DeleteClassified on someone else's ad). */
export function canDeleteAnyAd(role: Role): boolean {
  return hasRole(AD_MODERATOR_ROLES, role);
}

/** Editing any ad (the edit page and its link for someone else's ad). */
export function canEditAnyAd(role: Role): boolean {
  return hasRole(AD_EDITOR_ROLES, role);
}

/** The comment form. */
export function canComment(role: Role): boolean {
  return hasRole(COMMENTER_ROLES, role);
}

/** The delete button on the viewer's own comments. */
export function canDeleteOwnComments(role: Role): boolean {
  return hasRole(COMMENT_DELETER_ROLES, role);
}

/** The reaction bar. */
export function canReact(role: Role): boolean {
  return hasRole(REACTOR_ROLES, role);
}

/** The training section: courses, lessons and the own progress. */
export function canTrain(role: Role): boolean {
  return hasRole(TRAINING_ROLES, role);
}

/** The digest options on the profile form. */
export function canReceiveDigests(role: Role): boolean {
  return hasRole(DIGEST_ROLES, role);
}

/** Exact `guest` only; see GUEST_ROLES (wording, never a gate). */
export function isGuest(role: Role): boolean {
  return hasRole(GUEST_ROLES, role);
}

/**
 * Sections a page reads whose grants not every role holds. The pages ask
 * before they read, so a role without the grant sees an explanation instead
 * of the CMS's 403 as an error banner or an error page.
 */
export type ReadSection =
  | "announcements"
  | "acknowledgements"
  | "departments"
  | "teams"
  | "kudos"
  | "celebrations"
  | "marketplace"
  | "training"
  | "duties"
  | "kpis";

export const READ_SECTIONS: Readonly<Record<ReadSection, ReadonlySet<string>>> = Object.freeze({
  announcements: ANNOUNCEMENT_READER_ROLES,
  acknowledgements: ACKNOWLEDGER_ROLES,
  departments: ORG_READER_ROLES,
  teams: ORG_READER_ROLES,
  kudos: KUDOS_READER_ROLES,
  celebrations: CELEBRATION_ROLES,
  marketplace: AD_READER_ROLES,
  training: TRAINING_ROLES,
  duties: DUTY_READER_ROLES,
  kpis: KPI_READER_ROLES,
});

/** Fail-closed like every gate: only a listed role reads the section. */
export function canRead(role: Role, section: ReadSection): boolean {
  return hasRole(READ_SECTIONS[section], role);
}

/**
 * True when the viewer's role is a KNOWN role (KNOWN_ROLES) whose grants
 * lack the section's read: the page skips the request and shows why, and
 * the nav hides the entry. It never grants anything. A missing or unknown
 * role (null after a failed /api/me read, a role created by hand in the
 * admin panel) is not denied here: the page reads as before and the CMS
 * decides, so a CMS outage still shows the error banner instead of a
 * misleading "not available for your role".
 */
export function isReadDenied(role: Role, section: ReadSection): boolean {
  return hasRole(KNOWN_ROLES, role) && !canRead(role, section);
}

// ---------------------------------------------------------------------------
// Capabilities (decision 06 §L2; SH02 shape)
// ---------------------------------------------------------------------------

export type AuthoringArea =
  | "announcements"
  | "events"
  | "polls"
  | "quickLinks"
  | "documents"
  | "wikiSpaces"
  | "courses"
  | "lessons"
  | "dutyPlans"
  | "kpis";

export type AuthoringVerb =
  "create" | "edit" | "publish" | "unpublish" | "schedule" | "discard" | "delete";

/** Amendment 1 (§N7): "ownDepartment" arrives with the department authors in batch 15. */
export type AuthoringScope = "any" | "ownDepartment";

export const AUTHORING_AREAS: readonly AuthoringArea[] = [
  "announcements",
  "events",
  "polls",
  "quickLinks",
  "documents",
  "wikiSpaces",
  "courses",
  "lessons",
  "dutyPlans",
  "kpis",
];

export interface Capabilities {
  /** The /manage shell (§L1): moderators and department authors since batch 15 (admin_role before). */
  manage: boolean;
  author: Readonly<Record<AuthoringArea, ReadonlySet<AuthoringVerb>>>;
  /** Amendment 1: null exactly when author[area] is empty. */
  authorScope: Readonly<Record<AuthoringArea, AuthoringScope | null>>;
  wikiPages: {
    /** Department heads, team leads and moderators (in spaces they can read). */
    create: boolean;
    /**
     * "row": the can-edit-wiki row classes (author, head, lead; @sinnlos/
     * domain classifyWikiEditor decides per page); "any": moderators.
     */
    edit: "row" | "any" | "none";
    unpublish: boolean;
    schedule: boolean;
    delete: boolean;
  };
  org: { editDepartment: "own" | "any" | "none"; editTeam: "own" | "any" | "none" };
  reports: { analytics: boolean; acknowledgements: boolean; training: boolean; activity: boolean };
  // The SH02 predicates above stay next to it: canComment, canReact, canRsvp,
  // canPostAds, canDeleteAnyAd, canEditAnyAd, canTrain.
}

/** Every verb of a draft & publish area the moderators author (batch 15). */
const DRAFT_AND_PUBLISH_VERBS: readonly AuthoringVerb[] = [
  "create",
  "edit",
  "publish",
  "unpublish",
  "schedule",
  "discard",
  "delete",
];

/**
 * What the moderators (admin_role, editor) may author per area, from the
 * CMS grants since batch 15 (lane 15A): announcements, events, quick links
 * and documents with every verb (the custom publish, unpublish and
 * discardDraft actions, `schedule` as `update`), polls and wiki spaces with
 * create, edit and delete (a poll publishes at create; §A). Courses and
 * lessons have draft/publish authoring without delete (batch 17). Decision 06
 * §L2 maps each verb to a CMS action: `edit` and `schedule` to `update`,
 * `discard` to `discardDraft`. Documents have no web pages before 16C; the
 * capability says what the CMS allows, not which page exists (§N7).
 */
const MODERATOR_AUTHORING: Readonly<Record<AuthoringArea, readonly AuthoringVerb[]>> = {
  announcements: DRAFT_AND_PUBLISH_VERBS,
  events: DRAFT_AND_PUBLISH_VERBS,
  polls: ["create", "edit", "delete"],
  quickLinks: DRAFT_AND_PUBLISH_VERBS,
  documents: DRAFT_AND_PUBLISH_VERBS,
  wikiSpaces: ["create", "edit", "delete"],
  courses: ["create", "edit", "publish", "unpublish", "schedule", "discard"],
  lessons: ["create", "edit", "publish", "unpublish", "schedule", "discard"],
  // Duty plans (v0.18) have no schedule: a shift list is live data.
  dutyPlans: ["create", "edit", "publish", "unpublish", "discard", "delete"],
  // KPIs (v0.19): figures entered by hand, no schedule.
  kpis: ["create", "edit", "publish", "unpublish", "discard", "delete"],
};

/**
 * What a department author (decision 06 amendment 1, §N2, §N7: the
 * `department_head` role, DEPARTMENT_AUTHOR_ROLES) may author: their own
 * department's announcements, events and documents, with create, edit,
 * publish, unpublish and discard. No schedule (the role is not in
 * SCHEDULER_ROLES, although it holds `update`), no delete (no grant). The
 * scope is "ownDepartment": the CMS admits only items their department owns
 * and targets, and a page also needs viewer.department (§L2).
 */
const DEPARTMENT_AUTHOR_AUTHORING: Readonly<
  Partial<Record<AuthoringArea, readonly AuthoringVerb[]>>
> = {
  announcements: ["create", "edit", "publish", "unpublish", "discard"],
  events: ["create", "edit", "publish", "unpublish", "discard"],
  documents: ["create", "edit", "publish", "unpublish", "discard"],
  dutyPlans: ["create", "edit", "publish", "unpublish", "discard"],
  kpis: ["create", "edit", "publish", "unpublish", "discard"],
};

/** wiki-page create: moderators, department heads and team leads. */
const WIKI_PAGE_CREATOR_ROLES: ReadonlySet<string> = roleSet(
  ...MODERATORS,
  "department_head",
  "team_lead",
);

/** wiki-page update without the moderator bypass: the can-edit-wiki row classes. */
const WIKI_PAGE_ROW_EDITOR_ROLES: ReadonlySet<string> = roleSet(
  "department_head",
  "team_lead",
  "member",
);

const MODERATOR_ROLES: ReadonlySet<string> = roleSet(...MODERATORS);

/** The department authors (amendment 1, §N1): role only, the department is checked per page. */
const DEPARTMENT_AUTHOR_ROLE_SET: ReadonlySet<string> = roleSet(...DEPARTMENT_AUTHOR_ROLES);

/**
 * Who department-authors each area: department heads, and on duty plans
 * team leads too (owner decision 2026-10-20, @sinnlos/domain
 * DEPARTMENT_AUTHOR_ROLES_OF). An area without an entry has none.
 */
const DEPARTMENT_AUTHOR_ROLES_BY_AREA: Readonly<
  Partial<Record<AuthoringArea, ReadonlySet<string>>>
> = {
  announcements: DEPARTMENT_AUTHOR_ROLE_SET,
  events: DEPARTMENT_AUTHOR_ROLE_SET,
  documents: DEPARTMENT_AUTHOR_ROLE_SET,
  dutyPlans: roleSet(...DUTY_PLAN_AUTHOR_ROLES),
  kpis: DEPARTMENT_AUTHOR_ROLE_SET,
};

/** The roles that may schedule (`publishAt`, `unpublishAt`; §D rule 1, §L2). */
const SCHEDULER_ROLE_SET: ReadonlySet<string> = roleSet(...SCHEDULER_ROLES);

/**
 * The capabilities of a role type; role-only (the CMS decides row gates per
 * request) and fail-closed: a missing or unknown role gets nothing.
 */
export function capabilitiesFor(role: Role): Capabilities {
  const admin = isAdmin(role);
  const moderator = hasRole(MODERATOR_ROLES, role);
  const scheduler = hasRole(SCHEDULER_ROLE_SET, role);
  const author = {} as Record<AuthoringArea, ReadonlySet<AuthoringVerb>>;
  const authorScope = {} as Record<AuthoringArea, AuthoringScope | null>;
  let departmentAuthor = false;
  for (const area of AUTHORING_AREAS) {
    const areaAuthor =
      !moderator && hasRole(DEPARTMENT_AUTHOR_ROLES_BY_AREA[area] ?? new Set<string>(), role);
    departmentAuthor ||= areaAuthor;
    const granted = moderator
      ? MODERATOR_AUTHORING[area]
      : areaAuthor
        ? (DEPARTMENT_AUTHOR_AUTHORING[area] ?? [])
        : [];
    // `schedule` is `update` plus SCHEDULER_ROLES (§L2): never for department authors.
    const verbs = new Set<AuthoringVerb>(
      granted.filter((verb) => verb !== "schedule" || scheduler),
    );
    author[area] = verbs;
    authorScope[area] = verbs.size === 0 ? null : moderator ? "any" : "ownDepartment";
  }
  return {
    // The /manage shell (§L1, §N7): every role that authors an area. A
    // department author's pages still need the viewer's department (§N1).
    manage: moderator || departmentAuthor,
    author: Object.freeze(author),
    authorScope: Object.freeze(authorScope),
    wikiPages: {
      create: hasRole(WIKI_PAGE_CREATOR_ROLES, role),
      edit: moderator ? "any" : hasRole(WIKI_PAGE_ROW_EDITOR_ROLES, role) ? "row" : "none",
      // wiki-page.unpublish (batch 16): moderators; scheduling is the
      // moderators' update, like the areas' `schedule`.
      unpublish: moderator,
      schedule: moderator,
      delete: moderator,
    },
    org: {
      // department.update/editable: admin_role and the
      // head of the department; editor reads departments only.
      editDepartment: admin ? "any" : role === "department_head" ? "own" : "none",
      // team.update: admin_role, the head of the team's department, its lead.
      editTeam: admin ? "any" : role === "department_head" || role === "team_lead" ? "own" : "none",
    },
    reports: {
      analytics: admin,
      acknowledgements: admin,
      training: admin,
      // The fixed activity read is admin-only.
      activity: admin,
    },
  };
}
