/**
 * Which documents still exist, in ANY state (v0.28 retention): a document
 * exists while it has a row, draft or published. Strapi 5 never reuses a
 * documentId, and a publish (delete + re-create of the published row) or an
 * unpublish keeps the draft row, so "no row at all" is permanent: the
 * janitors that drop records tied to a deleted document (acknowledgements,
 * RSVPs, notification anchors) read it through here.
 *
 * Under Read Committed a publish in flight is invisible until it commits,
 * so it never looks like a deletion.
 */

/** documentIds per lookup (well below every bind limit). */
export const EXISTING_DOCUMENTS_CHUNK = 200;

/** The slice of the Strapi instance the lookup uses. */
export interface ExistingDocumentsHost {
  db: {
    query(uid: string): { findMany(params: Record<string, unknown>): Promise<unknown> };
  };
}

/** The documentIds of `documentIds` that still have a row of `uid` (any state). */
export async function existingDocumentIds(
  strapi: ExistingDocumentsHost,
  uid: string,
  documentIds: Iterable<string>,
): Promise<Set<string>> {
  const wanted = [...new Set(documentIds)].filter((id) => id !== "");
  const found = new Set<string>();
  for (let start = 0; start < wanted.length; start += EXISTING_DOCUMENTS_CHUNK) {
    const rows = await strapi.db.query(uid).findMany({
      where: { documentId: { $in: wanted.slice(start, start + EXISTING_DOCUMENTS_CHUNK) } },
      select: ["documentId"],
    });
    for (const row of Array.isArray(rows) ? rows : []) {
      const documentId = (row as { documentId?: unknown } | null)?.documentId;
      if (typeof documentId === "string") found.add(documentId);
    }
  }
  return found;
}
