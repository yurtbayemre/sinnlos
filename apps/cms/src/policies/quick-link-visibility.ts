import {
  forcePublishedStatus,
  getMutableQuery,
  restrictiveIdFilter,
} from "../utils/policy-query";

/**
 * Enforces quick-link visibility on reads of the `quick-link` content
 * type, which scopes access via a `departments` (manyToMany) relation:
 *   - links WITHOUT any departments → company-wide (everyone sees them,
 *                                     incl. anonymous callers)
 *   - links WITH departments set    → only authenticated users whose
 *                                     department is among them
 *
 * admin_role / editor bypass the filter entirely.
 *
 * HOW IT WORKS — id-based filtering, no relation traversal (same pattern
 * as `document-visibility.ts`, see there for the full rationale):
 *   Writing filters onto `policyContext.query` is a silent no-op (Koa
 *   prototype-getter trap), so we go through `getMutableQuery`. And a
 *   REST filter traversing the `departments` relation would 400 for any
 *   role lacking `api::department.department.find` (`guest` in
 *   particular) via Strapi's `validateQuery` → `throwRestrictedRelations`.
 *   Instead we resolve the set of visible primary-key ids SERVER-SIDE via
 *   `strapi.db.query` (bypasses permission gating and relation
 *   restrictions) and inject a single non-relational
 *   `{ id: { $in: [...] } }` clause, which validates for every role.
 *
 * The clause is `$and`-wrapped with any incoming client filter so a
 * caller-supplied filter can only narrow the result set, never widen it.
 * An empty id list must NOT become `{ id: { $in: [] } }` — sanitizeQuery
 * strips empty array operands, which would drop the filter entirely
 * (fail-open); `restrictiveIdFilter` injects `{ id: { $eq: -1 } }` instead.
 *
 * Draft & publish note: `strapi.db.query` returns both draft and published
 * rows, so the id list is a superset spanning BOTH publication states.
 * Which of them the caller gets is decided by the client-supplied `status`
 * param, so the policy pins it to "published" — otherwise `?status=draft`
 * would hand unpublished links to every role holding `quick-link.find`.
 * See `forcePublishedStatus` for the full trap; admin_role / editor keep
 * draft access via the bypass above.
 */

interface LinkRow {
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

  const links: LinkRow[] = await strapi.db.query("api::quick-link.quick-link").findMany({
    select: ["id"],
    populate: { departments: { select: ["id"] } },
  });

  const idList = links
    .filter((link) => {
      const depts = link.departments ?? [];
      // Company-wide (no departments) → visible to everyone.
      if (depts.length === 0) return true;
      // Department-scoped → only the owning department's members (never
      // anonymous, who have no departmentId).
      return departmentId != null && depts.some((d) => d.id === departmentId);
    })
    .map((link) => link.id);

  const query = getMutableQuery(policyContext);
  const idFilter = restrictiveIdFilter(idList);
  query.filters = query.filters ? { $and: [query.filters, idFilter] } : idFilter;
  forcePublishedStatus(query);

  return true;
};
