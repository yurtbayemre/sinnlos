import { MODERATORS, hasRole, type RoleHolder } from "../bootstrap/roles";

/**
 * Allows access only if the authenticated user belongs to the
 * admin_role or editor Strapi role (MODERATORS, bootstrap/roles.ts).
 */
export default (
  policyContext: { state?: { user?: RoleHolder | null } },
  _config?: unknown,
  _deps?: unknown,
): boolean => hasRole(policyContext.state?.user, MODERATORS);
