/**
 * Which sign-in paths the cms serves (plan-oidc.md C1). One rule, mirrored
 * by the web's lib/auth-config.ts localSignInEnabled:
 *   - local e-mail + password (POST /api/auth/local, users-permissions'
 *     grant.email, bootstrap/auth-providers.ts): AUTH_LOCAL_ENABLED=1 next
 *     to an identity provider (break-glass), or no identity provider on;
 *   - OIDC_ENABLED=1 refuses the boot until v0.25.0 ships the OIDC sign-in.
 */

type Env = Record<string, string | undefined>;

export function localSignInEnabled(env: Env = process.env): boolean {
  return env.AUTH_LOCAL_ENABLED === "1" || (env.ENTRA_ENABLED !== "1" && env.OIDC_ENABLED !== "1");
}

/**
 * register(): throws for OIDC_ENABLED=1.
 * shortcut: OIDC sign-in arrives with v0.25.0 (plan-oidc.md); until then the
 * flag would only switch local sign-in off. Remove with the adapter.
 */
export function refuseOidcBeforeAdapter(env: Env = process.env): void {
  if (env.OIDC_ENABLED === "1") {
    throw new Error(
      "[auth] OIDC_ENABLED=1, but OIDC sign-in arrives with v0.25.0. Unset OIDC_ENABLED.",
    );
  }
}
