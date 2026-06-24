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
 * Admins and editors always pass. As in wiki-visibility, we mutate the
 * query filters so Strapi's core find handler does the heavy lifting.
 */
export default async (policyContext: any, _config: unknown, { strapi }: any) => {
  const user = policyContext.state?.user;

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
