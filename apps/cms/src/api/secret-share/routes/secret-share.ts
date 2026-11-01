/**
 * Secret sharing (v0.35.0, docs/plan-v035-secret-sharing.md §3.9): custom
 * routes only, no core router. Granted to the five staff roles
 * (CUSTOM_ACTION_GRANTS), revoked for guest, `authenticated` and `public`;
 * none is in the restricted-session allowlist. The `secrets` switch puts
 * global::module-enabled in front of each (utils/module-switches.ts). The
 * controller checks the caller again; the module comment of
 * utils/secret-shares.ts holds the rules.
 */
export default {
  routes: [
    {
      method: "GET",
      path: "/secret-shares",
      handler: "api::secret-share.secret-share.list",
      config: { policies: [] },
    },
    {
      method: "POST",
      path: "/secret-shares",
      handler: "api::secret-share.secret-share.create",
      config: { policies: [] },
    },
    // Before /secret-shares/:id, which would otherwise take "recipients" as an id.
    {
      method: "GET",
      path: "/secret-shares/recipients",
      handler: "api::secret-share.secret-share.recipients",
      config: { policies: [] },
    },
    {
      method: "GET",
      path: "/secret-shares/:id",
      handler: "api::secret-share.secret-share.findOne",
      config: { policies: [] },
    },
    {
      method: "POST",
      path: "/secret-shares/:id/reveal",
      handler: "api::secret-share.secret-share.reveal",
      config: { policies: [] },
    },
    {
      method: "POST",
      path: "/secret-shares/:id/revoke",
      handler: "api::secret-share.secret-share.revoke",
      config: { policies: [] },
    },
  ],
};
