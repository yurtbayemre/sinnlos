import { CLASSIFIED_UID } from "./delete-audit";
import { MEDIA_CLAIM_FIELDS } from "./media-fields";
import { lockAttachableFiles, mediaReferences, resolveFileIds } from "./upload-orphans";
import { refuseKeys } from "./write-allowlist";

/**
 * Every media field refuses a file that is gone or on its way out (a
 * tombstone, utils/upload-orphans.ts), from every writer, the admin panel
 * included: a removal that failed between the bytes and the row leaves a
 * tombstoned file row, and a link to it would point at missing bytes.
 *
 * The claimed types (media-fields.ts, the media-claims Document Service
 * middleware) and classified (its lifecycle) check their fields already;
 * this query-layer subscriber covers every other media field of every
 * content type, found at boot: the users-permissions avatar today, and any
 * field added later. The files are locked in ascending order inside the
 * write's transaction, as the other attach paths do, and the write is
 * refused with the field's key (400, `details.keys`).
 */
export function registerMediaTombstoneGuard(strapi: any): void {
  const fieldsByUid = new Map<string, string[]>();
  for (const [uid, model] of Object.entries<any>(strapi.contentTypes ?? {})) {
    if (uid in MEDIA_CLAIM_FIELDS || uid === CLASSIFIED_UID) continue;
    const fields = Object.entries<any>(model?.attributes ?? {})
      .filter(([, attribute]) => attribute?.type === "media")
      .map(([name]) => name);
    if (fields.length > 0) fieldsByUid.set(uid, fields);
  }
  if (fieldsByUid.size === 0) return;

  const guard = async (event: any) => {
    const uid = event.model?.uid;
    const data = event.params?.data;
    if (!data || typeof data !== "object") return;
    const fields = (fieldsByUid.get(uid) ?? []).filter((field) => field in data);
    if (fields.length === 0) return;
    // Rows before files (the attach paths' lock order): an update locks its own
    // row first, as a password change's token-version bump does (Codex: the
    // reverse order deadlocked an avatar save against a password save).
    const where = event.params?.where;
    if (where) await strapi.db.queryBuilder(uid).select(["id"]).where(where).forUpdate().execute();
    // shortcut: outside a transaction (a raw db.query write) these locks end
    // with the check, so a removal can still slip in before the link; every app
    // path that writes these fields runs in the Document Service's transaction.
    // Wrap such a write in strapi.db.transaction if one ever appears.
    for (const field of fields) {
      const fileIds = await resolveFileIds(strapi, mediaReferences(data[field]));
      if (fileIds.length > 0 && !(await lockAttachableFiles(strapi, fileIds))) refuseKeys([field]);
    }
  };
  strapi.db.lifecycles.subscribe({
    models: [...fieldsByUid.keys()],
    beforeCreate: guard,
    beforeUpdate: guard,
  });
}
