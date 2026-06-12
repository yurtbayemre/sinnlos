import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { STRAPI_URL } from "@/lib/config";

/**
 * Authenticated proxy for the Strapi ICS endpoint. The events page
 * renders this as a plain <a href> — the browser sends no Authorization
 * header, and Strapi's `api::event.event.ics` action is permission-
 * gated, so a direct link to the CMS would 403. This handler attaches
 * the caller's Strapi JWT server-side and streams the file back.
 *
 * Lives under /events/[id]/ics (NOT /api/...) because the Caddy reverse
 * proxy routes /api/* straight to Strapi.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return new NextResponse("Invalid event id", { status: 400 });
  }

  const session = await auth();
  const jwt = (session as { strapiJwt?: string } | null)?.strapiJwt;
  if (!jwt) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const res = await fetch(`${STRAPI_URL}/api/events/${id}/ics`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: "no-store",
  });
  if (!res.ok) {
    return new NextResponse("Event not found", { status: res.status });
  }

  return new NextResponse(await res.text(), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition":
        res.headers.get("Content-Disposition") ??
        `attachment; filename="event-${id}.ics"`,
    },
  });
}
