/**
 * The multipart upload of v2 authoring (deep-dive decision 06 §E6, §L6;
 * batch 16 plan, lane 16C item 2; contract K14): one file to
 * `POST /api/upload` with the session's JWT. Transport only (WD03): the
 * Server Action in lib/manage/upload.ts checks the caller and the file
 * first and maps the answer.
 *
 * Not strapi(): it always sends JSON (lib/strapi/client.ts). The rules
 * strapi() follows still hold here:
 *   - the JWT comes from getStrapiToken() (lib/session.ts), never from the
 *     browser; no token: the request is not sent (`null`);
 *   - every request is no-store (D-DC01);
 *   - a 401 WITH a token means the session's Strapi JWT expired or was
 *     revoked: redirect("/sign-in?expired=1") exactly like strapi(), so the
 *     action rethrows Next's redirect instead of answering a result;
 *   - any other refusal throws a StrapiError with the cms's envelope, which
 *     the AC01 mapping reads (400 `details.keys`/`details.codes`, 403, 413,
 *     5xx).
 * Unlike the marketplace's uploadAdImages (lib/classified-actions.ts),
 * which throws on every non-OK answer, a refusal here is an answer the form
 * explains (`fileType`, `fileTooLarge`).
 */
import { redirect } from "next/navigation";
import { STRAPI_URL } from "@/lib/config";
import { getStrapiToken } from "@/lib/session";
import { StrapiError } from "@/lib/strapi-error";

/** The multipart field Strapi's upload controller reads. */
export const UPLOAD_FIELD = "files";

/**
 * Sends `file` and resolves to the cms's parsed answer (an array of file
 * rows on a 201), or null without a session token (nothing was sent).
 */
export async function sendUpload(file: File): Promise<unknown> {
  const token = await getStrapiToken();
  if (!token) return null;

  const body = new FormData();
  body.append(UPLOAD_FIELD, file, file.name);
  const res = await fetch(`${STRAPI_URL}/api/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body,
    cache: "no-store",
  });

  if (res.status === 401) redirect("/sign-in?expired=1");
  if (!res.ok) throw new StrapiError(res.status, res.statusText, await res.text());

  const text = await res.text();
  return text ? (JSON.parse(text) as unknown) : undefined;
}
