import { errors } from "@strapi/utils";
import { ADMIN } from "../bootstrap/roles";
import { ownRowsFilter } from "../utils/policy-factories";
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
 * onto the REAL request query (ownRowsFilter, §5.14), so a client filter
 * can only narrow it; a caller without a numeric id owns no row. A client
 * filter on `user` is refused with 400 instead: on own rows it has no use.
 * The Strapi-Response-Format header is refused in the controller (it
 * shapes the response, not the query).
 *
 * The `user` clause references the users-permissions relation, so every
 * role reading RSVPs also needs `users-permissions.user.find`
 * (validateQuery / throwRestrictedRelations); every role holds it.
 */
export default ownRowsFilter({
  ownerField: "user",
  bypass: [ADMIN],
  checkQuery(query) {
    if (filtersReferenceUser(query.filters)) {
      throw new errors.ValidationError("Filtering RSVPs by user is not allowed");
    }
  },
});
