/**
 * POST /api/auth/entra/exchange (D-ENTRA-01 spec D): the web's Auth.js
 * signIn callback trades a completed Microsoft sign-in for a Strapi JWT.
 *
 * auth:false because the caller has no Strapi JWT yet; no users-permissions
 * grant exists or is needed for it. The controller authenticates the caller
 * itself (shared secret + the cms's own ID-token verification) and answers
 * 404 while ENTRA_ENABLED is not '1'. The edge routes /api/auth/* to the web,
 * but that is no protection (case variants reach the cms; the
 * auth-path-guard middleware 404s them).
 */
export default {
  routes: [
    {
      method: "POST",
      path: "/auth/entra/exchange",
      handler: "api::entra-auth.entra-auth.exchange",
      config: { auth: false, policies: [] },
    },
  ],
};
