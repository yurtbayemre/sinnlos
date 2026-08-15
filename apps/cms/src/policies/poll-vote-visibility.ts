import { getMutableQuery } from "../utils/policy-query";

/**
 * Read-side guard for poll votes. The web app never lists poll votes
 * directly — aggregated numbers come from the /polls/:id/results route,
 * which respects the poll's `anonymous` flag. Leaving the core find
 * routes open would let any role populate `voter` and de-anonymize
 * anonymous polls, so every caller is restricted to their own votes.
 *
 * The filter is applied to the REAL request query (see `getMutableQuery`):
 * assigning to `policyContext.query` is a silent no-op because Koa's
 * `query` is a prototype getter that `createPolicyContext`'s
 * `Object.assign` never copies.
 *
 * Note: the `voter` clause references the user relation, so every role
 * that can read poll votes must also hold `users-permissions.user.find`
 * (validateQuery runs throwRestrictedRelations on filters). All reading
 * roles — including guest — are granted that scope in bootstrap.
 */
export default async (policyContext: any, _config: unknown, _deps: any) => {
  const user = policyContext.state?.user;
  if (!user) return false;

  const query = getMutableQuery(policyContext);
  // $and instead of a spread merge so an incoming `voter` filter can
  // only narrow the result set, never widen it to other users' rows.
  query.filters = query.filters
    ? { $and: [query.filters, { voter: { id: user.id } }] }
    : { voter: { id: user.id } };

  return true;
};
