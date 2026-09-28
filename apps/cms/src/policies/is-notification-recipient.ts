import { ADMIN } from "../bootstrap/roles";
import { ownerGate } from "../utils/policy-factories";

/**
 * Delete-side guard for notifications: only the recipient (or an admin)
 * may delete a notification. Editors do not bypass: a notification is
 * personal data.
 *
 * v5 routes carry a documentId; a numeric id is accepted too, so direct API
 * consumers keep working, and anything else is refused like an unknown
 * notification before any query (ownerGate + findByRef,
 * utils/policy-factories.ts). The controller translates a numeric id for
 * the core delete.
 */
export default ownerGate({
  uid: "api::notification.notification",
  ownerField: "recipient",
  bypass: [ADMIN],
});
