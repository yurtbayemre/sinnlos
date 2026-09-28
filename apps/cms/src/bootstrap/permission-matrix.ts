/**
 * The users-permissions grants this cms wants (roadmap B01): which role may
 * call which content-API action. Pure data plus pure set computations, no
 * Strapi runtime; bootstrap/sync-permissions.ts applies them at boot, and
 * routes.matrix.test.ts, prod-perm-diff.test.ts (infra/diagnostics/
 * prod-perm-diff.sql) and infra/contracts.test.ts check them in CI.
 *
 * On first boot the bootstrap ensures the six intranet roles exist in the
 * users-permissions plugin AND that each role is granted sensible default
 * REST permissions on the intranet content types. Writes are additionally
 * gated by route-level policies (see `src/api/*\/routes/*.ts` and
 * `src/policies/*.ts`), so granting create/update/delete here does NOT
 * bypass the policy checks — it simply lets the policies run.
 *
 * Without this, Strapi's users-permissions plugin returns 403 on every
 * `/api/*` call, because a freshly-created role has zero permissions.
 *
 * Role keys and role lists are typed by the vocabulary in bootstrap/roles.ts
 * (B02), so a misspelt role fails `tsc` instead of a boot warning.
 */
import { ADMIN, AUTHENTICATED, STAFF_ROLES, type MatrixRoleType } from "./roles";

/**
 * Intranet content types. We grant explicit permissions on each
 * per role; everything else stays untouched.
 */
export const CONTENT_TYPES = [
  "api::acknowledgement.acknowledgement",
  "api::announcement.announcement",
  "api::classified.classified",
  "api::comment.comment",
  "api::course.course",
  "api::department.department",
  "api::document.document",
  "api::event.event",
  "api::event-rsvp.event-rsvp",
  "api::kudos.kudos",
  "api::lesson.lesson",
  "api::lesson-progress.lesson-progress",
  "api::notification.notification",
  "api::poll.poll",
  "api::poll-vote.poll-vote",
  "api::quick-link.quick-link",
  "api::reaction.reaction",
  "api::search-log.search-log",
  "api::team.team",
  "api::wiki-space.wiki-space",
  "api::wiki-page.wiki-page",
  "api::wiki-revision.wiki-revision",
] as const;

export type ContentTypeUid = (typeof CONTENT_TYPES)[number];
export type CrudAction = "find" | "findOne" | "create" | "update" | "delete";

const READ_ACTIONS: CrudAction[] = ["find", "findOne"];
const ALL_ACTIONS: CrudAction[] = ["find", "findOne", "create", "update", "delete"];

/**
 * Permission matrix per role. Reads are granted broadly; writes are
 * granted where route-level policies will gate them further.
 *
 * `admin_role` and `editor` get full CRUD everywhere — the
 * `global::is-admin-or-editor` policy on create/delete routes still
 * restricts writes to these two roles in practice.
 *
 * `department_head` and `team_lead` need update on the types they
 * manage; the `can-edit-department`, `can-edit-team` and
 * `can-edit-wiki` policies still scope those updates to their own
 * department/team/authored pages, and to the fields in
 * utils/write-allowlist.ts (FX07).
 *
 * `member` can update wiki pages they authored (gated by
 * `can-edit-wiki`, which also keeps them to pages in spaces they can
 * read). `guest` is strict read-only on wiki content.
 *
 * Checked against the routers and controllers by `routes.matrix.test.ts`
 * (roadmap S01), with CUSTOM_ACTION_GRANTS and REVOKED_PERMISSIONS.
 */
export const PERMISSION_MATRIX: Record<
  MatrixRoleType,
  Partial<Record<ContentTypeUid, CrudAction[]>>
