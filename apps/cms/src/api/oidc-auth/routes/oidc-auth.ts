/**
 * POST /api/auth/oidc/exchange (v0.25.0, deep-dive plan-oidc.md): the web's
 * Auth.js signIn callback trades a completed OIDC sign-in for a Strapi JWT,
 * like the Entra route (api/entra-auth). auth:false because the caller has
 * no Strapi JWT yet; the controller authenticates the caller itself (shared
 * secret + the cms's own ID-token verification) and answers 404 while
 * OIDC_ENABLED is not '1'. Case variants are refused by the auth-path-guard
 * middleware.
 */
export default {
  routes: [
    {
      method: "POST",
      path: "/auth/oidc/exchange",
      handler: "api::oidc-auth.oidc-auth.exchange",
      config: { auth: false, policies: [] },
    },
  ],
};
