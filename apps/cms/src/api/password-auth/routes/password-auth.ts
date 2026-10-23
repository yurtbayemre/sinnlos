/**
 * The set-password links of local accounts (v0.27, utils/password-link.ts):
 * the web server asks for a reset link and redeems a link. auth:false like
 * the identity-provider exchanges: the caller has no JWT. The controller
 * takes only the web server, by the shared secret INTERNAL_UPLOAD_TOKEN
 * (header x-internal-token), and answers 404 without it. The edge routes
 * /api/auth/* to the web; case variants are 404'd by auth-path-guard.
 */
export default {
  routes: [
    {
      method: "POST",
      path: "/auth/password/forgot",
      handler: "api::password-auth.password-auth.forgot",
      config: { auth: false, policies: [] },
    },
    {
      method: "POST",
      path: "/auth/password/set",
      handler: "api::password-auth.password-auth.set",
      config: { auth: false, policies: [] },
    },
  ],
};
