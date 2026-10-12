import { MODERATORS } from "../bootstrap/roles";
import { ownerGate } from "../utils/policy-factories";

/**
 * Delete-side guard for comments (PL03): only the author may remove a
 * comment; admin_role and editor pass for moderation, like
 * is-reaction-author and the classified takedown.
 *
 * Until batch 12 the comment controller checked this itself, after its own
 * lookup. The route policy makes the check visible to the route matrix
 * (routes.matrix.test.ts) and keeps one authorization place per concern,
 * without changing a byte of what a client sees
 * (comment-delete.integration.test.ts):
 *   - a refusal throws ForbiddenError("Forbidden"), the body of the
 *     controller's former ctx.forbidden(), not Strapi's PolicyError
 *     ("Policy Failed") that a `false` would produce;
 *   - a `:id` that names no comment (missing, malformed, out of range)
 *     passes on to the controller, which answers its 404 as before. Only
 *     a caller without a numeric id is refused before the lookup (defence
 *     in depth: users-permissions always sets a database user).
 *
 * v5 routes carry a documentId; the web sends numeric ids. Both are
 * accepted (ownerGate + findByRef, utils/policy-factories.ts); the
 * controller translates a numeric id for the core delete.
 */
export default ownerGate({
  uid: "api::comment.comment",
  ownerField: "author",
  bypass: MODERATORS,
  unknownRow: "handler",
  refusal: "forbidden",
});
