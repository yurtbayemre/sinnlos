/**
 * Pure building blocks of the session-gated /uploads byte proxy
 * (app/uploads/[...path]/route.ts, issue #21). They live here rather than in
 * route.ts because a route module may only export HTTP handlers and segment
 * config (Next type-checks route exports at build time), and the tests
 * (upload-proxy.test.ts, S06) need them. The route keeps the session check,
 * the fetch with its connect timeout, and the 304/204 body handling.
 */

/**
 * Strapi filenames are hash-based (`name_hash.ext`, thumbnails prefixed) —
 * plain [A-Za-z0-9._-] segments that never START with a dot. Anything else
 * (traversal attempts, encoded slashes, empty segments) is a 404 before we
 * ever talk to the CMS.
 */
export const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Conditional/range request headers the browser may send — pass through. */
export const FORWARD_REQUEST_HEADERS = ["range", "if-none-match", "if-modified-since"] as const;

/**
 * Upstream response headers we mirror. Hop-by-hop headers (Connection,
 * Transfer-Encoding, Keep-Alive, …) are deliberately NOT forwarded.
 */
export const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
] as const;

/**
 * Header carrying the shared INTERNAL_UPLOAD_TOKEN. Must equal the name the
 * cms uploads-auth middleware reads (apps/cms/src/middlewares/uploads-auth.ts).
 */
export const UPLOAD_TOKEN_HEADER = "x-internal-upload-token";

/** Is the catch-all `path` param a non-empty list of valid file segments? */
export function isValidUploadPath(path: unknown): path is string[] {
  return (
    Array.isArray(path) &&
    path.length > 0 &&
    path.every((segment) => typeof segment === "string" && SEGMENT_RE.test(segment))
  );
}

/** The cms URL for the validated segments (each one encoded on its own). */
export function upstreamUploadUrl(strapiUrl: string, path: readonly string[]): string {
  return `${strapiUrl}/uploads/${path.map(encodeURIComponent).join("/")}`;
}

/**
 * Headers for the request to cms: only the allowlisted browser headers, plus
 * identity encoding and — when configured — the internal upload token.
 */
export function upstreamRequestHeaders(
  incoming: Headers,
  uploadToken: string | undefined,
): Headers {
  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = incoming.get(name);
    if (value) headers.set(name, value);
  }
  // Ask for identity encoding: Node's fetch would transparently decompress
  // a compressed upstream body while we forward the original
  // Content-Length — the mismatch would truncate/hang downloads.
  headers.set("accept-encoding", "identity");

  // Second-layer proof of intent to cms (issue #21, K1): cms' uploads-auth
  // middleware serves /uploads only to callers carrying this shared token, so
  // the /api/../uploads traversal that routes around this proxy is refused.
  // Absent in local dev (gate is a no-op there); harmless to omit then.
  if (uploadToken) headers.set(UPLOAD_TOKEN_HEADER, uploadToken);
  return headers;
}

/** Headers for the response to the browser: the allowlist plus private caching. */
export function downstreamResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  // Files are content-hashed (immutable), but ACCESS is per-person now —
  // `private` keeps shared caches (and the edge) from serving bytes to the
  // next, possibly session-less, client.
  headers.set("cache-control", "private, max-age=3600");
  return headers;
}
