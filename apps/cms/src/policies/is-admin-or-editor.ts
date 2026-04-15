/**
 * Allows access only if the authenticated user belongs to the
 * admin_role or editor Strapi role.
 */
export default (policyContext: any, _config: unknown, { strapi: _strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user?.role?.type) return false;
  return ["admin_role", "editor"].includes(user.role.type);
};
