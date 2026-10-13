/**
 * The delete trail for ads and uploaded files (owner, 2026-10-13: "who
 * deleted what, when, from where"; batch 16 lane 16A). On 2026-10-13 an ad
 * with an image was deleted in production and nothing recorded who did it.
 *
 * ONE ROW PER DELETE, through batch 15's append-only recorder
 * (utils/audit.ts `recordAuditEvent`, the `audit_events` contract):
 *   - an ad (`api::classified.classified`): written by the classified
 *     `beforeDelete` lifecycle, INSIDE the delete's transaction, for every
 *     source: the author through the API, a moderator's takedown through
 *     the web, the admin panel's Content Manager, the nightly
 *     `classified-janitor`. `detail`: the ad's title;
 *   - an uploaded file (`plugin::upload.file`): written by the upload
 *     service's `remove`, which extensions/upload/strapi-server.ts wraps.
 *     Every file delete goes through it: the admin Media Library (single,
 *     bulk and folder deletes), and `claimAndRemove` (utils/upload-orphans.ts)
 *     for the classified image cleanup, the `cleanup-uploads` endpoint, the
 *     nightly `uploads-janitor` and the media claims. The row and the
 *     upload service's work (bytes, then the row) run in ONE transaction,
 *     so the audit row commits exactly when the file row's delete commits.
 *     `detail`: the file id, mime, size in bytes, the related document
 *     (the deleted ad for its images, the saved document for a claim, or
 *     the rows still linking a Media Library file) and the file name.
 *
 * THE ACTOR, as batch 15 resolves it (`resolveActor`, from
 * `strapi.requestContext`): a users-permissions user (`actorUserId`, and
 * the user's role type as `actorClass`), an admin (`actorAdminId`), or
 * `system`. The source is `content-api`, `admin` or `system`, or `cron`
 * where a janitor runs the delete inside `runWithDeleteAudit({ source:
 * "cron" })`. A commit callback keeps the request's context, so the image
 * cleanup after an ad delete is attributed to whoever deleted the ad.
 * Nothing else is recorded: no IP address, no token, no request data.
 *
 * FAILURES follow batch 15's rule for the trail: the insert is never
 * caught. A failing insert fails the delete (the ad delete rolls back; the
 * file stays, and `claimAndRemove`'s tombstone makes the janitor retry), so
 * no delete commits without its row.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { recordAuditEvent, resolveActor, type AuditHost } from "./audit";
import { getAuthoringScope, type AuditSource } from "./document-lock";

export const CLASSIFIED_UID = "api::classified.classified";
export const UPLOAD_FILE_UID = "plugin::upload.file";

/** What a caller knows about a delete that the request context does not. */
export interface DeleteAuditContext {
  /** Overrides the derived source (the janitors set `cron`). */
  source?: AuditSource;
  /** The document a file belonged to (the deleted ad; the saved document). */
  related?: { uid: string; documentId: string };
}

const storage = new AsyncLocalStorage<DeleteAuditContext>();

/** Runs `fn` with `context` (merged over an outer one) for every delete it causes. */
export function runWithDeleteAudit<T>(context: DeleteAuditContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, fn);
}

/** The context the current delete runs in (runWithDeleteAudit), if any. */
export function deleteAuditContext(): DeleteAuditContext | undefined {
  return storage.getStore();
}

/** A file row as the upload service hands it to `remove`. */
export interface DeletedFile {
  id?: unknown;
  documentId?: unknown;
  name?: unknown;
  mime?: unknown;
  size?: unknown;
  sizeInBytes?: unknown;
}

export type DeleteTarget =
  | { kind: "classified"; documentId: string; title?: unknown }
  | {
      kind: "file";
      file: DeletedFile;
      /** The rows linking the file when it goes (`files_related_mph`). */
      links?: ReadonlyArray<{ relatedType: string; relatedId: number }>;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The users-permissions role type of the request's user, if any. */
function roleOfRequest(strapi: Pick<AuditHost, "requestContext">): string | null {
  const ctx = strapi.requestContext?.get?.();
  const user = isRecord(ctx) && isRecord(ctx.state) ? ctx.state.user : undefined;
  const role = isRecord(user) ? user.role : undefined;
  return isRecord(role) && typeof role.type === "string" ? role.type : null;
}

/** Bytes of a file row: `sizeInBytes` when present, else core's kilobytes. */
function bytesOf(file: DeletedFile): number | null {
  if (typeof file.sizeInBytes === "number") return file.sizeInBytes;
  return typeof file.size === "number" ? Math.round(file.size * 1000) : null;
}

function fileDetail(
  file: DeletedFile,
  related: DeleteAuditContext["related"],
  links: ReadonlyArray<{ relatedType: string; relatedId: number }>,
): string {
  const parts = [`file ${String(file.id)}`];
  if (typeof file.mime === "string") parts.push(file.mime);
  const bytes = bytesOf(file);
  if (bytes !== null) parts.push(`${bytes} B`);
  if (related) parts.push(`of ${related.uid} ${related.documentId}`);
  else if (links.length > 0) {
    parts.push(`linked by ${links.map((l) => `${l.relatedType}#${l.relatedId}`).join(", ")}`);
  }
  return `${parts.join(", ")}: ${typeof file.name === "string" ? file.name : ""}`;
}

/**
 * Records one delete (see the module comment). Joins the ambient
 * transaction; nothing here catches.
 */
export async function recordDelete(strapi: AuditHost, target: DeleteTarget): Promise<void> {
  const context = deleteAuditContext();
  const scope = getAuthoringScope();
  const actor = resolveActor(strapi, undefined);
  const source = context?.source ?? scope?.source ?? actor.source;
  const actorClass = actor.actorKind === "user" ? roleOfRequest(strapi) : null;
  const common = { ...actor, source, actorClass, action: "delete" as const, keys: null };
  if (target.kind === "classified") {
    const title = typeof target.title === "string" ? target.title : "";
    await recordAuditEvent(strapi, {
      ...common,
      targetUid: CLASSIFIED_UID,
      targetDocumentId: target.documentId,
      detail: `title: ${title}`,
    });
    return;
  }
  const file = target.file;
  await recordAuditEvent(strapi, {
    ...common,
    targetUid: UPLOAD_FILE_UID,
    targetDocumentId:
      typeof file.documentId === "string" && file.documentId !== ""
        ? file.documentId
        : `file-${String(file.id)}`,
    detail: fileDetail(file, context?.related, target.links ?? []),
  });
}
