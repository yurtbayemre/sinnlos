import { NextResponse, type NextRequest } from "next/server";
import { STRAPI_URL } from "@/lib/config";
import { parseEntryRef } from "@/lib/entry-id";
import { getStrapiToken } from "@/lib/session";

/**
 * Authenticated proxy for the Strapi ICS endpoint. The events page
 * renders this as a plain <a href> — the browser sends no Authorization
 * header, and Strapi's `api::event.event.ics` action is permission-
 * gated, so a direct link to the CMS would 403. This handler attaches
 * the caller's Strapi JWT server-side and streams the file back.
 *
 * `[id]` is the event's documentId (what the events page links) or, for
 * links from before 2026-09-27, the numeric id of its published row. Any
 * other value is a 404 before anything is sent to the cms, checked with the
 * same rules as the cms handler (lib/entry-id.ts, from @sinnlos/domain).
 *
 * Lives under /events/[id]/ics (NOT /api/...) because the Caddy reverse
 * proxy routes /api/* straight to Strapi.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!parseEntryRef(id)) {
    return new NextResponse("Event not found", { status: 404 });
  }

  const jwt = await getStrapiToken();
  if (!jwt) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const res = await fetch(`${STRAPI_URL}/api/events/${encodeURIComponent(id)}/ics`, {
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
        res.headers.get("Content-Disposition") ?? `attachment; filename="event-${id}.ics"`,
    },
  });
}