> = {
  admin_role: {
    "api::acknowledgement.acknowledgement": ALL_ACTIONS,
    // Training (issue #29, admin-authoring variant): course/lesson are
    // maintained in the Strapi admin — the content api exposes READS
    // only (the write routes do not even exist, see the routers).
    "api::course.course": READ_ACTIONS,
    "api::lesson.lesson": READ_ACTIONS,
    // No update/delete (FX01): the routes are gone (`only:`), receipts
    // are corrected in the Strapi admin. Same for the other trimmed
    // routers below — see REMOVED_CORE_ACTIONS.
    "api::lesson-progress.lesson-progress": ["find", "findOne", "create"],
    "api::announcement.announcement": ALL_ACTIONS,
    "api::classified.classified": ALL_ACTIONS,
    "api::comment.comment": [...READ_ACTIONS, "create", "delete"],
    "api::department.department": ALL_ACTIONS,
    "api::document.document": ALL_ACTIONS,
    "api::event.event": ALL_ACTIONS,
    // delete deliberately admin-only across ALL roles: removing someone
    // else's RSVP is an admin correction, not a user action.
    "api::event-rsvp.event-rsvp": ALL_ACTIONS,
    "api::kudos.kudos": [...READ_ACTIONS, "create", "delete"],
    "api::notification.notification": [...READ_ACTIONS, "delete"],
    "api::poll.poll": ALL_ACTIONS,
    // NO poll-vote grants for any role (FX01): votes are cast and counted
    // only through the custom /polls/:id/vote and /results actions
    // (CUSTOM_ACTION_GRANTS); the generic /api/poll-votes routes are gone.
    "api::quick-link.quick-link": ALL_ACTIONS,
    "api::search-log.search-log": ["create"],
    "api::reaction.reaction": [...READ_ACTIONS, "create", "delete"],
    "api::team.team": ALL_ACTIONS,
    "api::wiki-space.wiki-space": ALL_ACTIONS,
    "api::wiki-page.wiki-page": ALL_ACTIONS,
    "api::wiki-revision.wiki-revision": ALL_ACTIONS,
  },
  editor: {
    // No update/delete: acknowledgements are immutable read receipts —
    // only admin_role may correct them.
    "api::acknowledgement.acknowledgement": ["find", "findOne", "create"],
    "api::announcement.announcement": ALL_ACTIONS,
    // Full CRUD = moderation: editors may take down any employee ad
    // (is-classified-author passes admin_role/editor unconditionally).
    "api::classified.classified": ALL_ACTIONS,
    "api::comment.comment": [...READ_ACTIONS, "create", "delete"],
    "api::department.department": READ_ACTIONS,
    "api::document.document": ALL_ACTIONS,
    "api::event.event": ALL_ACTIONS,
    // No delete (admin-only); update is ownership-gated by
    // is-event-rsvp-owner — editors change only their OWN answer.
    "api::event-rsvp.event-rsvp": [...READ_ACTIONS, "create", "update"],
    "api::kudos.kudos": [...READ_ACTIONS, "create", "delete"],
    // create/update are gone (FX01): notifications are written by the
    // CMS lifecycles only — the unpoliced core PUT let an editor rewrite
    // any user's notification.
    "api::notification.notification": [...READ_ACTIONS, "delete"],
    "api::poll.poll": ALL_ACTIONS,
    "api::quick-link.quick-link": ALL_ACTIONS,
    "api::course.course": READ_ACTIONS,
    "api::lesson.lesson": READ_ACTIONS,
    "api::lesson-progress.lesson-progress": ["find", "findOne", "create"],
    "api::search-log.search-log": ["create"],
    "api::reaction.reaction": [...READ_ACTIONS, "create", "delete"],
    "api::team.team": READ_ACTIONS,
    "api::wiki-space.wiki-space": ALL_ACTIONS,
    "api::wiki-page.wiki-page": ALL_ACTIONS,
    "api::wiki-revision.wiki-revision": ALL_ACTIONS,
  },
  department_head: {
    "api::acknowledgement.acknowledgement": ["find", "findOne", "create"],
    "api::announcement.announcement": READ_ACTIONS,
    "api::classified.classified": ALL_ACTIONS,
    "api::comment.comment": [...READ_ACTIONS, "create", "delete"],
    "api::department.department": [...READ_ACTIONS, "update"],
    "api::document.document": READ_ACTIONS,
    "api::event.event": READ_ACTIONS,
    "api::event-rsvp.event-rsvp": [...READ_ACTIONS, "create", "update"],
    "api::kudos.kudos": ["find", "findOne", "create"],
    "api::notification.notification": [...READ_ACTIONS, "delete"],
    "api::poll.poll": READ_ACTIONS,
    "api::quick-link.quick-link": READ_ACTIONS,
    "api::course.course": READ_ACTIONS,
    "api::lesson.lesson": READ_ACTIONS,
    "api::lesson-progress.lesson-progress": ["find", "findOne", "create"],
    "api::search-log.search-log": ["create"],
    "api::reaction.reaction": [...READ_ACTIONS, "create", "delete"],
    "api::team.team": [...READ_ACTIONS, "update"],
    "api::wiki-space.wiki-space": READ_ACTIONS,
    "api::wiki-page.wiki-page": [...READ_ACTIONS, "create", "update"],
    "api::wiki-revision.wiki-revision": READ_ACTIONS,
  },
  team_lead: {
    "api::acknowledgement.acknowledgement": ["find", "findOne", "create"],
    "api::announcement.announcement": READ_ACTIONS,
    "api::classified.classified": ALL_ACTIONS,
    "api::comment.comment": [...READ_ACTIONS, "create", "delete"],
    "api::department.department": READ_ACTIONS,
    "api::document.document": READ_ACTIONS,
    "api::event.event": READ_ACTIONS,
    "api::event-rsvp.event-rsvp": [...READ_ACTIONS, "create", "update"],
    "api::kudos.kudos": ["find", "findOne", "create"],
    "api::notification.notification": [...READ_ACTIONS, "delete"],
    "api::poll.poll": READ_ACTIONS,
    "api::quick-link.quick-link": READ_ACTIONS,
    "api::course.course": READ_ACTIONS,
    "api::lesson.lesson": READ_ACTIONS,
    "api::lesson-progress.lesson-progress": ["find", "findOne", "create"],
    "api::search-log.search-log": ["create"],
    "api::reaction.reaction": [...READ_ACTIONS, "create", "delete"],
    "api::team.team": [...READ_ACTIONS, "update"],
    "api::wiki-space.wiki-space": READ_ACTIONS,
    "api::wiki-page.wiki-page": [...READ_ACTIONS, "create", "update"],
    "api::wiki-revision.wiki-revision": READ_ACTIONS,
  },
  member: {
    "api::acknowledgement.acknowledgement": ["find", "findOne", "create"],
    "api::announcement.announcement": READ_ACTIONS,
    // update/delete are ownership-gated by is-classified-author; the grant
    // here only lets that policy run (see file header note).
    "api::classified.classified": ALL_ACTIONS,
    "api::comment.comment": [...READ_ACTIONS, "create", "delete"],
    "api::department.department": READ_ACTIONS,
    "api::document.document": READ_ACTIONS,
    "api::event.event": READ_ACTIONS,
    "api::event-rsvp.event-rsvp": [...READ_ACTIONS, "create", "update"],
    "api::kudos.kudos": ["find", "findOne", "create"],
    "api::notification.notification": [...READ_ACTIONS, "delete"],
    "api::poll.poll": READ_ACTIONS,
    "api::quick-link.quick-link": READ_ACTIONS,
    "api::course.course": READ_ACTIONS,
    "api::lesson.lesson": READ_ACTIONS,
    "api::lesson-progress.lesson-progress": ["find", "findOne", "create"],
    "api::search-log.search-log": ["create"],
    "api::reaction.reaction": [...READ_ACTIONS, "create", "delete"],
    "api::team.team": READ_ACTIONS,
    "api::wiki-space.wiki-space": READ_ACTIONS,
    "api::wiki-page.wiki-page": [...READ_ACTIONS, "update"],
    "api::wiki-revision.wiki-revision": READ_ACTIONS,
  },
  /**
   * `guest` is read-only on content (it writes only search telemetry, and
   * casts poll votes through the custom vote action, CUSTOM_ACTION_GRANTS;
   * decision 02). It is denied kudos (celebrations populate user relations
   * and leak hire dates), but it DOES keep the baseline
   * `users-permissions.user.find/findOne/me` grants every role gets
   * (USER_READ_ACTIONS below).
   *
   * WHY guest keeps user.find/findOne: Strapi's core controllers run
   * validateQuery (→ throwRestrictedRelations) BEFORE sanitizeQuery, so
   * every FILTER through a user relation — the notification visibility
   * filter references the `recipient` user relation — throws a 400 for a
   * role lacking `user.find`. Populates of a user relation (wiki-page.author,
   * comment.author, document.uploadedBy, department.head, team.lead, ...)
   * threw the same 400 on 5.49; in @strapi/utils 5.55.1 validatePopulate no
   * longer checks the scope and sanitizePopulate silently drops the relation
   * instead, so without user.find guest pages would lose every
   * author/uploader name.
   *
   * The employee contact data this would expose is closed on both sides
   * (P1.2, docs/architecture.md §7b): the fields are removed OUTPUT-side by
   * the role-aware content-api.output sanitizer
   * (bootstrap/user-contact-sanitizer.ts → utils/sanitize-user-contact.ts,
   * issue #10), on /api/users reads and on every POPULATED user relation,
   * and a non-staff caller cannot filter, sort or search by them
   * (middlewares/sensitive-query-guard.ts, FX22). Both apply to every caller
   * outside STAFF_ROLES: guest, `authenticated`, public and unknown roles.
   */
  guest: {
    // NO acknowledgement grants: guest has no announcement.find, so it can
    // never see (let alone confirm) a mandatory announcement — the grants
    // were dead attack surface (an authenticated guest could probe/create
    // ack rows for targets it cannot read). Revoked below in
    // REVOKED_PERMISSIONS for databases bootstrapped by older versions.
    // NO classified grants either: the flea market is internal and ads
    // populate author.email/jobTitle — employee contact data a restricted
    // guest must not read. The marketplace nav entry stays visible (kudos
    // precedent) and the page degrades to the FetchErrorBanner for guests.
    // Revoked below for databases bootstrapped by earlier versions.
    "api::comment.comment": READ_ACTIONS,
    "api::document.document": READ_ACTIONS,
    // NO event-rsvp grants: guest reads the calendar but neither responds
    // nor sees who attends (attendee names are employee data; the web app
    // skips the RSVP fetch for guests to avoid a 403 banner).
    "api::event.event": READ_ACTIONS,
    "api::notification.notification": READ_ACTIONS,
    "api::poll.poll": READ_ACTIONS,
    "api::quick-link.quick-link": READ_ACTIONS,
    "api::search-log.search-log": ["create"],
    "api::reaction.reaction": READ_ACTIONS,
    "api::wiki-space.wiki-space": READ_ACTIONS,
    "api::wiki-page.wiki-page": READ_ACTIONS,
  },
  /**
   * `authenticated` is the users-permissions built-in role for a signed-in
   * user without an intranet role. New local and OAuth accounts do NOT land
   * here: users-permissions creates them with the advanced setting
   * `default_role`, which the bootstrap pins to `member`
   * (bootstrap/advanced-settings.ts). A user holds `authenticated` only when
   * an admin assigned it by hand or the account predates that setting; no
   * code re-maps roles at sign-in today (the Microsoft callback extension is
   * inert, and the Entra sign-in of decision 01 replaces it). Such a user
   * still gets baseline reads, so the dashboard works instead of 403ing on
   * every `/api/*` call, but none of the staff-only grants (celebrations,
   * uploads, ads) — and the contact fields stay hidden (not a STAFF_ROLE).
   */
  authenticated: {
    "api::acknowledgement.acknowledgement": ["find", "findOne", "create"],
    "api::announcement.announcement": READ_ACTIONS,
    // Read-only on purpose: `authenticated` is only the pre-role-mapping
    // fallback, and posting an ad requires the upload grant anyway (which
    // this role does not get).
    "api::classified.classified": READ_ACTIONS,
    "api::comment.comment": [...READ_ACTIONS, "create"],
    "api::department.department": READ_ACTIONS,
    "api::document.document": READ_ACTIONS,
    "api::event.event": READ_ACTIONS,
    "api::event-rsvp.event-rsvp": [...READ_ACTIONS, "create", "update"],
    "api::kudos.kudos": ["find", "findOne", "create"],
    "api::notification.notification": READ_ACTIONS,
    "api::poll.poll": READ_ACTIONS,
    "api::quick-link.quick-link": READ_ACTIONS,
    "api::course.course": READ_ACTIONS,
    "api::lesson.lesson": READ_ACTIONS,
    "api::lesson-progress.lesson-progress": ["find", "findOne", "create"],
    "api::search-log.search-log": ["create"],
    "api::reaction.reaction": [...READ_ACTIONS, "create"],
    "api::team.team": READ_ACTIONS,
    "api::wiki-space.wiki-space": READ_ACTIONS,
    "api::wiki-page.wiki-page": READ_ACTIONS,
    "api::wiki-revision.wiki-revision": READ_ACTIONS,
  },
};

