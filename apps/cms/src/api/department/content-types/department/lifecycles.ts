import { flagPollsOfDeletedDepartments } from "../../../../utils/poll-department-delete";

/**
 * Poll targeting (decision 02): before a department row is deleted, every
 * poll that links it gets `audience = 'departments'`, so a poll targeted
 * only by its department links does not turn company-wide once the delete
 * cascades those links away (utils/poll-department-delete.ts).
 *
 * The admin panel (single and bulk delete) and the content API delete each
 * row through `strapi.db.query(uid).delete({ where: { id } })` (@strapi/core
 * 5.55.1 document-service entries.js deleteEntry), and @strapi/database
 * runs beforeDelete before the row delete and before deleteRelations
 * (entity-manager/index.js delete). beforeDeleteMany covers a script's
 * db-level deleteMany, whose link rows the foreign key cascade removes.
 *
 * Defence in depth since 2026-09-27d: the write-time guard
 * (utils/poll-audience-guard.ts) already flags every poll row a Document
 * Service write links, in the same transaction, which also covers a poll
 * linked concurrently with the delete. This hook catches rows linked
 * outside the Document Service (a previous cms during a rollback, raw SQL).
 */

interface DeleteEvent {
  params?: { where?: Record<string, unknown> | null } | null;
}

export default {
  async beforeDelete(event: DeleteEvent) {
    await flagPollsOfDeletedDepartments(strapi, event.params?.where);
  },
  async beforeDeleteMany(event: DeleteEvent) {
    await flagPollsOfDeletedDepartments(strapi, event.params?.where);
  },
};
