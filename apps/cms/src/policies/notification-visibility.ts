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
 * No bypass (v0.28): admin_role used one to count unread notifications
 * platform-wide for /manage/analytics, which let it read everybody's
 * notifications. That count is GET /api/notifications/unread-count now.
 *
 * Note: the `recipient` clause references the user relation, so every role
 * that can read notifications must also hold `users-permissions.user.find`
 * (validateQuery runs throwRestrictedRelations on filters). All reading
 * roles — including guest — are granted that scope in bootstrap.
 */
export default ownRowsFilter({ ownerField: "recipient", bypass: [] });
