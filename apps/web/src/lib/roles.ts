export const ADMIN_ROLES = new Set(["admin_role"]);

export function isAdmin(role: string | undefined | null): boolean {
  return role ? ADMIN_ROLES.has(role) : false;
}
