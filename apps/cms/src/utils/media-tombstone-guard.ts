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
    const data = event.params?.data;
    if (!data || typeof data !== "object") return;
    for (const field of fieldsByUid.get(event.model?.uid) ?? []) {
      if (!(field in data)) continue;
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
