import { NextResponse, type NextRequest } from "next/server";
import { DEMO_MODE } from "@/lib/config";
import {
  isPreloadKind,
  loadPreload,
  logSearch,
  parseSearchLog,
  searchLive,
} from "@/lib/search-action";
import { getSession } from "@/lib/session";
import { getViewer } from "@/lib/viewer";

/**
 * The ⌘K palette's endpoint (WD06; logic in lib/search-action.ts, client in
 * components/search-command.tsx). Outside /api on purpose: the edge sends
 * /api/* to Strapi (docs/architecture.md §5.1). Not public in proxy.ts, so a
 * request without a session gets the proxy's redirect to /sign-in; the 401
 * below is the fallback should that matcher ever narrow.
 *
 *   GET  /search?kind=<preload kind>  the preload of one kind
 *   GET  /search?q=<term>             the live search (under 2 characters: [])
 *   POST /search {term, count}        a settled search term (telemetry), 204
 *
 * Every answer is per user (Strapi policies filter each read): no-store.
 */

const NO_STORE = { "cache-control": "no-store" };

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: NO_STORE });

async function signedIn(): Promise<boolean> {
  return DEMO_MODE || (await getSession()) !== null;
}

export async function GET(req: NextRequest) {
  if (!(await signedIn())) return json({ error: "Unauthorized" }, 401);
  const params = req.nextUrl.searchParams;

  const kind = params.get("kind");
  if (kind !== null) {
    if (!isPreloadKind(kind)) return json({ error: "Unknown kind" }, 400);
    return json({ items: await loadPreload(kind) });
  }

  const term = params.get("q");
  if (term === null) return json({ error: "Missing q or kind" }, 400);
  return json({ items: await searchLive(term, async () => (await getViewer()).role) });
}

export async function POST(req: NextRequest) {
  // Telemetry from our own page only. Browsers send Sec-Fetch-Site; the
  // Auth.js cookie is SameSite=Lax, so a cross-site POST has no session
  // anyway. Nothing here ever answers with an error the palette could show.
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return new NextResponse(null, { status: 204 });
  if (!(await signedIn())) return new NextResponse(null, { status: 401 });

  const entry = parseSearchLog(await req.json().catch(() => null));
  if (entry) await logSearch(entry.term, entry.count);
  return new NextResponse(null, { status: 204, headers: NO_STORE });
}
