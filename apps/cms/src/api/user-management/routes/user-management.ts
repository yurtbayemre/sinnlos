/**
 * User administration (v0.23): admin_role only. The grants are admin_role's
 * (CUSTOM_ACTION_GRANTS); the controller checks the role again, even if a
 * grant drifts. No query but the list's; numeric user ids.
 */
export default {
  routes: [
    {
      method: "GET",
      path: "/user-management",
      handler: "api::user-management.user-management.list",
      config: { policies: [] },
    },
    {
      method: "GET",
      path: "/user-management/:id",
      handler: "api::user-management.user-management.findOne",
      config: { policies: [] },
    },
    {
      method: "PUT",
      path: "/user-management/:id",
      handler: "api::user-management.user-management.update",
      config: { policies: [] },
    },
    {
      method: "POST",
      path: "/user-management/:id/role-to-entra",
      handler: "api::user-management.user-management.roleToEntra",
      config: { policies: [] },
    },
  ],
};
