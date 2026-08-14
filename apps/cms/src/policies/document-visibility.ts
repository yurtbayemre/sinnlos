/**
 * Filters document reads based on the caller's department.
 *
 * Mirrors the semantics of `wiki-visibility`, but for the document
 * content-type, which scopes visibility via a `departments` (manyToMany)
 * relation instead of a `visibility` enum.
 *
 * Rules:
 *   - documents WITHOUT any departments  → company-wide (everyone sees them)
 *   - documents WITH departments set     → only users whose department is
 *                                          among the document's `departments`
 *
 * Admins and editors always pass.
 *
 * KNOWN OPEN ISSUE (do NOT "fix" by switching to the real request query):
 *   This policy currently writes to `policyContext.query`, which is a
 *   silent no-op (Koa's `query` is a prototype getter that
 *   createPolicyContext's Object.assign never copies) — so it has never
 *   actually filtered. Unlike wiki-visibility, the filter shape here is
 *   structurally valid for the `document` schema (`departments` exists),
 *   BUT filtering on the `departments` relation requires the caller to hold
 *   `api::department.department.find` (validateQuery runs
 *   throwRestrictedRelations on filters). The `guest` role can read
 *   documents but is NOT granted `department.find`, so redirecting this to
 *   the real request query would 400 every guest document read (verified
 *   via node repro against @strapi/utils 5.49). Activating this safely
 *   requires granting `department.find` to all document-reading roles
 *   (incl. guest) first. Left as-is (status quo: no API-level document
 *   visibility filtering) to avoid a 400 app.
 */
export default async (policyContext: any, _config: unknown, { strapi }: any) => {
  const user = policyContext.state?.user;

  // NOTE: writing to `policyContext.query` is intentionally a no-op today —
  // see the KNOWN OPEN ISSUE above before changing this to the real query.
  const query = policyContext.query ?? (policyContext.query = {});
  query.filters = query.filters ?? {};

  // Department-scoped documents are only ever visible to authenticated
  // members of the owning department. Anonymous traffic therefore only
  // sees company-wide documents (those without any departments).
  if (!user) {
    query.filters = {
      ...query.filters,
      departments: { id: { $null: true } },
    };
    return true;
  }

  if (["admin_role", "editor"].includes(user.role?.type)) return true;

  const meFull = await strapi.db.query("plugin::users-permissions.user").findOne({
    where: { id: user.id },
    populate: { department: true },
  });
  const departmentId = meFull?.department?.id;

  // Company-wide documents (no departments) are always visible. Add the
  // caller's department as the only additional clause that may match a
  // department-scoped document.
  const visibilityClauses: any[] = [{ departments: { id: { $null: true } } }];
  if (departmentId) {
    visibilityClauses.push({ departments: { id: departmentId } });
  }

  query.filters = {
    ...query.filters,
    $or: visibilityClauses,
  };

  return true;
};
