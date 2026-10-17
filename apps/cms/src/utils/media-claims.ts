/**
 * File claims (deep-dive decision 06 §E3, §E4; batch 16 plan item 3,
 * contract K12): a Document Service middleware that makes attaching and
 * releasing a stamped upload safe for every action of a claimed uid
 * (`create`, `update`, `clone`, `publish`, `unpublish`, `discardDraft`,
 * `delete`) from every source (content API, Content Manager, scheduler,
 * boot writers).
 *
 * NOT REGISTERED HERE: lane 16B wires `createMediaClaims` into slot 7
 * (`media-claims`) of bootstrap/document-middlewares.ts. It runs inside the
 * transaction the document lock opened (and opens one itself otherwise).
 *
 * HOW. It reads which files the claimed fields of the document's rows link
 * BEFORE the action, runs the action, and reads them AFTER it, in the same
 * transaction; the decision is taken on what was written, not on the
 * payload's shape.
 *   - LOCK FIRST: every file the payload names on a claimed field (an id,
 *     a documentId, `{ id }`, `{ documentId }`, a list, `connect`/`set`;
 *     documentIds resolved to row ids), and every stored file the action
 *     copies to a new row (publish and clone: the draft's; discardDraft: the
 *     published one's), is locked (`FOR UPDATE`, ascending ids) BEFORE the
 *     action, and refused when it is gone or tombstoned. The action's link
 *     insert takes a key share on the file row (the foreign key); two
 *     transactions that both inserted and then asked for the row lock would
 *     deadlock (Postgres 40P01). File rows come last in the lock order (§5
 *     R10): the document's own version row is already held, and nothing
 *     locks file rows before other rows.
 *   - ATTACH: every file linked after and not before (for a clone: not by
 *     the source document either; a panel clone copies the source's file,
 *     which is no attachment, and the two documents then share it) is
 *     locked (a no-op for the files locked first) and re-checked under the
 *     lock:
 *       - it exists;
 *       - an UNSTAMPED file (a panel upload) is not claimed: no check, and
 *         it is never removed;
 *       - a STAMPED file is not tombstoned (on its way out,
 *         utils/upload-orphans.ts) and is linked by nothing but this
 *         document's own rows (`files_related_mph`, any related type);
 *       - with a users-permissions caller (the request context, as the
 *         audit trail reads it): stamped by that caller, with a stored mime
 *         on the field's list (§E2).
 *     Any failure throws the allowlist's refusal on the field (400,
 *     `details.keys: [field]`, no code: "invalid"), and the whole action
 *     rolls back: a missing, foreign, taken or tombstoned file answer
 *     alike. Two requests that attach one fresh upload serialise on its row
 *     lock; the second sees the first one's committed link and fails.
 *   - REMOVE: every file linked before and by none of the document's rows
 *     after (a replaced, discarded or deleted file; a draft-only replace
 *     keeps the published file until the publish) is handed to
 *     `claimAndRemove` AFTER THE COMMIT (utils/after-commit.ts). It locks
 *     the row and removes only a stamped file that nothing links at all,
 *     so a file another request attached in between stays. Each removal
 *     records its audit row, linked to the document (utils/delete-audit.ts).
 */
import { MEDIA_CLAIM_FIELDS } from "./media-fields";
export { MEDIA_CLAIM_FIELDS } from "./media-fields";

import { afterCommit } from "./after-commit";
import { resolveActor } from "./audit";
import { runWithDeleteAudit } from "./delete-audit";
import { MUTATING_ACTIONS } from "./document-lock";
import {
  claimAndRemove,
  fileLinks,
  isTombstoned,
  lockAndReadFile,
  mediaReferences,
  resolveFileIds,
  uploadedByOf,
  type FileLink,
} from "./upload-orphans";
import { refuseKeys } from "./write-allowlist";

export const MEDIA_CLAIMS_LOG = "[media-claims]";

/** The slice of the Strapi instance the claims use (the real one in production). */
export type MediaClaimsHost = any;

