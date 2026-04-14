/**
 * Strapi application lifecycle.
 *
 * On first boot, we ensure the five intranet roles exist in the
 * users-permissions plugin. Roles are keyed by their `type` field
 * (lowercase, snake_case) which is what our policies check against.
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
  },
};
