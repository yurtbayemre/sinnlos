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
    // v0.27: invitations, set-password links and second-factor resets.
    {
      method: "POST",
      path: "/user-management/invite",
      handler: "api::user-management.user-management.invite",
      config: { policies: [] },
    },
    {
      method: "POST",
      path: "/user-management/:id/send-link",
      handler: "api::user-management.user-management.sendLink",
      config: { policies: [] },
    },
    {
      method: "POST",
      path: "/user-management/:id/reset-mfa",
      handler: "api::user-management.user-management.resetMfa",
      config: { policies: [] },
    },
  ],
};
