import { restrictRowsOfDeletedDepartments } from "../../../../utils/department-delete-restrict";
import { flagPollsOfDeletedDepartments } from "../../../../utils/poll-department-delete";
import {
  DEPARTMENT_LINKED_DOCUMENTS,
  OUTSIDE_TRANSACTION,
  TARGETING_FLAGS_LOG,
  advanceRevisionsOf,
  documentsLinking,
  flagEventsLinking,
  lockMatchedRows,
  markAnnouncementsLinking,
  type TargetingDeleteHost,
} from "../../../../utils/targeting-flags";

/**
 * Department deletes keep what the department targeted restricted, before
 * the delete cascades the link rows away (decision 02, the FX29 residual,
 * decision 06 §N9). Linked content never blocks the delete (only a delete
 * outside a transaction is refused, below). In this order:
 *   1. on Postgres the matched department rows are locked `FOR UPDATE`, so
 *      no link to them commits around the scans below (utils/targeting-
 *      flags.ts lockMatchedRows; department-delete-restrict.ts CONCURRENT
 *      LINKS);
 *   2. before any other write (§D rule 13, amendment row A2): every
 *      announcement, event and document that links a deleted department
 *      (`department`, `departments` or `ownerDepartment`) has its revision
 *      locked and advanced, in ascending (uid, documentId) order after the
 *      department's own version row (the document lock's). A department
 *      author's request whose gate saw the rows before the delete then
 *      answers 404 or 403 instead of writing (§N8);
 *   3. polls (decision 02): `audience = 'departments'`, so a poll targeted
 *      only by its department links does not turn company-wide
 *      (utils/poll-department-delete.ts);
 *   4. documents and quick links (FX29 residual, owner answer 2026-09-29
 *      (b), RESTRICT): the same flag, admin/editor-only until re-targeted
 *      (utils/department-delete-restrict.ts);
 *   5. announcements whose `department` is a deleted one (batch 15,
 *      amendment row A3): `audience = 'departments'` and
 *      `retargetRequired = true`. The criteria are AND-combined, so the
 *      announcement's team or roles alone would otherwise admit readers the
 *      department excluded; with the marker it is moderator-only and
 *      notifies nobody until re-targeted (D-PT01 covers one left with
 *      neither a department nor a team);
 *   6. events that link a deleted department: `notifyAudience =
 *      'departments'`, so an event whose only departments vanish notifies
 *      nobody on its next publish instead of everyone.
 *
 * The admin panel (single and bulk delete) and the content API delete each
 * row through `strapi.db.query(uid).delete({ where: { id } })` (@strapi/core
 * document-service entries.js deleteEntry), and @strapi/database runs
 * beforeDelete before the row delete and before deleteRelations
 * (entity-manager/index.js delete). beforeDeleteMany covers a script's
 * db-level deleteMany, whose link rows the foreign key cascade removes.
 * Everything runs in the delete's own transaction (the Document Service
 * wraps every delete in one; the hook joins it). The query engine itself
 * opens none around a lifecycle and its DELETE, so a db-level delete
 * outside a transaction is REFUSED: a transaction of the hook's own would
 * commit, and release the row locks, before the DELETE runs, and a link
 * written in between would be cascaded away unflagged (Codex review of
 * lane 15D). A script deletes through the Document Service or inside
 * `strapi.db.transaction`. A failing step fails the delete, and a failed
 * delete rolls every flag and revision back.
 *
 * Defence in depth: the write-time guards (utils/poll-audience-guard.ts,
 * utils/department-audience-guard.ts with utils/targeting-flags.ts) flag
 * every row a Document Service write links, in the same transaction, and
 * the boot backfills the rows written before them. These hooks catch rows
 * linked outside the Document Service (a previous cms during a rollback,
 * raw SQL), and the marker and the revision advance are theirs alone.
 */

interface DeleteEvent {
  params?: { where?: Record<string, unknown> | null } | null;
}

const DEPARTMENT_UID = "api::department.department";

const REFUSAL =
  "refusing to delete a department without keeping its announcements, events and documents " +
  "restricted";

async function keepTargetsRestricted(event: DeleteEvent): Promise<void> {
  const where = event.params?.where;
  const host = strapi as unknown as TargetingDeleteHost;
  if (!host.db.inTransaction()) {
    throw new Error(`${TARGETING_FLAGS_LOG} department delete: ${OUTSIDE_TRANSACTION}`);
  }
  await host.db.transaction(async () => {
    const departmentIds = await lockMatchedRows(host, DEPARTMENT_UID, where);
    if (departmentIds.length === 0) return;
    const documents = await documentsLinking(
      host,
      DEPARTMENT_LINKED_DOCUMENTS,
      departmentIds,
      REFUSAL,
    );
    await advanceRevisionsOf(host, documents);
    await flagPollsOfDeletedDepartments(strapi, where);
    await restrictRowsOfDeletedDepartments(strapi, where);
    const announcements = await markAnnouncementsLinking(
      host,
      "department",
      departmentIds,
      REFUSAL,
    );
    const events = await flagEventsLinking(host, departmentIds, REFUSAL);
    if (documents.length + announcements + events > 0) {
      strapi.log.info(
        `${TARGETING_FLAGS_LOG} department delete: advanced the revision of ${documents.length} ` +
          `announcement/event/document(s); marked ${announcements} announcement row(s) ` +
          `'retargetRequired' and flagged ${events} event row(s) to notify 'departments': ` +
          "they stay restricted (admins and editors only, nobody notified) until re-targeted",
      );
    }
  });
}

export default {
  async beforeDelete(event: DeleteEvent) {
    await keepTargetsRestricted(event);
  },
  async beforeDeleteMany(event: DeleteEvent) {
    await keepTargetsRestricted(event);
  },
};
