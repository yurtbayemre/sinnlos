/**
 * POST /api/auth/uploads/access (v0.34, B1; utils/upload-access.ts): the web
 * server asks whether the viewer may open one uploaded file before its
 * /uploads proxy fetches the bytes.
 *
 * The viewer is authenticated like every content-API request, by the
 * users-permissions strategy only (no API token): blocked accounts, stale
 * token versions and deleted users are refused before the controller, and a
 * restricted session (second factor not set up) gets the MFA gate's 403,
 * since this action is not in its allowlist. Every role holds the grant
 * (bootstrap/permission-matrix.ts). On top, the controller takes only the
 * web server, by the shared INTERNAL_UPLOAD_TOKEN (header x-internal-token),
 * and answers 404 without it. Under /api/auth the edges route the path to
 * the web, never here, and auth-path-guard 404s other spellings.
 */
export default {
  routes: [
    {
      method: "POST",
      path: "/auth/uploads/access",
      handler: "api::upload-access.upload-access.check",
      config: { auth: { strategies: ["users-permissions"] }, policies: [] },
    },
  ],
};
