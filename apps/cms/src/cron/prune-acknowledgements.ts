import { ANNOUNCEMENT_UID, DOCUMENT_UID } from "../utils/authoring-uids";
import {
  EXISTING_DOCUMENTS_CHUNK,
  existingDocumentIds,
  type ExistingDocumentsHost,
} from "../utils/existing-documents";

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
 * The run reads the DISTINCT targets (one row per confirmed document,
 * however many people confirmed it), looks their documents up per type,
 * and deletes the confirmations of the gone ones with one `deleteMany` per
 * type and chunk (the user link rows go with them, ON DELETE CASCADE,
 * integration/retention-v028.integration.test.ts). Confirmations of live
 * documents are never paged through, so however many there are, they
 * cannot hide an orphan from the run. Runs at 03:52 APP_TIME_ZONE
 * (cron/registry.ts); errors propagate to the cron wrapper.
 */

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
    getConnection(table: string): { distinct(...columns: string[]): PromiseLike<unknown[]> };
    metadata: {
      get(uid: string): { tableName: string; attributes: Record<string, { columnName?: string }> };
    };
  };
  log: { info(message: string): void };
}

/** One distinct target of the stored confirmations. */
export interface AckTarget {
  targetType?: unknown;
  targetDocumentId?: unknown;
}

const countOf = (result: unknown): number => {
  const count = (result as { count?: unknown } | null)?.count;
  return typeof count === "number" ? count : 0;
};

/** The checkable targets by `targetType` (pure): unknown types and blank ids drop out. */
export function targetsByType(targets: readonly AckTarget[]): Map<string, string[]> {
  const byType = new Map<string, string[]>();
  for (const target of targets) {
    const type = typeof target.targetType === "string" ? target.targetType : "";
    const documentId = typeof target.targetDocumentId === "string" ? target.targetDocumentId : "";
    if (!ACK_TARGET_UIDS[type] || documentId === "") continue;
    byType.set(type, [...(byType.get(type) ?? []), documentId]);
  }
  return byType;
}

/** Deletes the acknowledgements of documents gone in every state; returns how many went. */
export async function pruneAcknowledgements(strapi: AckJanitorStrapi): Promise<number> {
  const meta = strapi.db.metadata.get(ACKNOWLEDGEMENT_UID);
  const typeColumn = meta.attributes.targetType?.columnName ?? "target_type";
  const idColumn = meta.attributes.targetDocumentId?.columnName ?? "target_document_id";
  const targets = (await strapi.db
    .getConnection(meta.tableName)
    .distinct(`${typeColumn} as targetType`, `${idColumn} as targetDocumentId`)) as AckTarget[];

  const acks = strapi.db.query(ACKNOWLEDGEMENT_UID);
  let deleted = 0;
  for (const [type, documentIds] of targetsByType(targets)) {
    const existing = await existingDocumentIds(
      strapi as unknown as ExistingDocumentsHost,
      ACK_TARGET_UIDS[type],
      documentIds,
    );
    const gone = documentIds.filter((documentId) => !existing.has(documentId));
    for (let start = 0; start < gone.length; start += EXISTING_DOCUMENTS_CHUNK) {
      deleted += countOf(
        await acks.deleteMany({
          where: {
            targetType: type,
            targetDocumentId: { $in: gone.slice(start, start + EXISTING_DOCUMENTS_CHUNK) },
          },
        }),
      );
    }
  }
  if (deleted > 0) {
    strapi.log.info(
      `${ACK_JANITOR_LOG} pruned ${deleted} acknowledgement(s) of documents that no longer exist`,
    );
  }
  return deleted;
}
