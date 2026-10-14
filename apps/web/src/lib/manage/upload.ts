"use server";

import { unstable_rethrow } from "next/navigation";
import { UPLOAD_FILE_KEY, UPLOAD_HTTP_STATUS, type EditableMedia } from "@sinnlos/domain";
import { actionFailure, failureFor, type ActionResult } from "@/lib/action-result";
import { sendUpload } from "@/lib/api/manage/upload";
import { DEMO_MODE } from "@/lib/config";
import { capabilitiesFor } from "@/lib/roles";
import { StrapiError } from "@/lib/strapi-error";
import { getViewer } from "@/lib/viewer";
import { areaAccess, canDo, lacksDepartment } from "./access";
import { checkUploadFile } from "./upload-check";

/**
 * The upload step of a document's file (deep-dive decision 06 §L6 steps
 * 2-3, §E6; batch 16 plan, lane 16C item 2; contract K14). The form calls
 * it with a FormData holding exactly one `file`, BEFORE the document's
 * save, and sends the answered id with the save (`file: <id>`). "Replace
 * file" is the same step on an existing document. A save that fails after
 * the upload leaves the file unattached: the form keeps its id for the
 * next save (a conflict's Overwrite never uploads twice), and a file
 * nobody attaches is swept by the cms janitor after 24 h (§E5, intended).
 *
 * Steps:
 *   1. the capability: create or edit on documents (moderators and
 *      department authors with a department, §N1); the viewer is read per
 *      call (D-SESSION-01);
 *   2. the form: exactly one file, which passes the early checks of
 *      upload-check.ts (`fileType`, `fileTooLarge`) before anything is
 *      sent;
 *   3. the multipart request (lib/api/manage/upload.ts);
 *   4. the answer, mapped (AC01, K14):
 *        201 with exactly one file row → ok, the row as EditableMedia
 *            (anything else, zero rows or two, is `failed`: §E6 never
 *            matches rows by name);
 *        400 → invalid, `fields.file` = the cms's `details.codes.file`
 *            (`fileType`, `fileTooLarge`, `required`, `invalid`);
 *        413 (the body parser's 50 MB cap, before the cms reads the
 *            file) → invalid, `fields.file` = `fileTooLarge`;
 *        403 → forbidden; 5xx, 429 and network errors → unavailable;
 *        401 with a session → the sign-in redirect, rethrown.
 * No Strapi message reaches the UI (AC02).
 */

export type UploadActionResult = ActionResult<never, EditableMedia>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The one file row of a 201, or null when the answer is not exactly one usable row. */
function soleFileRow(answer: unknown): EditableMedia | null {
  if (!Array.isArray(answer) || answer.length !== 1) return null;
  const row = answer[0];
  if (!isRecord(row)) return null;
  const { id, name, mime, size, url } = row;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
  return {
    id,
    name: typeof name === "string" ? name : "",
    mime: typeof mime === "string" ? mime : "",
    size: typeof size === "number" && Number.isFinite(size) ? size : 0,
    url: typeof url === "string" ? url : "",
  };
}

function fileRefused(code: string): UploadActionResult {
  return actionFailure("invalid", { fields: { [UPLOAD_FILE_KEY]: code } });
}

export async function uploadDocumentFile(form: unknown): Promise<UploadActionResult> {
  // 1. The capability (a Server Action's argument is untrusted; checked after).
  const viewer = await getViewer();
  if (viewer.id === null) return actionFailure("unavailable");
  const access = areaAccess(capabilitiesFor(viewer.role), "documents");
  if (!canDo(access, "create") && !canDo(access, "edit")) return actionFailure("forbidden");
  if (lacksDepartment(access, viewer.department)) return actionFailure("forbidden");

  // 2. Exactly one file, which passes the early checks.
  if (!(form instanceof FormData)) return actionFailure("invalid");
  const entries = form.getAll(UPLOAD_FILE_KEY);
  if (entries.length !== 1 || !(entries[0] instanceof File)) return fileRefused("required");
  const file = entries[0];
  const early = checkUploadFile(file);
  if (early) return fileRefused(early);
  if (DEMO_MODE) return actionFailure("failed");

  // 3. The request.
  let answer: unknown;
  try {
    answer = await sendUpload(file);
  } catch (error) {
    // The sign-in redirect of an expired session must reach Next.
    unstable_rethrow(error);
    if (error instanceof StrapiError && error.status === UPLOAD_HTTP_STATUS.bodyTooLarge) {
      console.warn("[manage-documents] upload refused: 413 → fileTooLarge");
      return fileRefused("fileTooLarge");
    }
    const failure = failureFor(error);
    if (error instanceof StrapiError && error.status < 500) {
      console.warn(
        `[manage-documents] upload refused: ${error.status} ${error.strapiName ?? "-"} → ${failure.code}`,
      );
    } else {
      console.error(`[manage-documents] upload failed → ${failure.code}`, error);
    }
    return failure;
  }
  // No session token: nothing was sent (a guest's 401 is "forbidden" too, AC01).
  if (answer === null) return actionFailure("forbidden");

  // 4. Exactly one row.
  const row = soleFileRow(answer);
  if (!row) {
    console.error(
      `[manage-documents] upload answered ${Array.isArray(answer) ? `${answer.length} rows` : "no list"}, not one file row → failed`,
    );
    return actionFailure("failed");
  }
  return { ok: true, data: row };
}