/**
 * Custom (non-CRUD) route actions. users-permissions gates EVERY route
 * behind a permission row — including custom ones — so these must be
 * seeded too or the endpoints 403 for all roles.
 * Each entry lists the roles that may call the action. `*` = every role
 * in PERMISSION_MATRIX (including `authenticated`).
 */
export const CUSTOM_ACTION_GRANTS: Record<string, readonly MatrixRoleType[] | "*"> = {
  "api::event.event.ics": "*",
  // The RSVP summary for the events list (FX21): exactly the roles that
  // hold event-rsvp find in the matrix above. Never guest: guests read the
  // calendar but see no attendee names (routes.matrix.test.ts pins both).
  "api::event-rsvp.event-rsvp.summary": [...STAFF_ROLES, AUTHENTICATED],
  // guest and the `authenticated` fallback are excluded: even with email
  // dropped from the payload, years + daysUntil still reconstruct every
  // user's exact hireDate, so this stays limited to the mapped staff roles.
  "api::kudos.kudos.celebrations": STAFF_ROLES,
  "api::notification.notification.markRead": "*",
  "api::notification.notification.markAllRead": "*",
  // Every role, guest included: guests need both for the polls opened to
  // them. Which polls a caller may see and vote on is decided per poll by
  // utils/poll-audience.ts (canSeePoll/canVoteOnPoll: department targeting,
  // and for guests visibleToGuests/guestsCanVote, owner decision
  // 2026-09-27). A cms from before guest access ignores those switches and
  // never removes the guest vote row: a rollback removes it first
  // (docs/DEPLOYMENT.md, "Upgrading to poll department targeting", Rollback).
  "api::poll-vote.poll-vote.vote": "*",
  "api::poll-vote.poll-vote.results": "*",
  // Aggregated search analytics (issue #19) — /manage/analytics is
  // admin-only, so is the summary endpoint.
  "api::search-log.search-log.summary": [ADMIN],
  // Self-service profile (added in this feature)
  "api::profile.profile.me": "*",
  "api::profile.profile.updateMe": "*",
  // Built-in auth action local users need to change their password
  "plugin::users-permissions.auth.changePassword": "*",
  // The admin ack report populates announcement.audienceRoles to restrict
  // the target audience per announcement. The core checks the scope
  // `<relation target>.find` for every populated relation, so admin_role
  // needs role.find. On Strapi 5.49 a missing grant 400'd the populate; on
  // 5.55.1 sanitizePopulate drops the relation silently, and the report
  // would count every role as audience (lib/audience.ts: no roles = no
  // role restriction). admin only — no other role reads audienceRoles.
  "plugin::users-permissions.role.find": [ADMIN],
  // Marketplace ad photos: employees may CREATE uploads via POST
  // /api/upload — deliberately NOT `find`/`findOne`/`destroy` on the
  // upload content-api (no browsing or deleting of the media library from
  // outside the admin panel). guest and the `authenticated` fallback get
  // nothing. The route itself is additionally hardened (image-only magic
  // byte allowlist, 5 MB, create-only) in extensions/upload/strapi-server.ts.
  "plugin::upload.content-api.upload": STAFF_ROLES,
  // Best-effort orphan cleanup for the two-step ad flow (issue #13): same
  // five posting roles as the upload grant above, never guest. The action
  // only ever deletes files stamped with the CALLER's own
  // provider_metadata.uploadedBy and without any remaining relation — see
  // controllers/classified.ts.
  "api::classified.classified.cleanupUploads": STAFF_ROLES,
};

