import { errors } from "@strapi/utils";
import { ADMIN } from "../bootstrap/roles";
import { getMutableQuery } from "../utils/policy-query";
import { filtersReferenceUser } from "../utils/rsvp";

/**
 * Read guard for the raw RSVP rows (FX21): GET /api/event-rsvps and
 * /api/event-rsvps/:id return only the CALLER's own rows. Who else answered
 * what is served solely aggregated, by GET /api/event-rsvps/summary (counts
 * plus the names of "yes" answers). Before, every role holding
 * event-rsvp.find read every row and only an output post-filter
 * (stripPrivateUsers) kept the names of decliners private; the rows are
 * now narrowed in the query itself.
 *
 * admin_role bypasses (it may correct RSVPs and reads every name, as
 * before); editors get NO bypass: an RSVP is a personal statement, not
 * content (is-event-rsvp-owner precedent). The own-rows clause is $and-ed
 * onto the REAL request query (getMutableQuery, §5.14), so a client filter
 * can only narrow it. A client filter on `user` is refused with 400
 * instead: on own rows it has no use. The Strapi-Response-Format header is
 * refused in the controller (it shapes the response, not the query).
 *
 * The `user` clause references the users-permissions relation, so every
 * role reading RSVPs also needs `users-permissions.user.find`
 * (validateQuery / throwRestrictedRelations); every role holds it.
 */

interface RsvpPolicyContext {
  state?: { user?: { id?: unknown; role?: { type?: unknown } | null } | null };
  request?: { query?: Record<string, unknown> };
}

export default async (
  policyContext: RsvpPolicyContext,
  _config: unknown,
  _deps: unknown,
): Promise<boolean> => {
  const user = policyContext.state?.user;
  if (!user) return false;

  if (user.role?.type === ADMIN) return true;

  // Without a numeric id the caller owns no row (defence in depth:
  // users-permissions always sets a database user).
  if (typeof user.id !== "number") return false;

  const query = getMutableQuery(policyContext);
  if (filtersReferenceUser(query.filters)) {
    throw new errors.ValidationError("Filtering RSVPs by user is not allowed");
  }
  // $and so an incoming filter can only narrow, never widen.
  query.filters = query.filters
    ? { $and: [query.filters, { user: { id: user.id } }] }
    : { user: { id: user.id } };

  return true;
};
