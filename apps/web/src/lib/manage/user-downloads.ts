import { NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { appTimeZone } from "@/lib/app-time-zone";
import { fetchUserExport, fetchUserTrainingEvidence } from "@/lib/api/manage/users";
import { zonedDateKey } from "@/lib/plain-date";
import { capabilitiesFor } from "@/lib/roles";
import { StrapiError } from "@/lib/strapi-error";
import { evidenceCsv } from "@/lib/training-report-csv";
import { getViewer } from "@/lib/viewer";

/**
 * The two downloads of /manage/users/[id] (v0.28, admin_role only): the
 * data-subject export (Art. 15) as JSON and the person's training evidence
 * as CSV. Route handlers under /manage, not /api (the reverse proxy sends
 * /api/* straight to Strapi), with the viewer's session: the cms checks the
 * caller again and records the export in the activity log. Never cached.
 */

const NO_STORE = "private, no-store";

/** The route's id, or null for anything that is no row id. */
export function userIdOf(raw: string): number | null {
  const id = Number(raw);
  return /^[1-9]\d{0,9}$/.test(raw) && Number.isSafeInteger(id) ? id : null;
}

/** A file-name part: letters, digits, dot, dash and underscore; anything else becomes "-". */
export function fileNamePart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "");
  return safe.slice(0, 80) || "user";
}

async function refusal(id: number | null): Promise<NextResponse | null> {
  if (id === null) return new NextResponse("User not found", { status: 404 });
  if (!capabilitiesFor((await getViewer()).role).users.manage) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  return null;
}

/** A cms failure as the download's answer: its 404 stays a 404, the rest is 502. */
function failed(error: unknown): NextResponse {
  unstable_rethrow(error);
  const status = error instanceof StrapiError && error.status === 404 ? 404 : 502;
  return new NextResponse(status === 404 ? "User not found" : "Not available", {
    status,
    headers: { "Cache-Control": NO_STORE },
  });
}

const today = () => zonedDateKey(new Date(), appTimeZone());

/** GET …/export: `sinnlos-export-<username>-<date>.json`. */
export async function exportDownload(rawId: string): Promise<NextResponse> {
  const id = userIdOf(rawId);
  const refused = await refusal(id);
  if (refused) return refused;
  let data;
  try {
    data = await fetchUserExport(id as number);
  } catch (error) {
    return failed(error);
  }
  const username = typeof data.account?.username === "string" ? data.account.username : String(id);
  const name = `sinnlos-export-${fileNamePart(username)}-${today()}.json`;
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": NO_STORE,
    },
  });
}

/**
 * GET …/evidence: `sinnlos-nachweise-<id>-<date>.csv`. The evidence answer
 * names the person by display name only, so the file is named by the
 * account id (no second read for the username).
 */
export async function evidenceDownload(rawId: string): Promise<NextResponse> {
  const id = userIdOf(rawId);
  const refused = await refusal(id);
  if (refused) return refused;
  let rows;
  try {
    rows = (await fetchUserTrainingEvidence(id as number)).data.rows;
  } catch (error) {
    return failed(error);
  }
  const name = `sinnlos-nachweise-${id}-${today()}.csv`;
  return new NextResponse(evidenceCsv(rows, appTimeZone()), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": NO_STORE,
    },
  });
}