/**
 * Every role that can read content types also needs
 * `plugin::users-permissions.user.find` and `findOne` so that Strapi
 * populates user relations (author, lead, members, head, etc.)
 * instead of throwing a 400 on any query that populates them.
 *
 * This applies to `guest` too: revoking it (as an earlier audit attempt
 * did) turned every guest read that populates a user relation — and the
 * notification visibility filter — into a 400. See the note on the `guest`
 * matrix above. No role is excluded: computeDesiredGrants grants these to
 * every role of PERMISSION_MATRIX, and routes.matrix.test.ts pins it.
 *
 * `me` is equally required for every role: the web app's sign-in flow
 * fetches `/api/users/me?populate[role]=true` to stamp role + department
 * into the session. Before the role mapping all users sat on
 * `Authenticated` (which Strapi grants `me` by default); the mapped roles
 * never received it, so the fetch 403'd on every login and the silent
 * fallback in `apps/web/src/auth.ts` left sessions without a role — which
 * in turn hid all role-gated UI (e.g. the admin "/manage" nav entry).
 */
export const USER_READ_ACTIONS: (CrudAction | "me")[] = ["find", "findOne", "me"];
export const USER_UID = "plugin::users-permissions.user";

/**
 * Core actions whose routes were removed with `only:` in the routers
 * (FX01): nothing in the web calls them, and each was either an unpoliced
 * write or dead attack surface —
 *   - poll-vote: core create/update/delete bypassed voter identity, one
 *     vote per user, closesAt and the option bounds of the custom
 *     /polls/:id/vote (forged and duplicate votes); the generic reads went
 *     with them (decisions/02-poll-targeting: votes are only ever read
 *     through the aggregated /polls/:id/results),
 *   - notification create/update: rows are written by the CMS lifecycles
 *     only, and the core PUT had no policy at all,
 *   - comment/kudos/reaction update, lesson-progress update/delete.
 * Their permission rows are revoked for EVERY role below: a removed route
 * leaves its row behind (users-permissions only prunes rows of vanished
 * controller actions), and a revocation without a row costs nothing.
 */
