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
import { auth } from "@/auth";
import { STRAPI_URL } from "@/lib/config";

/**
 * Strapi filenames are hash-based (`name_hash.ext`, thumbnails prefixed) —
 * plain [A-Za-z0-9._-] segments that never START with a dot. Anything else
 * (traversal attempts, encoded slashes, empty segments) is a 404 before we
 * ever talk to the CMS.
 */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Conditional/range request headers the browser may send — pass through. */
const FORWARD_REQUEST_HEADERS = ["range", "if-none-match", "if-modified-since"] as const;

/**
 * Upstream response headers we mirror. Hop-by-hop headers (Connection,
 * Transfer-Encoding, Keep-Alive, …) are deliberately NOT forwarded.
 */
const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
] as const;

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  // proxy.ts already redirects anonymous browsers to /sign-in (its matcher
  // covers /uploads); this 401 is the fallback in case that matcher is ever
  // narrowed — the bytes must never depend on the middleware alone.
  const session = await auth();
  if (!session) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { path } = await params;
  if (
    !Array.isArray(path) ||
    path.length === 0 ||
    !path.every((segment) => SEGMENT_RE.test(segment))
  ) {
    return new NextResponse("Not found", { status: 404 });
  }

  const upstreamHeaders = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) upstreamHeaders.set(name, value);
  }
  // Ask for identity encoding: Node's fetch would transparently decompress
  // a compressed upstream body while we forward the original
  // Content-Length — the mismatch would truncate/hang downloads.
  upstreamHeaders.set("accept-encoding", "identity");

  // Second-layer proof of intent to cms (issue #21, K1): cms' uploads-auth
  // middleware serves /uploads only to callers carrying this shared token, so
  // the /api/../uploads traversal that routes around this proxy is refused.
  // Absent in local dev (gate is a no-op there); harmless to omit then.
  const uploadToken = process.env.INTERNAL_UPLOAD_TOKEN;
  if (uploadToken) upstreamHeaders.set("x-internal-upload-token", uploadToken);

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
    upstream = await fetch(`${STRAPI_URL}/uploads/${path.map(encodeURIComponent).join("/")}`, {
      headers: upstreamHeaders,
      cache: "no-store",
      signal: connectController.signal,
    });
  } finally {
    clearTimeout(connectTimeout);
  }

  const headers = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Files are content-hashed (immutable), but ACCESS is per-person now —
  // `private` keeps shared caches (and the edge) from serving bytes to the
  // next, possibly session-less, client.
  headers.set("cache-control", "private, max-age=3600");

  // 304/204 must not carry a body (Response would throw on a non-null one).
  if (upstream.status === 304 || upstream.status === 204) {
    return new NextResponse(null, { status: upstream.status, headers });
  }
  // Stream 200/206/404/… through without buffering.
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}
