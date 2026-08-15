import { getMutableQuery } from "../utils/policy-query";

/**
 * Read-side guard for acknowledgements. Every role may only list/read
 * its OWN acknowledgements (user = caller); `admin_role` bypasses the
 * filter so the /manage/acknowledgements report can aggregate the
 * confirmation state across all users.
 *
 * The filter is applied to the REAL request query (see `getMutableQuery`):
 * assigning to `policyContext.query` is a silent no-op because Koa's
 * `query` is a prototype getter that `createPolicyContext`'s
 * `Object.assign` never copies.
 *
 * Note: the `user` clause references the users-permissions user relation,
 * so every role that can read acknowledgements must also hold
 * `users-permissions.user.find` (validateQuery runs
 * throwRestrictedRelations on filters). All reading roles are granted
 * that scope in bootstrap. (guest holds no acknowledgement permissions at
 * all — it cannot read announcements, so ack grants would be dead attack
 * surface.)
 */
export default async (policyContext: any, _config: unknown, _deps: any) => {
  const user = policyContext.state?.user;
  if (!user) return false;

  if (user.role?.type === "admin_role") return true;

  const query = getMutableQuery(policyContext);
  // $and instead of a spread merge so an incoming `user` filter can
  // only narrow the result set, never widen it to other users' rows.
  query.filters = query.filters
    ? { $and: [query.filters, { user: { id: user.id } }] }
    : { user: { id: user.id } };

  return true;
};
