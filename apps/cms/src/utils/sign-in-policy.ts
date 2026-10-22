/**
 * Which sign-in paths the cms serves (plan-oidc.md C1). One rule, mirrored
 * by the web's lib/auth-config.ts localSignInEnabled:
 *   - local e-mail + password (POST /api/auth/local, users-permissions'
 *     grant.email, bootstrap/auth-providers.ts): AUTH_LOCAL_ENABLED=1 next
 *     to an identity provider (break-glass), or no identity provider on;
 */

type Env = Record<string, string | undefined>;

export function localSignInEnabled(env: Env = process.env): boolean {
  return env.AUTH_LOCAL_ENABLED === "1" || (env.ENTRA_ENABLED !== "1" && env.OIDC_ENABLED !== "1");
}
