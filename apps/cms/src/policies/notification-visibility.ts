import { ADMIN } from "../bootstrap/roles";
import { ownRowsFilter } from "../utils/policy-factories";

/**
 * Read-side guard for notifications. Notifications are personal — every
 * role may only list/read its OWN (recipient = caller); Strapi's core
 * find/findOne handlers do the rest.
 *
 * The own-rows clause is $and-ed onto the REAL request query, so a client
 * `recipient` filter can only narrow the result (ownRowsFilter,
 * utils/policy-factories.ts, §5.14).
 *
 * `admin_role` bypasses the filter: the /manage/analytics page counts
 * unread notifications platform-wide through this route. Editors do not.
 *
 * Note: the `recipient` clause references the user relation, so every role
 * that can read notifications must also hold `users-permissions.user.find`
 * (validateQuery runs throwRestrictedRelations on filters). All reading
 * roles — including guest — are granted that scope in bootstrap.
 */
export default ownRowsFilter({ ownerField: "recipient", bypass: [ADMIN] });
