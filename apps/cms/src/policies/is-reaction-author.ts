import { MODERATORS } from "../bootstrap/roles";
import { ownerGate } from "../utils/policy-factories";

/**
 * Delete-side guard for reactions: only the author may remove a reaction.
 * Admins and editors pass (same moderation semantics as comment delete).
 *
 * v5 routes carry a documentId; a numeric id is accepted too, so direct API
 * consumers keep working, and anything else is refused like an unknown
 * reaction before any query (ownerGate + findByRef,
 * utils/policy-factories.ts). The controller translates a numeric id for
 * the core delete.
 */
export default ownerGate({
  uid: "api::reaction.reaction",
  ownerField: "author",
  bypass: MODERATORS,
});
