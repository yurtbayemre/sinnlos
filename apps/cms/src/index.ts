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
  "api::department.department",
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
    "api::department.department": ALL_ACTIONS,
    "api::team.team": ALL_ACTIONS,
    "api::wiki-space.wiki-space": ALL_ACTIONS,
    "api::wiki-page.wiki-page": ALL_ACTIONS,
    "api::wiki-revision.wiki-revision": ALL_ACTIONS,
  },
  editor: {
    "api::announcement.announcement": ALL_ACTIONS,
    "api::department.department": READ_ACTIONS,
    "api::team.team": READ_ACTIONS,
    "api::wiki-space.wiki-space": ALL_ACTIONS,
    "api::wiki-page.wiki-page": ALL_ACTIONS,
    "api::wiki-revision.wiki-revision": ALL_ACTIONS,
  },
  department_head: {
    "api::announcement.announcement": READ_ACTIONS,
    "api::department.department": [...READ_ACTIONS, "update"],
    "api::team.team": [...READ_ACTIONS, "update"],
    "api::wiki-space.wiki-space": READ_ACTIONS,
    "api::wiki-page.wiki-page": [...READ_ACTIONS, "create", "update"],
    "api::wiki-revision.wiki-revision": READ_ACTIONS,
  },
  team_lead: {
    "api::announcement.announcement": READ_ACTIONS,
    "api::department.department": READ_ACTIONS,
    "api::team.team": [...READ_ACTIONS, "update"],
    "api::wiki-space.wiki-space": READ_ACTIONS,
    "api::wiki-page.wiki-page": [...READ_ACTIONS, "create", "update"],
    "api::wiki-revision.wiki-revision": READ_ACTIONS,
  },
  member: {
    "api::announcement.announcement": READ_ACTIONS,
    "api::department.department": READ_ACTIONS,
    "api::team.team": READ_ACTIONS,
    "api::wiki-space.wiki-space": READ_ACTIONS,
    "api::wiki-page.wiki-page": [...READ_ACTIONS, "update"],
    "api::wiki-revision.wiki-revision": READ_ACTIONS,
  },
  guest: {
    "api::wiki-space.wiki-space": READ_ACTIONS,
    "api::wiki-page.wiki-page": READ_ACTIONS,
  },
};

async function ensurePermission(
  strapi: any,
  roleId: number,
  uid: string,
  action: CrudAction,
) {
  const actionKey = `${uid}.${action}`;
  const existing = await strapi.db
    .query("plugin::users-permissions.permission")
    .findOne({ where: { action: actionKey, role: roleId } });
  if (existing) return false;
  await strapi.db.query("plugin::users-permissions.permission").create({
    data: { action: actionKey, role: roleId },
  });
  return true;
}

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
  }
  if (granted > 0) {
    strapi.log.info(`[bootstrap] granted ${granted} permission(s) across intranet roles`);
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
  },
};
