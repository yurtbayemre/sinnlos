import { MODERATORS } from "../bootstrap/roles";

/**
 * Allows access only if the authenticated user belongs to the
 * admin_role or editor Strapi role (MODERATORS, bootstrap/roles.ts).
 */
export default (policyContext: any, _config: unknown, { strapi: _strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user?.role?.type) return false;
  return MODERATORS.includes(user.role.type);
};
