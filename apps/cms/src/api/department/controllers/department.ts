import { factories } from "@strapi/strapi";

import { parseEntryRef } from "../../../utils/entry-id";

const DEPARTMENT_UID = "api::department.department";

export default factories.createCoreController(DEPARTMENT_UID, ({ strapi }) => ({
  /**
   * PUT /api/departments/:id, behind global::can-edit-department (FX07
   * allowlist for department heads). The policy accepts a documentId or a
   * numeric row id (utils/write-allowlist.ts targetRowWhere), but the v5
   * core update resolves only documentIds: a numeric id passed the policy
   * and then answered 404. It is translated here (PL01, owner default
   * "translate"); an unknown row id answers 404. department is single-row
   * (decision 05), so the id names exactly one document. Everything else
   * goes to the core update unchanged.
   */
  async update(ctx) {
    const ref = parseEntryRef(ctx.params.id);
    if (ref && "id" in ref) {
      const row = await strapi.db.query(DEPARTMENT_UID).findOne({
        where: { id: ref.id },
        select: ["id", "documentId"],
      });
      if (!row) return ctx.notFound();
      ctx.params.id = row.documentId;
    }
    return super.update(ctx);
  },
}));
