import { getMutableQuery } from "../utils/policy-query";

/**
 * Read-side guard for lesson-progress rows (issue #29) — documented
 * clone of `acknowledgement-visibility`: every role may only list/read
 * its OWN completion receipts; `admin_role` bypasses so the
 * /manage/training report can aggregate across all users.
 *
 * Progress data is personnel data — a member must not be able to query
 * a colleague's training state (same posture as notifications and
 * poll votes).
 *
 * The `user` clause references the users-permissions relation, so every
 * role reading progress must also hold `users-permissions.user.find`
 * (validateQuery / throwRestrictedRelations) — all staff roles carry
 * that grant already (see the announcement-visibility notes in
 * docs/architecture.md §6).
 */
export default async (policyContext: any, _config: unknown, _deps: any) => {
  const user = policyContext.state?.user;
  if (!user) return false;

  if (user.role?.type === "admin_role") return true;

  const query = getMutableQuery(policyContext);
  // $and so an incoming `user` filter can only narrow, never widen.
  query.filters = query.filters
    ? { $and: [query.filters, { user: { id: user.id } }] }
    : { user: { id: user.id } };

  return true;
};