const REMOVED_CORE_ACTIONS: Partial<Record<ContentTypeUid, CrudAction[]>> = {
  "api::poll-vote.poll-vote": ALL_ACTIONS,
  "api::notification.notification": ["create", "update"],
  "api::comment.comment": ["update"],
  "api::kudos.kudos": ["update"],
  "api::reaction.reaction": ["update"],
  "api::lesson-progress.lesson-progress": ["update", "delete"],
};

/**
 * Permissions granted by earlier versions of this bootstrap that must be
 * removed again. The sync (bootstrap/sync-permissions.ts) only ever ADDS
 * rows, so deleting an entry from the matrix above does not revoke
 * anything on an existing database — list the obsolete (role → action)
 * pairs here instead. A grant the code does not want and does not list
 * here is only reported at boot (the drift line), never deleted.
 *
 * Must stay disjoint from PERMISSION_MATRIX, CUSTOM_ACTION_GRANTS and the
 * user reads — pinned by routes.matrix.test.ts. (A pair that is both
 * revoked and a custom grant stays granted: the sync keeps it.)
 */
const LEGACY_REVOKED_PERMISSIONS: Partial<Record<MatrixRoleType, string[]>> = {
  guest: [
    // NOTE: user.find/findOne are intentionally NOT revoked — doing so
    // 400s every guest read that populates a user relation (and the
    // notification visibility filter). See the guest matrix note above.
    "api::kudos.kudos.find",
    "api::kudos.kudos.findOne",
    "api::kudos.kudos.celebrations",
    // guest cannot read announcements, so acknowledgement grants were
    // useless attack surface — see the guest matrix note above.
    "api::acknowledgement.acknowledgement.find",
    "api::acknowledgement.acknowledgement.findOne",
    "api::acknowledgement.acknowledgement.create",
    // Flea market is internal-only (ads populate author.email/jobTitle);
    // an early version of this bootstrap granted guest read access.
    "api::classified.classified.find",
    "api::classified.classified.findOne",
  ],
  authenticated: [
    // Excluded from the celebrations grant (see CUSTOM_ACTION_GRANTS), but
    // an earlier bootstrap granted it, and the row survived on existing
    // databases (found by infra/diagnostics/prod-perm-diff.sql).
    "api::kudos.kudos.celebrations",
  ],
};

