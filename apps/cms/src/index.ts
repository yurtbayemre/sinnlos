import {
  assertTimestamptzContract,
  prepareDatetimeContract,
  registerTimestamptzGuard,
} from "./database/ensure-timestamptz";
import { reportDigestConfig } from "./digest/send-digests";
import { seedAdminUser } from "./utils/admin-seed";
import { hasAudienceBypass } from "./utils/announcement-audience";
import { enforceSecretGuard } from "./utils/env-guard";
import { registerLiveEventSubscriber } from "./utils/live-events";
import { assertNoOrgDrafts } from "./utils/org-dp-guard";
import {
  RESTRICTED_RELATION_TARGETS,
  guardRestrictedRelations,
  stripRestrictedRelationsFromOutput,
  type RelationModel,
} from "./utils/restricted-relations";
import { pickContentApiQueryParams, type RouteWithQuerySchema } from "./utils/rest-query-params";
import { shouldSanitizeForRole, stripSensitiveUserFields } from "./utils/sanitize-user-contact";

/**
 * Strapi application lifecycle.
 *
 * On first boot, we ensure the six intranet roles exist in the
 * users-permissions plugin AND that each role is granted sensible
 * default REST permissions on the intranet content types. Writes are
 * additionally gated by route-level policies (see
 * `src/api/*\/routes/*.ts` and `src/policies/*.ts`), so granting
 * create/update/delete here does NOT bypass the policy checks — it
 * simply lets the policies run.
 *
 * Without this, Strapi's users-permissions plugin returns 403 on every
 * `/api/*` call, because a freshly-created role has zero permissions.
 */
type RoleSeed = {
  name: string;
  type: string;
  description: string;
};

const ROLES: RoleSeed[] = [
  {
    name: "Admin",
    type: "admin_role",
    description: "Full CRUD across the intranet + user management",
  },
  {
    name: "Editor",
    type: "editor",
    description: "Full CRUD over wiki and announcements",
  },
  {
    name: "Department Head",
    type: "department_head",
    description: "Manages their own department + its teams and pages",
  },
  {
    name: "Team Lead",
    type: "team_lead",
    description: "Manages their own team pages and members",
  },
  {
    name: "Member",
    type: "member",
    description: "Reads everything their scope permits + edits own profile",
  },
  {
    name: "Guest",
    type: "guest",
    description: "Read-only access to public wiki spaces",
  },
];

/**
 * Intranet content types. We grant explicit permissions on each
 * per role; everything else stays untouched.
 */
