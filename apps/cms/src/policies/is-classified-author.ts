import { MODERATORS } from "../bootstrap/roles";
import { ownerGate } from "../utils/policy-factories";

/**
 * Write-side guard for marketplace ads: only the author may update or
 * delete their classified. Which roles bypass ownership is configurable
 * per route via `config.bypassRoles` (api/classified/routes/classified.ts):
 *   - update: [ADMIN] — editing someone's ad text/price is an
 *     owner/admin matter, not moderation.
 *   - delete: MODERATORS — taking down an inappropriate ad
 *     stays an editor moderation tool (same semantics as
 *     is-reaction-author / comment delete).
 * Without config the historical admin+editor bypass applies (MODERATORS,
 * bootstrap/roles.ts). A configured entry that is not a role type bypasses
 * nobody, and a configured value that is not a list bypasses nobody either
 * (configuredBypass, utils/policy-factories.ts).
 *
 * v5 routes carry a documentId; the web app sends numeric ids — both are
 * accepted, anything else is refused like an unknown ad before any query
 * (ownerGate + findByRef).
 */
export default ownerGate({
  uid: "api::classified.classified",
  ownerField: "author",
  bypass: MODERATORS,
  bypassFromConfig: true,
});
