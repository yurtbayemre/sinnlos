import { ADMIN } from "../bootstrap/roles";
import { ownRowsFilter } from "../utils/policy-factories";

/**
 * Read-side guard for acknowledgements. Every role may only list/read
 * its OWN acknowledgements (user = caller); `admin_role` bypasses the
 * filter so the /manage/acknowledgements report can aggregate the
 * confirmation state across all users. Editors do not: a read receipt is
 * personal data, not content.
 *
 * The own-rows clause is $and-ed onto the REAL request query, so a client
 * `user` filter can only narrow the result, never widen it to other users'
 * rows (ownRowsFilter, utils/policy-factories.ts, §5.14).
 *
 * Note: the `user` clause references the users-permissions user relation,
 * so every role that can read acknowledgements must also hold
 * `users-permissions.user.find` (validateQuery runs
 * throwRestrictedRelations on filters). All reading roles are granted
 * that scope in bootstrap. (guest holds no acknowledgement permissions at
 * all — it cannot read announcements, so ack grants would be dead attack
 * surface.)
 */
export default ownRowsFilter({ ownerField: "user", bypass: [ADMIN] });