const MATRIX_ROLES = Object.keys(PERMISSION_MATRIX) as MatrixRoleType[];

export const REVOKED_PERMISSIONS: Record<string, string[]> = Object.fromEntries(
  MATRIX_ROLES.map((roleType) => [
    roleType,
    [
      ...(LEGACY_REVOKED_PERMISSIONS[roleType] ?? []),
      ...Object.entries(REMOVED_CORE_ACTIONS).flatMap(([uid, actions]) =>
        (actions ?? []).map((action) => `${uid}.${action}`),
      ),
    ],
  ]),
);

/** Where a desired grant comes from (prod-perm-diff.sql's `source` column). */
export type GrantSource = "matrix" | "user_read" | "custom";

/** One (role type, action) pair the bootstrap sync converges to. */
export interface DesiredGrant {
  role: string;
  action: string;
  sources: GrantSource[];
}

/** One (role type, action) pair of REVOKED_PERMISSIONS. */
export interface RoleAction {
  role: string;
  action: string;
}

/** The inputs of the set computations below; the constants above by default. */
export interface PermissionConstants {
  matrix: Readonly<Record<string, Readonly<Partial<Record<string, readonly string[]>>>>>;
  /** Granted to EVERY role of `matrix` (user.find/findOne/me). */
  userReadActions: readonly string[];
  customActionGrants: Readonly<Record<string, readonly string[] | "*">>;
  revoked: Readonly<Record<string, readonly string[]>>;
}

