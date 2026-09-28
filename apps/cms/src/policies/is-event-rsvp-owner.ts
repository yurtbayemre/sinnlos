import { ADMIN } from "../bootstrap/roles";
import { ownerGate } from "../utils/policy-factories";

/**
 * Update-side guard for event RSVPs: only the responding user may change
 * their own answer. admin_role bypasses (it may also correct/delete RSVPs
 * via the matrix); editors get NO moderation bypass here — an RSVP is a
 * personal statement, not content.
 *
 * v5 routes carry a documentId; the web app sends numeric ids — both are
 * accepted, anything else is refused like an unknown RSVP before any query
 * (ownerGate + findByRef, utils/policy-factories.ts).
 */
export default ownerGate({
  uid: "api::event-rsvp.event-rsvp",
  ownerField: "user",
  bypass: [ADMIN],
});
