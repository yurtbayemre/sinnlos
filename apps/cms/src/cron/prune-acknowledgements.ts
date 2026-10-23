import { ANNOUNCEMENT_UID, DOCUMENT_UID } from "../utils/authoring-uids";
import { existingDocumentIds, type ExistingDocumentsHost } from "../utils/existing-documents";

/**
 * Nightly retention of read confirmations (v0.28, M11; owner decision
 * 2026-10-23): an acknowledgement is deleted once the document it confirms
 * (`targetType` + `targetDocumentId`) no longer exists in any state
 * (utils/existing-documents.ts). There is NO age rule: a confirmation
 * stays while its document can still require it, otherwise the person
 * would be asked again. An organisation that needs confirmations as proof
 * exports the confirmation report before it deletes the document.
 * Anonymisation deletes a person's confirmations on its own (lane A2).
 *
 * An unknown `targetType` or an empty `targetDocumentId` names no checkable
 * document and is kept (fail closed). A deleted document never comes back
 * (Strapi never reuses a documentId), so a confirmation found orphaned
 * stays orphaned and no lock is needed.
 *
 * Deletion: id pages of ACK_PRUNE_BATCH, one `deleteMany` per page for the
 * orphans in it (the user link rows go with them, ON DELETE CASCADE,
 * integration/retention-v028.integration.test.ts). At most
 * ACK_PRUNE_MAX_BATCHES pages per run. Runs at 03:52 APP_TIME_ZONE
 * (cron/registry.ts); errors propagate to the cron wrapper.
 */

/** Rows per read and per `deleteMany`. */
export const ACK_PRUNE_BATCH = 500;
/** Pages per run: at most 100 000 rows read a night. */
export const ACK_PRUNE_MAX_BATCHES = 200;

export const ACK_JANITOR_LOG = "[ack-janitor]";

const ACKNOWLEDGEMENT_UID = "api::acknowledgement.acknowledgement";

/** The document type each `targetType` names (acknowledgement schema enum). */
export const ACK_TARGET_UIDS: Readonly<Record<string, string>> = {
  announcement: ANNOUNCEMENT_UID,
  document: DOCUMENT_UID,
};

/** The slice of the Strapi instance the janitor uses. */
export interface AckJanitorStrapi {
  db: {
    query(uid: string): {
      findMany(params: Record<string, unknown>): Promise<unknown>;
      deleteMany(params: Record<string, unknown>): Promise<{ count?: number } | unknown>;
    };
  };
  log: { info(message: string): void };
}

interface AckRow {
  id: number;
  targetType?: unknown;
  targetDocumentId?: unknown;
}

const rowsOf = (value: unknown): AckRow[] =>
  (Array.isArray(value) ? value : []).filter(
    (row: unknown): row is AckRow =>
      typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "number",
  );

const countOf = (result: unknown): number => {
  const count = (result as { count?: unknown } | null)?.count;
  return typeof count === "number" ? count : 0;
};

/** The ids of `rows` whose target is gone, given the existing documentIds per uid (pure). */
export function orphanedAcknowledgements(
  rows: readonly AckRow[],
  existing: ReadonlyMap<string, ReadonlySet<string>>,
): number[] {
  return rows
    .filter((row) => {
      const uid = typeof row.targetType === "string" ? ACK_TARGET_UIDS[row.targetType] : undefined;
      const documentId = typeof row.targetDocumentId === "string" ? row.targetDocumentId : "";
      if (!uid || documentId === "") return false;
      const found = existing.get(uid);
      return found !== undefined && !found.has(documentId);
    })
    .map((row) => row.id);
}

/** Deletes the acknowledgements of documents gone in every state; returns how many went. */
export async function pruneAcknowledgements(strapi: AckJanitorStrapi): Promise<number> {
  const acks = strapi.db.query(ACKNOWLEDGEMENT_UID);
  let deleted = 0;
  let afterId = 0;
  for (let batch = 0; batch < ACK_PRUNE_MAX_BATCHES; batch += 1) {
    const rows = rowsOf(
      await acks.findMany({
        where: { id: { $gt: afterId } },
        select: ["id", "targetType", "targetDocumentId"],
        orderBy: { id: "asc" },
        limit: ACK_PRUNE_BATCH,
      }),
    );
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1].id;
    const existing = new Map<string, Set<string>>();
    for (const [type, uid] of Object.entries(ACK_TARGET_UIDS)) {
      const ids = rows
        .filter((row) => row.targetType === type && typeof row.targetDocumentId === "string")
        .map((row) => row.targetDocumentId as string);
      existing.set(
        uid,
        await existingDocumentIds(strapi as unknown as ExistingDocumentsHost, uid, ids),
      );
    }
    const ids = orphanedAcknowledgements(rows, existing);
    if (ids.length > 0) deleted += countOf(await acks.deleteMany({ where: { id: { $in: ids } } }));
    if (rows.length < ACK_PRUNE_BATCH) break;
  }
  if (deleted > 0) {
    strapi.log.info(
      `${ACK_JANITOR_LOG} pruned ${deleted} acknowledgement(s) of documents that no longer exist`,
    );
  }
  return deleted;
}
