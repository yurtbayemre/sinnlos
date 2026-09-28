/**
 * Global CMS-side gate on the raw upload BYTES path (issue #21, review fix K1).
 *
 * The edge fix routes `/uploads` to the web session-gate proxy, but
 * `/api|/admin|…` still route to cms as a RAW string prefix. So a request
 * like `/api/../uploads/<hash>.pdf` (or the encoded twins
 * `/api/%2e%2e/uploads/…`, `/api/..%2fuploads/…`) is routed to cms by the
 * `/api` prefix, bypassing the web proxy entirely — and cms then SERVES the
 * bytes: `strapi::public`'s koa-static route `/((?!uploads/).+)` matches the
 * still-un-normalised path (it does not start with `uploads/`) and koa-send
 * resolves the `..` back into `public/uploads`. Verified live against prod on
 * 2026-08-17: every one of those shapes returned the %PDF bytes anonymously.
 * Moving `/uploads` to web at the edge therefore does NOT close the hole.
 *
 * This middleware is the second, routing-independent layer: any request whose
 * DECODED + NORMALISED path resolves under `/uploads/` must carry the shared
 * `x-internal-upload-token` header — only the web proxy route
 * (apps/web/src/app/uploads/[...path]/route.ts) sends it. Everything else
 * gets a bare 404 (never 401, which would confirm the file exists).
 *
 * Why decode + normalise instead of `ctx.path.startsWith('/uploads/')`:
 * verified in the running cms 2026-08-17 (raw socket, `--path-as-is`
 * semantics, no client normalisation) that koa exposes `ctx.path` straight
 * from parseurl WITHOUT resolving `..`/percent escapes, yet koa-static serves
 * the traversal anyway. A raw `startsWith` check would miss EVERY traversal
 * form. We decode once (matching koa-send's single `decodeURIComponent`) and
 * posix-normalise, and also test the raw form, so `..`, `%2e%2e`, `%2f` and
 * encoded-`/uploads` variants are all caught while `/upload` (no s — the
 * media-library admin API) and `/api/upload` (marketplace POST) are not.
 * The comparison ignores case, like the router: it matches `/uploads/(.*)`
 * (and leaves it out of strapi::public's route) case-insensitively, and on a
 * case-insensitive file system koa-send finds public/uploads under any
 * casing. On the Linux images that changes nothing (`/UPLOADS/…` was a 404
 * there before, and still is).
 *
 * Invariant: it must stay a GLOBAL middleware (config/middlewares.ts). Any
 * position in that list protects: `strapi::public` registers the koa-static
 * route (and `/`) through `strapi.server.routes()` instead of returning a
 * middleware, and Strapi mounts every route, the upload plugin's
 * `/uploads/(.*)` included, after all global middlewares
 * (@strapi/core 5.55.1 middlewares/public.js and services/server/index.js
 * `mount()`, pinned in src/framework-contract.test.ts). So this gate runs
 * before each of those handlers wherever it is listed. Turning it into a
 * route middleware would lose that: it would then only guard the routes it
 * is attached to.
 */
import { timingSafeEqual } from "node:crypto";
import { posix } from "node:path";

const HEADER = "x-internal-upload-token";

/**
 * Does the request target the upload BYTES path under ANY encoding? Tests the
 * raw and the once-decoded form, each posix-normalised and lower-cased,
 * against `/uploads/`. Exported for uploads-auth.test.ts (S06).
 */
export function targetsUploads(rawPath: string): boolean {
  const forms = [rawPath];
  try {
    forms.push(decodeURIComponent(rawPath));
  } catch {
    // Malformed %-escape: keep only the raw form (koa-send would 400 anyway).
  }
  return forms.some((form) => {
    const norm = posix.normalize(form).toLowerCase();
    return norm === "/uploads" || norm.startsWith("/uploads/");
  });
}

/** Constant-time compare with a length guard (crypto.timingSafeEqual throws on
 * unequal lengths). Exported for uploads-auth.test.ts (S06). */
export function tokenMatches(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export default (_config: unknown, { strapi }: { strapi: any }) => {
  let warned = false;
  return async (ctx: any, next: () => Promise<void>) => {
    if (!targetsUploads(ctx.path || "")) {
      return next();
    }
    const expected = process.env.INTERNAL_UPLOAD_TOKEN || "";
    if (!expected) {
      // Prod MUST set the token: fail closed rather than keep the traversal
      // side channel open. In dev/standalone (single host, no Traefik
      // traversal surface) the gate is a no-op so local media and the admin
      // library still work without the secret.
      if (process.env.NODE_ENV === "production") {
        ctx.status = 404;
        return;
      }
      if (!warned) {
        warned = true;
        strapi.log.warn(
          "[uploads-auth] INTERNAL_UPLOAD_TOKEN unset — /uploads gate disabled (non-production only)",
        );
      }
      return next();
    }
    if (!tokenMatches(ctx.get(HEADER), expected)) {
      ctx.status = 404;
      return;
    }
    return next();
  };
};