const CONTENT_TYPES = [
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

type ContentTypeUid = (typeof CONTENT_TYPES)[number];
type CrudAction = "find" | "findOne" | "create" | "update" | "delete";

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
 * Exported (with CUSTOM_ACTION_GRANTS and REVOKED_PERMISSIONS) only for
 * the route/grant cross-check in `routes.matrix.test.ts` (roadmap S01).
 */
export const PERMISSION_MATRIX: Record<string, Partial<Record<ContentTypeUid, CrudAction[]>>> = {
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
   * `guest` is strictly read-only. It is denied kudos (celebrations
   * populate user relations and leak hire dates), but it DOES keep the
   * baseline `users-permissions.user.find/findOne` grant handed out to
   * every reading role below.
   *
   * OPEN ISSUE — guest still sees employee contact data: user.find/findOne
   * cannot be revoked from guest without breaking the app. Strapi's core
   * controllers run validateQuery (→ throwRestrictedRelations) BEFORE
   * sanitizeQuery, so every FILTER through a user relation — the
   * notification visibility filter references the `recipient` user
   * relation — throws a 400 for a role lacking `user.find`. Populates of a
   * user relation (wiki-page.author, comment.author, document.uploadedBy,
   * department.head, team.lead, ...) threw the same 400 on 5.49; in
   * @strapi/utils 5.55.1 validatePopulate no longer checks the scope and
   * sanitizePopulate silently drops the relation instead, so without
   * user.find guest pages would lose every author/uploader name. So guest
   * keeps user.find; the email/phone/hireDate
   * it could therefore read from the directory are now removed OUTPUT-side by
   * a role-aware content-api.output sanitizer (registerUserContactSanitizer
   * below → utils/sanitize-user-contact.ts, issue #10): it covers both direct
   * /api/users reads and POPULATED user relations, runs AFTER
   * validateQuery/sanitizeQuery (so it never trips throwRestrictedRelations),
   * and strips only for non-privileged callers (guest/authenticated/public/
   * unknown). Verified via node repro against @strapi/utils 5.49 (collection-
   * type controller order + validateFilters/throwRestrictedRelations); the
   * populate change above is from the 5.55.1 validate/sanitize sources.
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
   * `authenticated` is the users-permissions built-in default role.
   * A newly-registered OAuth user is assigned it before our Microsoft
   * callback extension has a chance to re-map them to one of the six
   * intranet roles above. If that reassignment fails (missing access
   * token, Graph hiccup, race on first login, ...), the user would
   * otherwise be stuck with zero permissions and hit 403 on every
   * `/api/*` call. Grant baseline reads on the intranet content types
   * so the dashboard works even in that fallback case.
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
export const CUSTOM_ACTION_GRANTS: Record<string, string[] | "*"> = {
  "api::event.event.ics": "*",
  // guest and the `authenticated` fallback are excluded: even with email
  // dropped from the payload, years + daysUntil still reconstruct every
  // user's exact hireDate, so this stays limited to the mapped staff roles.
  "api::kudos.kudos.celebrations": [
    "admin_role",
    "editor",
    "department_head",
    "team_lead",
    "member",
  ],
  "api::notification.notification.markRead": "*",
  "api::notification.notification.markAllRead": "*",
  "api::poll-vote.poll-vote.vote": [
    "admin_role",
    "editor",
    "department_head",
    "team_lead",
    "member",
    "authenticated",
  ],
  "api::poll-vote.poll-vote.results": "*",
  // Aggregated search analytics (issue #19) — /manage/analytics is
  // admin-only, so is the summary endpoint.
  "api::search-log.search-log.summary": ["admin_role"],
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
  "plugin::users-permissions.role.find": ["admin_role"],
  // Marketplace ad photos: employees may CREATE uploads via POST
  // /api/upload — deliberately NOT `find`/`findOne`/`destroy` on the
  // upload content-api (no browsing or deleting of the media library from
  // outside the admin panel). guest and the `authenticated` fallback get
  // nothing. The route itself is additionally hardened (image-only magic
  // byte allowlist, 5 MB, create-only) in extensions/upload/strapi-server.ts.
  "plugin::upload.content-api.upload": [
    "admin_role",
    "editor",
    "department_head",
    "team_lead",
    "member",
  ],
  // Best-effort orphan cleanup for the two-step ad flow (issue #13): same
  // five posting roles as the upload grant above, never guest. The action
  // only ever deletes files stamped with the CALLER's own
  // provider_metadata.uploadedBy and without any remaining relation — see
  // controllers/classified.ts.
  "api::classified.classified.cleanupUploads": [
    "admin_role",
    "editor",
    "department_head",
    "team_lead",
    "member",
  ],
};

async function ensureActionPermission(strapi: any, roleId: number, actionKey: string) {
  const existing = await strapi.db
    .query("plugin::users-permissions.permission")
    .findOne({ where: { action: actionKey, role: roleId } });
  if (existing) return false;
  await strapi.db.query("plugin::users-permissions.permission").create({
    data: { action: actionKey, role: roleId },
  });
  return true;
}

async function ensurePermission(
  strapi: any,
  roleId: number,
  uid: string,
  action: CrudAction | "me",
) {
  return ensureActionPermission(strapi, roleId, `${uid}.${action}`);
}

/**
 * Every role that can read content types also needs
 * `plugin::users-permissions.user.find` and `findOne` so that Strapi
 * populates user relations (author, lead, members, head, etc.)
 * instead of throwing a 400 on any query that populates them.
 *
 * This applies to `guest` too: revoking it (as an earlier audit attempt
 * did) turned every guest read that populates a user relation — and the
 * notification visibility filter — into a 400. See the OPEN
 * ISSUE note on the `guest` matrix above. No role is excluded.
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
export const USER_READ_EXCLUDED_ROLES: string[] = [];

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
 * controller actions), and deleteMany is a no-op where none exists.
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
 * removed again. `ensurePermission` only ever ADDS rows, so deleting an
 * entry from the matrix above does not revoke anything on an existing
 * database — list the obsolete (role → action) pairs here instead.
 *
 * Must stay disjoint from PERMISSION_MATRIX, CUSTOM_ACTION_GRANTS and the
 * user reads (otherwise every boot re-adds and deletes the same row) —
 * pinned by routes.matrix.test.ts.
 */
const LEGACY_REVOKED_PERMISSIONS: Record<string, string[]> = {
  guest: [
    // NOTE: user.find/findOne are intentionally NOT revoked — doing so
    // 400s every guest read that populates a user relation (and the
    // notification visibility filter). See the guest matrix OPEN ISSUE
    // note above.
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

export const REVOKED_PERMISSIONS: Record<string, string[]> = Object.fromEntries(
  Object.keys(PERMISSION_MATRIX).map((roleType) => [
    roleType,
    [
      ...(LEGACY_REVOKED_PERMISSIONS[roleType] ?? []),
      ...Object.entries(REMOVED_CORE_ACTIONS).flatMap(([uid, actions]) =>
        (actions ?? []).map((action) => `${uid}.${action}`),
      ),
    ],
  ]),
);

async function syncRolePermissions(strapi: any) {
  let granted = 0;
  for (const [roleType, matrix] of Object.entries(PERMISSION_MATRIX)) {
    const role = await strapi.db
      .query("plugin::users-permissions.role")
      .findOne({ where: { type: roleType } });
    if (!role) {
      strapi.log.warn(`[bootstrap] role ${roleType} not found, skipping permissions`);
      continue;
    }
    for (const [uid, actions] of Object.entries(matrix)) {
      if (!actions) continue;
      for (const action of actions) {
        const created = await ensurePermission(strapi, role.id, uid, action);
        if (created) granted++;
      }
    }
    // Grant read access to users so populated relations work
    // (except for the roles excluded above — see USER_READ_EXCLUDED_ROLES).
    if (!USER_READ_EXCLUDED_ROLES.includes(roleType)) {
      for (const action of USER_READ_ACTIONS) {
        const created = await ensurePermission(strapi, role.id, USER_UID, action);
        if (created) granted++;
      }
    }
  }

  // Remove permissions that older bootstrap versions handed out.
  let revoked = 0;
  for (const [roleType, actions] of Object.entries(REVOKED_PERMISSIONS)) {
    const role = await strapi.db
      .query("plugin::users-permissions.role")
      .findOne({ where: { type: roleType } });
    if (!role) continue;
    for (const action of actions) {
      const { count } = await strapi.db
        .query("plugin::users-permissions.permission")
        .deleteMany({ where: { action, role: role.id } });
      revoked += count ?? 0;
    }
  }
  if (revoked > 0) {
    strapi.log.info(`[bootstrap] revoked ${revoked} obsolete permission(s)`);
  }

  // Custom (non-CRUD) route actions — see CUSTOM_ACTION_GRANTS.
  const allRoleTypes = Object.keys(PERMISSION_MATRIX);
  for (const [actionKey, grant] of Object.entries(CUSTOM_ACTION_GRANTS)) {
    const roleTypes = grant === "*" ? allRoleTypes : grant;
    for (const roleType of roleTypes) {
      const role = await strapi.db
        .query("plugin::users-permissions.role")
        .findOne({ where: { type: roleType } });
      if (!role) {
        strapi.log.warn(
          `[bootstrap] role ${roleType} not found, skipping custom action ${actionKey}`,
        );
        continue;
      }
      const created = await ensureActionPermission(strapi, role.id, actionKey);
      if (created) granted++;
    }
  }

  if (granted > 0) {
    strapi.log.info(`[bootstrap] granted ${granted} permission(s) across intranet roles`);
  }
}

/**
 * Sync the users-permissions "advanced" settings from env so standalone
 * (no-Microsoft) deployments work out of the box:
 *   - default_role: new local registrations land on `member` (a real
 *     intranet role) instead of the bare `authenticated` fallback.
 *   - allow_register: controlled by LOCAL_REGISTRATION=1 (default off —
 *     admins create accounts in the Strapi panel).
 *   - email_confirmation: off; self-hosted installs rarely have SMTP.
 */
async function syncAdvancedSettings(strapi: any) {
  const store = strapi.store({ type: "plugin", name: "users-permissions", key: "advanced" });
  const current = (await store.get()) ?? {};
  const allowRegister = process.env.LOCAL_REGISTRATION === "1";

  const next = {
    ...current,
    unique_email: true,
    allow_register: allowRegister,
    email_confirmation: false,
    default_role: "member",
  };

  if (JSON.stringify(next) !== JSON.stringify(current)) {
    await store.set({ value: next });
    strapi.log.info(
      `[bootstrap] users-permissions advanced settings synced (allow_register=${allowRegister}, default_role=member)`,
    );
  }
}

/**
 * Register a role-aware `content-api.output` sanitizer that removes employee
 * contact fields (email/phone/hireDate/officeLocation/microsoftOid) from
 * every response served to a non-privileged caller — the directory itself
 * (/api/users*, /api/users/me) AND every populated user relation in any
 * content type (announcement/wiki author, document.uploadedBy,
 * event.organizer, notification.actor, comment/reaction author, manager,
 * directReports, team.members, …). Issue #10 / P1.2.
 *
 * WHY output-side and role-aware instead of revoking guest's `user.find` or
 * marking the fields schema-`private`: see the OPEN ISSUE note on the guest
 * matrix above and `utils/sanitize-user-contact.ts`. Revoking `user.find`
 * 400s every guest read that populates/filters a user relation; `private`
 * would hide the fields from the member+ directory and /people too.
 *
 * WHY `set`-append and NOT `strapi.sanitizers.add(...)`: the sanitizers
 * registry's `add(path, fn)` reads the target list with a FRESH `[]` default
 * when the path is uninitialized and pushes onto that throwaway array — it
 * does not persist (verified against @strapi/core 5.49 and 5.55.1
 * registries/sanitizers.js; `content-api.output` is never pre-`set`). A plain
 * `.add` here would be a silent no-op. We read the current list (default [])
 * and `set` it back with our factory appended, which also initializes the
 * path so any later `.add` behaves.
 *
 * The factory is appended as the LAST output transform, so it runs AFTER
 * validateQuery/sanitizeQuery (never triggers throwRestrictedRelations) and
 * AFTER the core sanitizers (private/restricted-relation removal). It reads
 * the caller's role from the request AsyncLocalStorage — the same source the
 * controllers use for their `role.type` checks. No request context
 * (lifecycles, seed, cron, internal document-service reads) ⇒ never strip, so
 * internal callers keep email/phone/hireDate.
 */
export function registerUserContactSanitizer(strapi: any) {
  const factory = (schema: any) => (data: any) => {
    const ctx = strapi.requestContext.get();
    // No HTTP request in scope → internal call; leave the data untouched.
    if (!ctx) return data;
    if (!shouldSanitizeForRole(ctx.state?.user?.role?.type)) return data;
    return stripSensitiveUserFields(data, schema, {
      getModel: (uid: string) => strapi.getModel(uid),
    });
  };

  const current = strapi.sanitizers.get("content-api.output");
  strapi.sanitizers.set("content-api.output", [...current, factory]);
}

type SanitizeQuery = (
  query: Record<string, unknown>,
  schema: RelationModel,
  options?: { route?: RouteWithQuerySchema | null; [option: string]: unknown },
) => Promise<Record<string, unknown>>;

/** The slice of the Strapi instance registerRestrictedRelationGuard touches. */
export interface RestrictedRelationGuardHost {
  getModel: (uid: string) => RelationModel | undefined;
  requestContext: {
    get: () => { state?: { user?: { role?: { type?: string } | null } | null } } | undefined;
  };
  sanitizers: {
    get: (path: string) => unknown[];
    set: (path: string, value: unknown[]) => unknown;
  };
  contentAPI?: { sanitize?: { query?: SanitizeQuery } };
}

/**
 * Cuts relation side channels into visibility-filtered types (FX05, rules
 * and walk in utils/restricted-relations.ts) on EVERY content-api route:
 * core, users-permissions (/api/users, /api/users/me) and upload alike, and
 * writes as well as reads, since an update's `?populate` shapes its response.
 *
 * Query side — WHY a wrapper around `strapi.contentAPI.sanitize.query` and
 * not a sanitizer registry entry or a route policy: the registry only has
 * `content-api.input` and `content-api.output` hooks (@strapi/core 5.49 and
 * 5.55.1 services/content-api/index.js), and a route policy misses every route it
 * is not attached to. The first FX05 cut, a policy on department/team reads,
 * left /api/users?populate[department][populate][pages] and PUT
 * /api/teams/:id?populate[pages] open. Every content-api controller resolves
 * `strapi.contentAPI.sanitize.query` at call time (core-api controller,
 * users-permissions user controller, upload content-api) and hands its
 * RESULT to the service, so one wrapper covers them all. It runs on the
 * sanitized query, after validateQuery: a rewritten populate can no longer
 * turn into a validation 400 (the wildcard expansion 400'd on the private
 * createdBy/updatedBy before), and a rejected filter/sort path throws the
 * core's own `Invalid key` 400.
 *
 * Output side — a `content-api.output` sanitizer that deletes restricted
 * relations from every response entity: the backstop for a controller that
 * populates without going through sanitize.query. Appended via get()+set(),
 * never `.add` (silent no-op, see registerUserContactSanitizer).
 *
 * Root keys (final review C1-RAW-WHERE) — the same wrapper first drops
 * every root key outside the content-api allowlist
 * (utils/rest-query-params.ts). The core sanitizer keeps unknown keys, and
 * users-permissions and upload hand them to `strapi.db.query`, so a raw
 * `?where[department][pages][body]…` or `?orderBy`/`?select` skipped every
 * check above. This pick applies to EVERY caller, admin_role and editor
 * included: `where` also reaches private fields (password hash, reset
 * token) that no role may probe.
 *
 * admin_role / editor bypass the relation cut on both sides. They see every
 * wiki page anyway (wiki-visibility bypass). The role comes from the request
 * AsyncLocalStorage, as in registerUserContactSanitizer. Without a request
 * context the guard APPLIES (fail closed): nothing internal reads through
 * the content API.
 *
 * Fails loudly: if a Strapi upgrade moves `contentAPI.sanitize.query`, boot
 * throws instead of silently re-opening the side channel.
 */
export function registerRestrictedRelationGuard(strapi: RestrictedRelationGuardHost) {
  const sanitize = strapi.contentAPI?.sanitize;
  const sanitizeQuery = sanitize?.query;
  if (!sanitize || typeof sanitizeQuery !== "function") {
    throw new Error(
      "[restricted-relations] strapi.contentAPI.sanitize.query not found — refusing to boot without the FX05 guard",
    );
  }

  const options = {
    getModel: (uid: string) => strapi.getModel(uid),
    rules: RESTRICTED_RELATION_TARGETS,
  };
  const bypass = () => hasAudienceBypass(strapi.requestContext.get()?.state?.user?.role?.type);

  sanitize.query = async (query, schema, sanitizeOptions) => {
    const sanitized = pickContentApiQueryParams(
      await sanitizeQuery.call(sanitize, query, schema, sanitizeOptions),
      sanitizeOptions?.route,
    );
    if (bypass()) return sanitized;
    return guardRestrictedRelations(sanitized, schema, options);
  };

  const factory = (schema: RelationModel) => (data: unknown) =>
    bypass() ? data : stripRestrictedRelationsFromOutput(data, schema, options);
  const current = strapi.sanitizers.get("content-api.output");
  strapi.sanitizers.set("content-api.output", [...current, factory]);
}

export default {
  async register({ strapi }: { strapi: any }) {
    // Decision 05: refuse to boot while department/team hold draft rows.
    // Strapi would delete them in the beforeSync hook right after register()
    // (draftAndPublish true -> false). FIRST, so nothing in register() runs
    // on such a database; see utils/org-dp-guard.ts.
    await assertNoOrgDrafts(strapi);
    // Datetime contract (database/ensure-timestamptz.ts): log the zones,
    // verify the DB session runs in UTC, refuse a non-UTC process on a fresh
    // database, before the one-time repair or (beforeSync hook) on a boot
    // that migrates or changes the schema, and convert every naive
    // timestamp column right after schema sync (afterSync hook).
    await prepareDatetimeContract(strapi);
    registerTimestamptzGuard(strapi);
    // FX13: refuse to boot in production with template placeholder secrets
    // (change-me / toBeModified / <secret>); outside production it only warns.
    enforceSecretGuard(process.env, strapi.log);
    registerUserContactSanitizer(strapi);
    registerRestrictedRelationGuard(strapi);
  },

  async bootstrap({ strapi }: { strapi: any }) {
    // Datetime contract: no start while any column is still timestamp
    // without time zone (retries what afterSync could not convert).
    await assertTimestamptzContract(strapi);

    // Live-update pings for the web SSE bus (issue #17/#27). Registered
    // before any seeding so bulk writes exercise the batching path; the
    // emitter itself no-ops unless WEB_INTERNAL_URL is set.
    registerLiveEventSubscriber(strapi);

    for (const seed of ROLES) {
      const existing = await strapi.db
        .query("plugin::users-permissions.role")
        .findOne({ where: { type: seed.type } });
      if (!existing) {
        await strapi.db.query("plugin::users-permissions.role").create({
          data: { ...seed },
        });
        strapi.log.info(`[bootstrap] created role ${seed.type}`);
      }
    }

    await syncRolePermissions(strapi);
    await syncAdvancedSettings(strapi);
    await seedAdminUser(strapi);
    // FX13 review: SMTP set without DIGEST_FROM / PUBLIC_WEB_URL (the owner
    // defaults are gone) → say so at boot, not only at the 07:30 run.
    reportDigestConfig(strapi.log);

    const { seedDemoData } = await import("./seed-demo");
    await seedDemoData(strapi);
  },
};
