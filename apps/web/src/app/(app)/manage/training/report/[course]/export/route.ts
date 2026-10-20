import { NextResponse, type NextRequest } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { appTimeZone } from "@/lib/app-time-zone";
import { courseTrainingReport } from "@/lib/api/training";
import { isDocumentId } from "@/lib/entry-id";
import { zonedDateKey } from "@/lib/plain-date";
import { capabilitiesFor } from "@/lib/roles";
import { StrapiError } from "@/lib/strapi-error";
import { receiptsCsv, statusCsv } from "@/lib/training-report-csv";
import { getViewer } from "@/lib/viewer";

/**
 * The CSV downloads of one course of the named training report (v0.20):
 * ?kind=status (one row per person) or ?kind=receipts (the proof history,
 * one row per receipt). The same cms read as the page, with the viewer's
 * session, so the cms scopes it the same way (404 outside the caller's
 * department). Lives under /manage, not /api: the reverse proxy sends
 * /api/* straight to Strapi.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ course: string }> },
) {
  const { course } = await params;
  const kind = request.nextUrl.searchParams.get("kind");
  if (kind !== "status" && kind !== "receipts") {
    return new NextResponse("Unknown export", { status: 400 });
  }
  if (!isDocumentId(course)) return new NextResponse("Course not found", { status: 404 });
  if (!capabilitiesFor((await getViewer()).role).reports.training) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  let report;
  try {
    report = (await courseTrainingReport(course)).data;
  } catch (error) {
    unstable_rethrow(error);
    const status = error instanceof StrapiError ? error.status : 502;
    return new NextResponse("Report not available", { status: status === 404 ? 404 : 502 });
  }

  const zone = appTimeZone();
  const csv = kind === "status" ? statusCsv(report, zone) : receiptsCsv(report, zone);
  const name = `unterweisung-${report.course.slug}-${kind === "status" ? "status" : "nachweis"}-${zonedDateKey(new Date(), zone)}.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
