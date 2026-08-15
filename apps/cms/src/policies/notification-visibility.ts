import { getMutableQuery } from "../utils/policy-query";

/**
 * Read-side guard for notifications. Notifications are personal — every
 * role may only list/read its OWN (recipient = caller). We mutate the
 * query filters so Strapi's core find/findOne handlers do the heavy
 * lifting.
 *
 * The filter is applied to the REAL request query (see
 * `getMutableQuery`): assigning to `policyContext.query` is a silent
 * no-op because Koa's `query` is a prototype getter that
 * `createPolicyContext`'s `Object.assign` never copies.
 *
 * `admin_role` bypasses the filter: the /manage/analytics page counts
 * unread notifications platform-wide through this route.
 *
 * Note: the `recipient` clause references the user relation, so every role
 * that can read notifications must also hold `users-permissions.user.find`
 * (validateQuery runs throwRestrictedRelations on filters). All reading
 * roles — including guest — are granted that scope in bootstrap.
 */
export default async (policyContext: any, _config: unknown, _deps: any) => {
  const user = policyContext.state?.user;
  if (!user) return false;

  if (user.role?.type === "admin_role") return true;

  const query = getMutableQuery(policyContext);
  // $and instead of a spread merge so an incoming `recipient` filter can
  // only narrow the result set, never widen it to other users' rows.
  query.filters = query.filters
    ? { $and: [query.filters, { recipient: { id: user.id } }] }
    : { recipient: { id: user.id } };

  return true;
};