/** What a Document Service middleware receives (C4). */
export interface MediaClaimsContext {
  uid?: string;
  action?: string;
  params?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const documentIdOf = (value: unknown): string | null =>
  isRecord(value) && typeof value.documentId === "string" && value.documentId !== ""
    ? value.documentId
    : null;

/** The files a document's rows link on the claimed fields: file id → field. */
export interface DocumentLinks {
  rowIds: number[];
  files: Map<number, string>;
  /** The files the draft rows link (what publish and clone copy). */
  draftFiles?: ReadonlySet<number>;
  /** The files the published rows link (what discardDraft copies back). */
  publishedFiles?: ReadonlySet<number>;
}

const NO_LINKS: DocumentLinks = { rowIds: [], files: new Map() };

/** Reads a document's rows and their claimed links, inside `trx`. */
async function documentLinks(
  strapi: MediaClaimsHost,
  uid: string,
  fields: readonly string[],
  documentId: string | null,
  trx: unknown,
): Promise<DocumentLinks> {
  if (!documentId) return NO_LINKS;
  const rows: Array<{ id: number; publishedAt?: unknown }> = await strapi.db
    .query(uid)
    .findMany({ where: { documentId }, select: ["id", "publishedAt"] });
  const rowIds = rows.map((row) => row.id);
  if (rowIds.length === 0) return { rowIds, files: new Map() };
  const published = new Set(rows.filter((row) => row.publishedAt).map((row) => row.id));
  const links: Array<{ file_id: number; field: string; related_id: number }> = await strapi.db
    .getConnection("files_related_mph")
    .transacting(trx)
    .where({ related_type: uid })
    .whereIn("related_id", rowIds)
    .whereIn("field", [...fields])
    .select("file_id", "field", "related_id");
  const draftFiles = new Set<number>();
  const publishedFiles = new Set<number>();
  for (const link of links) {
    (published.has(Number(link.related_id)) ? publishedFiles : draftFiles).add(
      Number(link.file_id),
    );
  }
  return {
    rowIds,
    files: new Map(links.map((link) => [Number(link.file_id), link.field])),
    draftFiles,
    publishedFiles,
  };
}

/** A media value that replaces the field outright: an id, a list, `{ id }`, `{ set }`, null. */
const replacesField = (value: unknown): boolean =>
  value !== undefined && !(isRecord(value) && ("connect" in value || "disconnect" in value));

/**
 * The stored files an action copies to a new row (Codex round 2): publish
 * (also a create or update with `status: 'published'`) and clone copy the
 * draft rows' files, discardDraft the published rows'. They are no
 * attachments (no ownership or exclusivity check), but a file on its way out
 * must not be copied: they are locked and checked for a tombstone like the
 * payload's files. An update with `status: 'published'` writes the payload
 * to the draft first, so a stored draft file on a field the payload replaces
 * outright is not copied (the batch integration's Codex review: replacing a
 * tombstoned file with Save and publish was refused); a `connect` or
 * `disconnect` edit keeps the stored files, so they still count.
 */
export function copiedFiles(
  action: string,
  params: Record<string, unknown>,
  before: DocumentLinks,
): number[] {
  const draft = [...(before.draftFiles ?? [])];
  const published = [...(before.publishedFiles ?? [])];
  if (action === "publish" || action === "clone") return draft;
  if (action === "discardDraft") return published;
  if ((action === "update" || action === "create") && params.status === "published") {
    const data = isRecord(params.data) ? params.data : {};
    return draft.filter((fileId) => !replacesField(data[before.files.get(fileId) ?? ""]));
  }
  return [];
}

/**
 * The file ids a payload names on the claimed fields (id → field, ascending
 * ids): every media reference shape Strapi 5.57 accepts (utils/
 * upload-orphans.ts mediaReferences), documentIds resolved to row ids.
 * Anything else is ignored here; the after-read still catches what was
 * written.
 */
export async function payloadFileIds(
  strapi: MediaClaimsHost,
  data: unknown,
  fields: readonly string[],
): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  if (!isRecord(data)) return ids;
  for (const field of fields) {
    for (const id of await resolveFileIds(strapi, mediaReferences(data[field]))) {
      if (!ids.has(id)) ids.set(id, field);
    }
  }
  return new Map([...ids].sort((a, b) => a[0] - b[0]));
}

/** Files linked after and not before (nor by a clone's source): the attachments. */
export function attachedFiles(before: DocumentLinks, after: DocumentLinks): number[] {
  return [...after.files.keys()]
    .filter((fileId) => !before.files.has(fileId))
    .sort((a, b) => a - b);
}

