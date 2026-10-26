import { MODERATORS } from "../bootstrap/roles";
import { departmentScopedIds, visibleIdsPolicy } from "../utils/policy-factories";

/**
 * Enforces document visibility on reads of the `document` content type,
 * which scopes access via a `departments` (manyToMany) relation instead of
 * a visibility enum:
 *   - documents WITHOUT any departments → company-wide (everyone sees them,
 *                                         incl. anonymous callers)
 *   - documents WITH departments set    → only authenticated users whose
 *                                         department is among them
 *   - documents with `audience` 'departments' and no departments left (the
 *     department delete hook flags them, FX29 residual) → nobody but
 *     admin_role / editor, until a moderator re-targets them ("flag OR
 *     links", departmentScopedIds)
 *
 * admin_role / editor bypass the filter entirely (and keep draft reads).
 *
 * HOW IT WORKS — id-based filtering, no relation traversal
 * (visibleIdsPolicy + departmentScopedIds, utils/policy-factories.ts):
 *   This policy used to write a `departments`-traversing filter onto
 *   `policyContext.query`, which was a silent no-op (Koa's `query` is a
 *   prototype getter that `createPolicyContext`'s `Object.assign` never
 *   copies) — so document visibility was never actually enforced at the
 *   API. Redirecting that filter to the REAL request query would 400 every
 *   `guest` document read: `guest` can read documents but has no
 *   `api::department.department.find`, and Strapi's `validateQuery` →
 *   `throwRestrictedRelations` rejects any filter reaching through the
 *   `departments` relation.
 *
 *   Instead the visible primary-key ids are resolved SERVER-SIDE via
 *   `strapi.db.query` (which bypasses both permission gating AND
 *   `throwRestrictedRelations`); the Document Service ANDs them into the
 *   reads as one non-relational `{ id: { $in } }` clause, the list bound
 *   as one parameter (visibleIdsPolicy, #175), past the client filter's
 *   validation; an empty list matches nothing.
 *
 * Draft & publish note: the id list spans draft AND published rows, so the
 * status is pinned to "published" — otherwise `?status=draft` would hand
 * unpublished documents to every role holding `document.find` (incl.
 * guest). See `forcePublishedStatus` for the full trap.
 */
export default visibleIdsPolicy({
  uid: "api::document.document",
  bypass: MODERATORS,
  anonymous: "filter",
  pinPublished: true,
  loadVisibleIds: departmentScopedIds,
});
