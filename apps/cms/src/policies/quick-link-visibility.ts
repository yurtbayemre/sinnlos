import { MODERATORS } from "../bootstrap/roles";
import { departmentScopedIds, visibleIdsPolicy } from "../utils/policy-factories";

/**
 * Enforces quick-link visibility on reads of the `quick-link` content
 * type, which scopes access via a `departments` (manyToMany) relation:
 *   - links WITHOUT any departments → company-wide (everyone sees them,
 *                                     incl. anonymous callers)
 *   - links WITH departments set    → only authenticated users whose
 *                                     department is among them
 *   - links with `audience` 'departments' and no departments left (the
 *     department delete hook flags them, FX29 residual) → nobody but
 *     admin_role / editor, until a moderator re-targets them ("flag OR
 *     links", departmentScopedIds)
 *
 * admin_role / editor bypass the filter entirely (and keep draft reads).
 *
 * HOW IT WORKS — the same id-based filtering as `document-visibility.ts`
 * (visibleIdsPolicy + departmentScopedIds, utils/policy-factories.ts): a
 * REST filter traversing the `departments` relation would 400 for any role
 * lacking `api::department.department.find` (`guest` in particular), so the
 * visible ids are resolved via `strapi.db.query` and injected as a
 * non-relational `{ id: { $in } }` clause, $and-composed with the client
 * filter, empty → `{ id: { $eq: -1 } }`. The ids span draft and published
 * rows, so the status is pinned to "published" (`?status=draft` trap).
 */
export default visibleIdsPolicy({
  uid: "api::quick-link.quick-link",
  bypass: MODERATORS,
  anonymous: "filter",
  pinPublished: true,
  loadVisibleIds: departmentScopedIds,
});