/** Files linked before and by none of the document's rows after: the releases. */
export function releasedFiles(before: DocumentLinks, after: DocumentLinks): number[] {
  return [...before.files.keys()]
    .filter((fileId) => !after.files.has(fileId))
    .sort((a, b) => a - b);
}

/** One attached file, read under its lock. */
export interface AttachCheck {
  file: any;
  links: ReadonlyArray<FileLink>;
  uid: string;
  ownRowIds: readonly number[];
  /** The users-permissions caller, if any. */
  callerId: number | null;
  mimes: readonly string[];
}

/** The decision for one attached file: keep it unchecked (unstamped), accept it, or refuse. */
export function attachVerdict(check: AttachCheck): "unclaimed" | "ok" | "refuse" {
  const { file } = check;
  if (!isRecord(file)) return "refuse";
  const owner = uploadedByOf(file);
  if (owner === null) return "unclaimed";
  if (isTombstoned(file)) return "refuse";
  const foreign = check.links.some(
    (link) => link.relatedType !== check.uid || !check.ownRowIds.includes(link.relatedId),
  );
  if (foreign) return "refuse";
  if (check.callerId !== null) {
    if (owner !== check.callerId) return "refuse";
    if (typeof file.mime !== "string" || !check.mimes.includes(file.mime)) return "refuse";
  }
  return "ok";
}

/** The media-claims Document Service middleware (see the module comment). */
export function createMediaClaims(strapi: MediaClaimsHost) {
  return async (context: MediaClaimsContext, next: () => Promise<unknown>): Promise<unknown> => {
    const uid = context.uid ?? "";
    const claimed = MEDIA_CLAIM_FIELDS[uid];
    const action = context.action ?? "";
    if (!claimed || !MUTATING_ACTIONS.includes(action)) return next();
    const fields = Object.keys(claimed);
    return strapi.db.transaction(async ({ trx }: { trx: unknown }) => {
      const sourceId = action === "create" ? null : documentIdOf(context.params);
      const params = isRecord(context.params) ? context.params : {};
      const before = await documentLinks(strapi, uid, fields, sourceId, trx);
      // Every file the action will link anew (the payload's) or copy (the
      // stored ones publish, clone and discard copy), locked in one ascending
      // pass before the action writes a link: one that is gone or on its way
      // out (a removal reserved it) is refused before any link exists.
      const pending = await payloadFileIds(strapi, params.data, fields);
      for (const fileId of copiedFiles(action, params, before)) {
        if (!pending.has(fileId)) pending.set(fileId, before.files.get(fileId) as string);
      }
      for (const fileId of [...pending.keys()].sort((a, b) => a - b)) {
        const file = await lockAndReadFile(strapi, fileId);
        if (!file || isTombstoned(file)) refuseKeys([pending.get(fileId) as string]);
      }
      const result = await next();
      const targetId = action === "create" || action === "clone" ? documentIdOf(result) : sourceId;
      const after = await documentLinks(strapi, uid, fields, targetId, trx);

      const actor = resolveActor(strapi, undefined);
      const callerId = actor.actorKind === "user" ? actor.actorUserId : null;
      for (const fileId of attachedFiles(before, after)) {
        const field = after.files.get(fileId) as string;
        const file = await lockAndReadFile(strapi, fileId);
        const links = file ? await fileLinks(strapi, fileId, trx) : [];
        const verdict = attachVerdict({
          file,
          links,
          uid,
          ownRowIds: after.rowIds,
          callerId,
          mimes: claimed[field] ?? [],
        });
        if (verdict === "refuse") refuseKeys([field]);
      }

      // A clone shares the source's files: nothing is released.
      const released = action === "clone" ? [] : releasedFiles(before, after);
      if (released.length > 0 && targetId) {
        await afterCommit(
          strapi.db,
          async () => {
            for (const fileId of released) {
              await runWithDeleteAudit({ related: { uid, documentId: targetId } }, () =>
                claimAndRemove(strapi, fileId),
              );
            }
          },
          (err) =>
            strapi.log.error(
              `${MEDIA_CLAIMS_LOG} could not remove the released file(s) ${released.join(", ")}: ${
                (err as Error).message
              }`,
            ),
        );
      }
      return result;
    });
  };
}
