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
  "api::announcement.announcement",
  "api::comment.comment",
  "api::department.department",
  "api::document.document",
  "api::event.event",
  "api::kudos.kudos",
  "api::notification.notification",
  "api::poll.poll",
  "api::poll-vote.poll-vote",
  "api::reaction.reaction",
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
 * manage; the `is-department-head`, `is-team-member-or-lead` and
 * `can-edit-wiki` policies still scope those updates to their own
 * department/team/authored pages.
 *
 * `member` can update wiki pages they authored (gated by
 * `can-edit-wiki`). `guest` is strict read-only on wiki content.
 */
const PERMISSION_MATRIX: Record<string, Partial<Record<ContentTypeUid, CrudAction[]>>> = {
  admin_role: {
    "api::announcement.announcement": ALL_ACTIONS,
    "api::comment.comment": ALL_ACTIONS,
    "api::department.department": ALL_ACTIONS,
    "api::document.document": ALL_ACTIONS,
    "api::event.event": ALL_ACTIONS,
    "api::kudos.kudos": ALL_ACTIONS,
    "api::notification.notification": ALL_ACTIONS,
    "api::poll.poll": ALL_ACTIONS,
    "api::poll-vote.poll-vote": ALL_ACTIONS,
    "api::reaction.reaction": ALL_ACTIONS,
    "api::team.team": ALL_ACTIONS,
    "api::wiki-space.wiki-space": ALL_ACTIONS,
    "api::wiki-page.wiki-page": ALL_ACTIONS,
    "api::wiki-revision.wiki-revision": ALL_ACTIONS,
  },
  editor: {
    "api::announcement.announcement": ALL_ACTIONS,
    "api::comment.comment": ALL_ACTIONS,
    "api::department.department": READ_ACTIONS,
    "api::document.document": ALL_ACTIONS,
    "api::event.event": ALL_ACTIONS,
    "api::kudos.kudos": ALL_ACTIONS,
    "api::notification.notification": ALL_ACTIONS,
    "api::poll.poll": ALL_ACTIONS,
    "api::poll-vote.poll-vote": ALL_ACTIONS,
    "api::reaction.reaction": ALL_ACTIONS,
    "api::team.team": READ_ACTIONS,
    "api::wiki-space.wiki-space": ALL_ACTIONS,
    "api::wiki-page.wiki-page": ALL_ACTIONS,
    "api::wiki-revision.wiki-revision": ALL_ACTIONS,
  },
  department_head: {
    "api::announcement.announcement": READ_ACTIONS,
    "api::comment.comment": [...READ_ACTIONS, "create", "delete"],
    "api::department.department": [...READ_ACTIONS, "update"],
    "api::document.document": READ_ACTIONS,
    "api::event.event": READ_ACTIONS,
    "api::kudos.kudos": ["find", "findOne", "create"],
    "api::notification.notification": [...READ_ACTIONS, "delete"],
    "api::poll.poll": READ_ACTIONS,
    "api::poll-vote.poll-vote": ["find", "findOne", "create"],
    "api::reaction.reaction": [...READ_ACTIONS, "create", "delete"],
    "api::team.team": [...READ_ACTIONS, "update"],
    "api::wiki-space.wiki-space": READ_ACTIONS,
    "api::wiki-page.wiki-page": [...READ_ACTIONS, "create", "update"],
    "api::wiki-revision.wiki-revision": READ_ACTIONS,
  },
  team_lead: {
    "api::announcement.announcement": READ_ACTIONS,
    "api::comment.comment": [...READ_ACTIONS, "create", "delete"],
    "api::department.department": READ_ACTIONS,
    "api::document.document": READ_ACTIONS,
    "api::event.event": READ_ACTIONS,
    "api::kudos.kudos": ["find", "findOne", "create"],
    "api::notification.notification": [...READ_ACTIONS, "delete"],
    "api::poll.poll": READ_ACTIONS,
    "api::poll-vote.poll-vote": ["find", "findOne", "create"],
    "api::reaction.reaction": [...READ_ACTIONS, "create", "delete"],
    "api::team.team": [...READ_ACTIONS, "update"],
    "api::wiki-space.wiki-space": READ_ACTIONS,
    "api::wiki-page.wiki-page": [...READ_ACTIONS, "create", "update"],
    "api::wiki-revision.wiki-revision": READ_ACTIONS,
  },
  member: {
    "api::announcement.announcement": READ_ACTIONS,
    "api::comment.comment": [...READ_ACTIONS, "create", "delete"],
    "api::department.department": READ_ACTIONS,
    "api::document.document": READ_ACTIONS,
    "api::event.event": READ_ACTIONS,
    "api::kudos.kudos": ["find", "findOne", "create"],
    "api::notification.notification": [...READ_ACTIONS, "delete"],
    "api::poll.poll": READ_ACTIONS,
    "api::poll-vote.poll-vote": ["find", "findOne", "create"],
    "api::reaction.reaction": [...READ_ACTIONS, "create", "delete"],
    "api::team.team": READ_ACTIONS,
    "api::wiki-space.wiki-space": READ_ACTIONS,
    "api::wiki-page.wiki-page": [...READ_ACTIONS, "update"],
    "api::wiki-revision.wiki-revision": READ_ACTIONS,
  },
  guest: {
    "api::comment.comment": READ_ACTIONS,
    "api::document.document": READ_ACTIONS,
    "api::event.event": READ_ACTIONS,
    "api::kudos.kudos": READ_ACTIONS,
    "api::notification.notification": READ_ACTIONS,
    "api::poll.poll": READ_ACTIONS,
    "api::poll-vote.poll-vote": READ_ACTIONS,
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
    "api::announcement.announcement": READ_ACTIONS,
    "api::comment.comment": [...READ_ACTIONS, "create"],
    "api::department.department": READ_ACTIONS,
    "api::document.document": READ_ACTIONS,
    "api::event.event": READ_ACTIONS,
    "api::kudos.kudos": ["find", "findOne", "create"],
    "api::notification.notification": READ_ACTIONS,
    "api::poll.poll": READ_ACTIONS,
    "api::poll-vote.poll-vote": ["find", "findOne", "create"],
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
const CUSTOM_ACTION_GRANTS: Record<string, string[] | "*"> = {
  "api::event.event.ics": "*",
  "api::kudos.kudos.celebrations": "*",
  "api::notification.notification.markRead": "*",
  "api::notification.notification.markAllRead": "*",
  "api::poll-vote.poll-vote.vote": ["admin_role", "editor", "department_head", "team_lead", "member", "authenticated"],
  "api::poll-vote.poll-vote.results": "*",
  // Self-service profile (added in this feature)
  "api::profile.profile.me": "*",
  "api::profile.profile.updateMe": "*",
  // Built-in auth action local users need to change their password
  "plugin::users-permissions.auth.changePassword": "*",
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
  action: CrudAction,
) {
  return ensureActionPermission(strapi, roleId, `${uid}.${action}`);
}

/**
 * Every role that can read content types also needs
 * `plugin::users-permissions.user.find` and `findOne` so that Strapi
 * populates user relations (author, lead, members, head, etc.)
 * instead of silently stripping them from API responses.
 */
const USER_READ_ACTIONS: CrudAction[] = ["find", "findOne"];
const USER_UID = "plugin::users-permissions.user";

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
    for (const action of USER_READ_ACTIONS) {
      const created = await ensurePermission(strapi, role.id, USER_UID, action);
      if (created) granted++;
    }
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
 * Seed a first Strapi admin user from environment variables if the
 * admin_users table is empty. This lets a fresh clone of the repo
 * boot straight into a usable admin panel without the interactive
 * registration form.
 *
 * Env vars (all required together):
 *   STRAPI_ADMIN_EMAIL     — login email for the Super Admin
 *   STRAPI_ADMIN_PASSWORD  — plaintext password, hashed by Strapi on insert
 *   STRAPI_ADMIN_FIRSTNAME — optional, defaults to "Admin"
 *   STRAPI_ADMIN_LASTNAME  — optional, defaults to "User"
 *
 * Safety: runs ONLY when the admin_users table is empty. On every
 * subsequent boot this is a no-op, so rotating the env password does
 * NOT overwrite the existing admin — that has to be done from the
 * admin panel itself.
 *
 * Strapi Community Edition has no admin-panel SSO, so this is the
 * friction-free alternative to clicking through the registration
 * form every time you wipe the SQLite database.
 */
async function seedAdminUser(strapi: any) {
  const email = process.env.STRAPI_ADMIN_EMAIL;
  const password = process.env.STRAPI_ADMIN_PASSWORD;
  if (!email || !password) return;

  const existingCount = await strapi.db.query("admin::user").count({});
  if (existingCount > 0) return;

  const superAdminRole = await strapi.db
    .query("admin::role")
    .findOne({ where: { code: "strapi-super-admin" } });
  if (!superAdminRole) {
    strapi.log.warn("[bootstrap] strapi-super-admin role not found; skipping admin seed");
    return;
  }

  try {
    await strapi.service("admin::user").create({
      firstname: process.env.STRAPI_ADMIN_FIRSTNAME || "Admin",
      lastname: process.env.STRAPI_ADMIN_LASTNAME || "User",
      email,
      password,
      isActive: true,
      blocked: false,
      registrationToken: null,
      roles: [superAdminRole.id],
    });
    strapi.log.info(`[bootstrap] created initial Super Admin ${email}`);
  } catch (err) {
    strapi.log.error(
      `[bootstrap] failed to create initial admin user: ${(err as Error).message}`,
    );
  }
}

export default {
  register(/* { strapi } */) {},

  async bootstrap({ strapi }: { strapi: any }) {
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
  },
};
