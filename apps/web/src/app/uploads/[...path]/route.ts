/**
 * Session-gated proxy for Strapi upload bytes (issue #21).
 *
 * Until 2026-08 Traefik/Caddy routed /uploads/* straight to Strapi, whose
 * upload plugin serves the file bytes with `auth: false` — any anonymous
 * caller who knew (or guessed) a hashed filename could download company
 * documents. The edge now routes /uploads to the web catch-all, so every
 * request passes the proxy.ts auth guard (browser → /sign-in redirect) and
 * lands here, where the bytes are fetched from Strapi over the internal
 * Docker network and streamed back only to holders of an intranet session.
 *
 * Deliberately served at the ORIGINAL path: every stored media URL
 * (mediaUrl() output, old links in announcements/wiki pages, Strapi admin
 * thumbnails) keeps working without a migration. Flip side, documented in
 * docs/architecture.md §7b P1.4: the Strapi admin media library loads its
 * thumbnails as plain <img> from this path, so an admin needs a parallel
 * intranet session in the same browser to see them.
 *
 * No per-department visibility on file bytes (deliberate, see the
 * architecture record): any signed-in employee who knows a hash URL can
 * fetch the bytes. Before this route, ANYONE could.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/session";
import { STRAPI_URL } from "@/lib/config";
// Segment regex, header allowlists, identity encoding and the internal token
// header live in lib/upload-proxy.ts (unit-tested there, S06).
import {
  downstreamResponseHeaders,
  isValidUploadPath,
  upstreamRequestHeaders,
  upstreamUploadUrl,
} from "@/lib/upload-proxy";

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  // proxy.ts already redirects anonymous browsers to /sign-in (its matcher
  // covers /uploads); this 401 is the fallback in case that matcher is ever
  // narrowed — the bytes must never depend on the middleware alone.
  const session = await getSession();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { path } = await params;
  if (!isValidUploadPath(path)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const upstreamHeaders = upstreamRequestHeaders(req.headers, process.env.INTERNAL_UPLOAD_TOKEN);

  // Bounded CONNECT, unbounded STREAM (issue #21, N1): a slow client may
  // legitimately keep a large download open far longer than any fixed
  // deadline, so we time out only the wait for upstream RESPONSE HEADERS
  // (~first byte) and clear the timer the moment they arrive — the body then
  // streams without a deadline. Guards against a Slowloris upstream stall
  // (cms hung mid-handshake) tying up this route indefinitely.
  const connectController = new AbortController();
  const connectTimeout = setTimeout(() => connectController.abort(), 30_000);
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUploadUrl(STRAPI_URL, path), {
      headers: upstreamHeaders,
      cache: "no-store",
      signal: connectController.signal,
    });
  } finally {
    clearTimeout(connectTimeout);
  }

  const headers = downstreamResponseHeaders(upstream.headers);

  // 304/204 must not carry a body (Response would throw on a non-null one).
  if (upstream.status === 304 || upstream.status === 204) {
    return new NextResponse(null, { status: upstream.status, headers });
  }
  // Stream 200/206/404/… through without buffering.
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}
