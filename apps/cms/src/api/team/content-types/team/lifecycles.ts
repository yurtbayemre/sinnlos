import {
  OUTSIDE_TRANSACTION,
  TARGETING_FLAGS_LOG,
  TEAM_LINKED_DOCUMENTS,
  advanceRevisionsOf,
  documentsLinking,
  lockMatchedRows,
  markAnnouncementsLinking,
  type TargetingDeleteHost,
} from "../../../../utils/targeting-flags";

/**
 * Team deletes keep the announcements that targeted the team restricted
 * (batch 15 lane 15D, decision 06 §N9, amendment rows A2 and A3), before
 * the delete cascades the link rows away. The delete is never refused.
 *   1. on Postgres the matched team rows are locked `FOR UPDATE`, so no
 *      link to them commits around the scan (utils/targeting-flags.ts
 *      lockMatchedRows);
 *   2. before any other write (§D rule 13): every announcement whose `team`
 *      is a deleted one has its revision locked and advanced, in ascending
 *      documentId order after the team's own version row (the document
 *      lock's). A write gate that saw the rows before the delete then fails
 *      the revision comparison (§N8);
 *   3. those announcement rows get `audience = 'departments'` and
 *      `retargetRequired = true`. The criteria are AND-combined, so a
 *      department-plus-team announcement without its team would widen to
 *      the whole department; with the marker it is moderator-only and
 *      notifies nobody until a moderator (or, within their department, a
 *      department author) re-targets it.
 *
 * Teams have no other targeting consumers in batch 15 (wiki team spaces
 * are batch 16). The mechanics are the department hook's (api/department/
 * content-types/department/lifecycles.ts): beforeDelete for the Document
 * Service's per-row delete, beforeDeleteMany for a script's db-level one,
 * the delete's own transaction (a delete outside one is refused), a failing
 * step fails the delete.
 */

interface DeleteEvent {
  params?: { where?: Record<string, unknown> | null } | null;
}

const TEAM_UID = "api::team.team";

const REFUSAL = "refusing to delete a team without keeping its announcements restricted";

async function keepTargetsRestricted(event: DeleteEvent): Promise<void> {
  const host = strapi as unknown as TargetingDeleteHost;
  if (!host.db.inTransaction()) {
    throw new Error(`${TARGETING_FLAGS_LOG} team delete: ${OUTSIDE_TRANSACTION}`);
  }
  await host.db.transaction(async () => {
    const teamIds = await lockMatchedRows(host, TEAM_UID, event.params?.where);
    if (teamIds.length === 0) return;
    const documents = await documentsLinking(host, TEAM_LINKED_DOCUMENTS, teamIds, REFUSAL);
    await advanceRevisionsOf(host, documents);
    const announcements = await markAnnouncementsLinking(host, "team", teamIds, REFUSAL);
    if (documents.length + announcements > 0) {
      strapi.log.info(
        `${TARGETING_FLAGS_LOG} team delete: advanced the revision of ${documents.length} ` +
          `announcement(s) and marked ${announcements} announcement row(s) 'retargetRequired': ` +
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
