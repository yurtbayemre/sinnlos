import {
  TEAM_UID,
  USER_UID,
  enforceWriteAllowlist,
  isWriteBypassRole,
  targetRowWhere,
  type StrapiDb,
  type WritePolicy,
} from "../utils/write-allowlist";

interface TeamRow {
  id: number;
  lead?: { id?: number } | null;
  department?: { id?: number } | null;
}

interface CallerRow {
  department?: { id?: number } | null;
}

/**
 * Write gate for team updates (the only route it guards).
 *
 *   - admin_role / editor: pass, payload untouched.
 *   - the team's lead: role class "lead".
 *   - a department_head whose own department is the team's department:
 *     role class "departmentHead".
 *   Both classes may write only what utils/write-allowlist.ts allows
 *   (description). `members`, `lead`, `department`, `pages`, `name` and
 *   media answer 400. The write is pinned to `status=published`.
 *   - everyone else: false (403). That now includes plain MEMBERS of the
 *     team (this policy was is-team-member-or-lead): membership and
 *     leadership decide wiki team-space visibility and page edit rights,
 *     so a member gets no write on the team at all, and a lead cannot
 *     change who is in it.
 *
 * The row gate runs before the payload is looked at. A head without a
 * department never matches a team without one. Strict boolean result:
 * Strapi treats `undefined` as a pass.
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

  const where = targetRowWhere(policyContext.params?.id);
  if (!where) return false;
  const team = (await strapi.db.query(TEAM_UID).findOne({
    where,
    populate: { lead: true, department: true },
  })) as TeamRow | null;
  if (!team) return false;

  let roleClass: "lead" | "departmentHead" | undefined;
  if (team.lead?.id === user.id) {
    roleClass = "lead";
  } else if (roleType === "department_head" && typeof team.department?.id === "number") {
    const me = (await strapi.db.query(USER_UID).findOne({
      where: { id: user.id },
      populate: { department: true },
    })) as CallerRow | null;
    if (me?.department?.id === team.department.id) roleClass = "departmentHead";
  }
  if (!roleClass) return false;

  return enforceWriteAllowlist(
    policyContext,
    { uid: TEAM_UID, action: "update", roleClass },
    { callerId: user.id },
  );
};
