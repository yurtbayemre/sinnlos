/**
 * The write check for file references in Markdown (v0.34, audit finding B1;
 * deep-dive plan-v034-rev3.md "Write-time check").
 *
 * An unstamped file that nothing links opens for whoever may read a
 * Markdown field naming it (utils/upload-access.ts, rule 3). Without this
 * check that would be a way in: someone who knows the URL of a file meant
 * for another audience could paste `/uploads/<name>` into a page they may
 * write and read, and open the file through it. So a content-API write by a
 * non-moderator that ADDS such a reference (one the field's committed value
 * does not have yet) must name only files the writer may open already, by
 * the very same decision, against the committed state (this runs before the
 * action, inside the document lock's transaction). Otherwise the write is
 * refused: 400 with `details.codes.<field> = "uploadNotAllowed"`
 * (@sinnlos/domain authoring/codes.ts), and nothing is written.
 *
 * Covered: every Document Service create and update of a host type
 * (UPLOAD_HOST_FIELDS) from a users-permissions request: the generic writes
 * and the authoring actions (authoringActionsFor, the wiki draft actions
 * createDraft/saveDraft/restore, the organisation descriptions). Publish
 * and discard copy what was stored; wiki revisions are written by the page
 * lifecycle from the page body. Not covered, on purpose: moderators (they
 * may open every file), the admin panel and system writers (no
 * users-permissions caller). References that name no stored file are left
 * alone (an outside link may contain `/uploads/` too); they open nothing.
 *
 * What was stored before v0.34 was never checked: the rollout reviews it
 * once (infra/diagnostics/upload-references.sql).
 *
 * Slot `upload-reference-guard` of bootstrap/document-middlewares.ts.
 */
import { MODERATORS, hasRole } from "../bootstrap/roles";
import type { DocumentMiddleware } from "./poll-audience-guard";
import {
  UPLOAD_HOST_FIELDS,
  mayOpenFile,
  resolveUploadFile,
  uploadReferenceNames,
  type UploadAccessHost,
  type UploadViewer,
} from "./upload-access";
import { refuseKeys } from "./write-allowlist";

/** The refusal code of a reference the writer may not open. */
export const UPLOAD_REFERENCE_CODE = "uploadNotAllowed";

const CHECKED_ACTIONS: ReadonlySet<string> = new Set(["create", "update"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The request's users-permissions caller, or null (admin panel, system, anonymous). */
function contentApiCaller(strapi: UploadAccessHost): UploadViewer | null {
  const ctx = strapi.requestContext?.get?.();
  const state = isRecord(ctx) && isRecord(ctx.state) ? ctx.state : null;
  const strategy =
    isRecord(state?.auth) && isRecord(state.auth.strategy) ? state.auth.strategy.name : null;
  const user = state?.user;
  if (strategy !== "users-permissions" || !isRecord(user) || typeof user.id !== "number")
    return null;
  return user as unknown as UploadViewer;
}

/** The names each field already references in the document's stored rows. */
async function committedNames(
  strapi: UploadAccessHost,
  uid: string,
  documentId: unknown,
  fields: readonly string[],
): Promise<Map<string, Set<string>>> {
  const names = new Map(fields.map((field) => [field, new Set<string>()]));
  if (typeof documentId !== "string" || documentId === "") return names;
  const rows: unknown[] = await strapi.db
    .query(uid)
    .findMany({ where: { documentId }, select: ["id", ...fields] });
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isRecord(row)) continue;
    for (const field of fields) {
      for (const name of uploadReferenceNames(row[field])) names.get(field)!.add(name);
    }
  }
  return names;
}

export function createUploadReferenceGuard(strapi: UploadAccessHost): DocumentMiddleware {
  return async (context, next) => {
    const fields = context.uid ? UPLOAD_HOST_FIELDS[context.uid] : undefined;
    if (!fields || !CHECKED_ACTIONS.has(context.action ?? "")) return next();
    const params = isRecord(context.params) ? context.params : {};
    const data = isRecord(params.data) ? params.data : {};
    const touched = fields.filter(
      (field) => typeof data[field] === "string" && (data[field] as string).includes("/uploads/"),
    );
    if (touched.length === 0) return next();
    const caller = contentApiCaller(strapi);
    if (!caller || hasRole(caller, MODERATORS)) return next();

    await strapi.db.transaction(async ({ trx }: { trx: unknown }) => {
      const committed = await committedNames(strapi, context.uid!, params.documentId, touched);
      const refused: string[] = [];
      for (const field of touched) {
        for (const name of uploadReferenceNames(data[field])) {
          if (committed.get(field)!.has(name)) continue;
          const file = await resolveUploadFile(strapi, name);
          if (file && !(await mayOpenFile(strapi, caller, file, trx))) {
            refused.push(field);
            break;
          }
        }
      }
      if (refused.length > 0) {
        refuseKeys(
          refused,
          Object.fromEntries(refused.map((field) => [field, UPLOAD_REFERENCE_CODE])),
        );
      }
    });
    return next();
  };
}
