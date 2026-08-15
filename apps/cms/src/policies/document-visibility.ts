import { getMutableQuery } from "../utils/policy-query";

/**
 * Enforces document visibility on reads of the `document` content type,
 * which scopes access via a `departments` (manyToMany) relation instead of
 * a visibility enum:
 *   - documents WITHOUT any departments → company-wide (everyone sees them,
 *                                         incl. anonymous callers)
 *   - documents WITH departments set    → only authenticated users whose
 *                                         department is among them
 *
 * admin_role / editor bypass the filter entirely.
 *
 * HOW IT WORKS — id-based filtering, no relation traversal:
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
 *   Instead we resolve the set of visible primary-key ids SERVER-SIDE via
 *   `strapi.db.query` (which bypasses both permission gating AND
 *   `throwRestrictedRelations`): load every document with its departments
 *   populated and decide membership in plain JS. The policy then injects a
 *   single non-relational `{ id: { $in: [...] } }` clause — `id` is a plain
 *   attribute, so the filter validates for every role and traverses
 *   nothing, no 400.
 *
 * The clause is `$and`-wrapped with any incoming client filter so a
 * caller-supplied filter can only narrow the result set, never widen it. An
 * empty id list yields `{ id: { $in: [] } }` — correctly restrictive.
 *
 * Draft & publish note: `strapi.db.query` returns both draft and published
 * rows; the resulting id list is a superset covering both, and the core
 * controller still applies its own status filter on top.
 */

interface DocRow {
  id: number;
  departments?: { id: number }[];
}

export default async (policyContext: any, _config: unknown, { strapi }: any) => {
  const user = policyContext.state?.user;

  // admin_role / editor see everything, no filter needed.
  if (user && ["admin_role", "editor"].includes(user.role?.type)) return true;

  let departmentId: number | undefined;
  if (user) {
    const meFull = await strapi.db.query("plugin::users-permissions.user").findOne({
      where: { id: user.id },
      populate: { department: true },
    });
    departmentId = meFull?.department?.id;
  }

  const docs: DocRow[] = await strapi.db.query("api::document.document").findMany({
    select: ["id"],
    populate: { departments: { select: ["id"] } },
  });

  const idList = docs
    .filter((doc) => {
      const depts = doc.departments ?? [];
      // Company-wide (no departments) → visible to everyone.
      if (depts.length === 0) return true;
      // Department-scoped → only the owning department's members (never
      // anonymous, who have no departmentId).
      return departmentId != null && depts.some((d) => d.id === departmentId);
    })
    .map((doc) => doc.id);

  const query = getMutableQuery(policyContext);
  const idFilter = { id: { $in: idList } };
  query.filters = query.filters ? { $and: [query.filters, idFilter] } : idFilter;

  return true;
};
