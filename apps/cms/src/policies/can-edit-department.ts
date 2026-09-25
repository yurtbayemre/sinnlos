import {
  DEPARTMENT_UID,
  USER_UID,
  enforceWriteAllowlist,
  isWriteBypassRole,
  targetRowWhere,
  type StrapiDb,
  type WritePolicy,
} from "../utils/write-allowlist";

interface DepartmentRow {
  id: number;
}

interface CallerRow {
  department?: { id?: number } | null;
}

/**
 * Write gate for department updates (the only route it guards).
 *
 *   - admin_role / editor: pass, payload untouched.
 *   - department_head whose OWN department (user.department) is the target:
 *     role class "head", limited to the fields utils/write-allowlist.ts
 *     allows it (description, colour). Any other key, e.g. a `pages`,
 *     `members` or `teams` connect, `head`, `name` or media, answers 400.
 *     The write is pinned to `status=published` (no draft rows through
 *     `?status=draft&populate[teams]`).
 *   - everyone else, a missing target or an unknown row: false (403).
 *
 * The row gate runs before the payload is looked at, so a caller who may
 * not write the row never learns anything about its payload rules.
 * Strict boolean result: Strapi treats `undefined` as a pass.
 */
export default async (
  policyContext: WritePolicy,
  _config: unknown,
  { strapi }: { strapi: StrapiDb },
): Promise<boolean> => {
  const user = policyContext.state?.user;
  const roleType = user?.role?.type;
  if (!user || typeof user.id !== "number" || !roleType) return false;
  if (isWriteBypassRole(roleType)) return true;
  if (roleType !== "department_head") return false;

  const where = targetRowWhere(policyContext.params?.id);
  if (!where) return false;
  const department = (await strapi.db
    .query(DEPARTMENT_UID)
    .findOne({ where })) as DepartmentRow | null;
  if (!department) return false;

  const me = (await strapi.db.query(USER_UID).findOne({
    where: { id: user.id },
    populate: { department: true },
  })) as CallerRow | null;
  if (me?.department?.id !== department.id) return false;

  return enforceWriteAllowlist(
    policyContext,
    { uid: DEPARTMENT_UID, action: "update", roleClass: "head" },
    { callerId: user.id },
  );
};