export const PERMISSION_CONSTANTS: PermissionConstants = {
  matrix: PERMISSION_MATRIX,
  userReadActions: USER_READ_ACTIONS,
  customActionGrants: CUSTOM_ACTION_GRANTS,
  revoked: REVOKED_PERMISSIONS,
};

/**
 * The (role, action) set the bootstrap sync converges to, computed in the
 * order the sync applies it: the matrix grants and the user reads are
 * ensured, REVOKED_PERMISSIONS is deleted, then CUSTOM_ACTION_GRANTS is
 * ensured, so a pair that is both revoked and a custom grant ends up
 * present. `*` means every role of the matrix, `authenticated` included.
 * prod-perm-diff.test.ts builds infra/diagnostics/prod-perm-diff.sql from it.
 */
export function computeDesiredGrants(
  constants: PermissionConstants = PERMISSION_CONSTANTS,
): DesiredGrant[] {
  const grants = new Map<string, DesiredGrant>();
  const add = (role: string, action: string, source: GrantSource) => {
    const key = `${role} ${action}`;
    const grant = grants.get(key) ?? { role, action, sources: [] };
    if (!grant.sources.includes(source)) grant.sources.push(source);
    grants.set(key, grant);
  };

  for (const [role, matrix] of Object.entries(constants.matrix)) {
    for (const [uid, actions] of Object.entries(matrix)) {
      for (const action of actions ?? []) add(role, `${uid}.${action}`, "matrix");
    }
    for (const action of constants.userReadActions) add(role, `${USER_UID}.${action}`, "user_read");
  }
  for (const { role, action } of computeRevocations(constants)) grants.delete(`${role} ${action}`);
  const allRoles = Object.keys(constants.matrix);
  for (const [action, grant] of Object.entries(constants.customActionGrants)) {
    for (const role of grant === "*" ? allRoles : grant) add(role, action, "custom");
  }
  return [...grants.values()];
}

/** Every REVOKED_PERMISSIONS pair, as listed. */
export function computeRevocations(
  constants: PermissionConstants = PERMISSION_CONSTANTS,
): RoleAction[] {
  return Object.entries(constants.revoked).flatMap(([role, actions]) =>
    actions.map((action) => ({ role, action })),
  );
}
