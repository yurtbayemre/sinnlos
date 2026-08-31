/**
 * Internal ingest endpoint for content-free live-event pings from the
 * CMS (apps/cms/src/utils/live-events.ts). Externally unreachable by
 * routing (Traefik's /api prefix rule swallows /api/* into the cms
 * router before the web catch-all sees it); within the frontend Docker
 * network the shared secret is the barrier. Replay of a captured emit
 * is explicitly accepted: events carry no content and only trigger
 * rate-bounded refetches (see docs/architecture.md).
 *
 * NOTE: this path must stay in proxy.ts's isPublic allowlist — the CMS
 * POST carries no session cookie, and a 307 to /sign-in here would make
 * the whole live pipeline silently dead (fire-and-forget masks it).
 */
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { getLiveBus, liveEventsDisabled, parseLiveEvents } from "@/lib/live-bus";

export const dynamic = "force-dynamic";

function secretMatches(provided: string | null, secret: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  // timingSafeEqual requires equal lengths; comparing lengths first leaks
  // only the length, which is not secret-grade information.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "REVALIDATE_SECRET is not configured" }, { status: 503 });
  }
  if (!secretMatches(req.headers.get("x-revalidate-secret"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (liveEventsDisabled()) return new NextResponse(null, { status: 204 });

  const events = parseLiveEvents(await req.json().catch(() => null));
  if (!events) return NextResponse.json({ error: "invalid events payload" }, { status: 400 });

  getLiveBus().publish(events);
  return new NextResponse(null, { status: 204 });
}
