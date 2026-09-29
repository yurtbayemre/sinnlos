import { restrictRowsOfDeletedDepartments } from "../../../../utils/department-delete-restrict";
import { flagPollsOfDeletedDepartments } from "../../../../utils/poll-department-delete";

/**
 * Department deletes keep what the department targeted restricted, before
 * the delete cascades the link rows away:
 *   - polls (decision 02): every poll that links the department gets
 *     `audience = 'departments'`, so a poll targeted only by its department
 *     links does not turn company-wide (utils/poll-department-delete.ts);
 *   - documents and quick links (FX29 residual, owner answer 2026-09-29 (b),
 *     RESTRICT): the same flag, so they become admin/editor-only until a
 *     moderator re-targets them (utils/department-delete-restrict.ts). The
 *     delete itself is never refused.
 *
 * The admin panel (single and bulk delete) and the content API delete each
 * row through `strapi.db.query(uid).delete({ where: { id } })` (@strapi/core
 * 5.55.1 document-service entries.js deleteEntry), and @strapi/database
 * runs beforeDelete before the row delete and before deleteRelations
 * (entity-manager/index.js delete). beforeDeleteMany covers a script's
 * db-level deleteMany, whose link rows the foreign key cascade removes.
 * Both hooks run in the delete's transaction: a failing flag write fails
 * the delete, and a failed delete rolls the flags back.
 *
 * Defence in depth for polls since 2026-09-27d: the write-time guard
 * (utils/poll-audience-guard.ts) already flags every poll row a Document
 * Service write links, in the same transaction, which also covers a poll
 * linked concurrently with the delete. The poll hook catches rows linked
 * outside the Document Service (a previous cms during a rollback, raw SQL).
 * The same for documents and quick links since the batch 12 review
 * (B12-01): their write-time guard (utils/department-audience-guard.ts)
 * and boot backfill keep every linked row flagged, which also covers a
 * publish or an admin form that copied a row before the delete. Their hook
 * also locks the department rows on Postgres before it reads their links,
 * so a link written around the Document Service concurrently with the
 * delete is either flagged or refused by the foreign key check
 * (utils/department-delete-restrict.ts, CONCURRENT LINKS).
 */

interface DeleteEvent {
  params?: { where?: Record<string, unknown> | null } | null;
}

async function keepTargetsRestricted(event: DeleteEvent): Promise<void> {
  const where = event.params?.where;
  await flagPollsOfDeletedDepartments(strapi, where);
  await restrictRowsOfDeletedDepartments(strapi, where);
}

export default {
  async beforeDelete(event: DeleteEvent) {
    await keepTargetsRestricted(event);
  },
  async beforeDeleteMany(event: DeleteEvent) {
    await keepTargetsRestricted(event);
  },
};
