/**
 * Global route guard. Unauthenticated users are redirected to /sign-in
 * except for the sign-in page itself and the Auth.js internal endpoints.
 */
import { NextResponse, type NextRequest } from "next/server";
// A plain constants module without imports (process.env only), so it loads
// in the proxy runtime like in a render. The one DEMO_MODE source (WD08).
import { DEMO_MODE } from "@/lib/config";

/**
 * Static files that must stay reachable without a session. Kept as an
 * exact allowlist rather than an extension regex: matching on `.png`,
 * `.svg`, `.xml`, … would let any authenticated route that merely ends in
 * one of those extensions (e.g. a wiki page slug or a report id) slip past
 * the guard. `apps/web/public` currently ships only robots.txt; the rest
 * are the well-known root files browsers and crawlers probe even when
 * absent — a 404 there is preferable to a redirect to /sign-in.
 * (`favicon.ico` and `/_next/*` are already excluded by the matcher.)
 */
const PUBLIC_FILES = new Set([
  "/robots.txt",
  "/sitemap.xml",
  "/site.webmanifest",
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
  "/apple-touch-icon-precomposed.png",
]);

/**
 * The public allowlist: paths reachable without a session. Pure and exported
 * for the boundary tests (proxy.test.ts, S06). /uploads and /live/* must
 * never be listed — their bytes/streams are per-session. /api/live/emit is
 * the ONLY session-less internal endpoint; the cache-revalidation webhook
 * was removed with the Strapi fetch cache (D-DC01), so its old path is
 * guarded like any other.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/sign-in" ||
    // The register page gates itself on REGISTRATION_ENABLED and redirects
    // to /sign-in when registration is off.
    pathname === "/register" ||
    pathname.startsWith("/api/auth") ||
    // Internal CMS→web live-event ingest: session-less by design (secret-
    // gated in the route, externally swallowed by Traefik's /api rule).
    // Without this entry the CMS POST gets a redirect and live updates die
    // silently (issue #17 plan, WP2).
    pathname === "/api/live/emit" ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    // Known static files served from /public. Exact allowlist (see
    // PUBLIC_FILES) so an authed route ending in .png/.svg/.xml can't
    // bypass the auth check.
    PUBLIC_FILES.has(pathname)
  );
}

/**
 * The Auth.js session cookie under its default names, whole or chunked
 * (`.0`, `.1`, … for a large cookie): `authjs.session-token`, with the
 * `__Secure-` prefix on https (lib/strapi-token.ts usesSecureSessionCookie
 * picks between the two the same way Auth.js does; auth.ts sets no custom
 * cookie names, pinned by auth.test.ts).
 */
const SESSION_COOKIE_RE = /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/;

/**
 * Whether the request still carries an Auth.js session cookie. When auth()
 * nevertheless finds no session, that session has ENDED: the jwt callback
 * refuses a session whose Strapi JWT expired (lib/strapi-jwt.ts), and a
 * cookie AUTH_SECRET can no longer decrypt reads as none. A signed-out
 * browser has no such cookie (signOut deletes it).
 */
export function hasSessionCookie(req: NextRequest): boolean {
  return req.cookies.getAll().some(({ name }) => SESSION_COOKIE_RE.test(name));
}

/**
 * A Server Action call from Next's client: a POST with the `Next-Action`
 * header (next 16.3.4 ACTION_HEADER). A progressively enhanced form post
 * without JavaScript carries no such header; it gets the plain redirect,
 * as a 303 (signInRedirectStatus).
 */
export function isServerActionRequest(req: NextRequest): boolean {
  return req.method === "POST" && req.headers.has("next-action");
}

/**
 * The status of the plain sign-in redirect: 307 for GET and HEAD, 303 for
 * everything else. A 307 keeps the method and the body, so a form posted
 * without JavaScript (a multipart body with the `$ACTION_ID_…` fields, no
 * `Next-Action` header) would be POSTed again to /sign-in, where Next finds
 * no worker for that action and answers 500 (next 16.3.4
 * action-handler.js, the multipart non-fetch branch). A 303 makes the
 * browser follow with a GET, so it lands on the sign-in page. The other
 * POSTs to guarded paths (the /search log, /live/subscribe) are
 * fire-and-forget and ignore the answer.
 */
export function signInRedirectStatus(req: NextRequest): 303 | 307 {
  return req.method === "GET" || req.method === "HEAD" ? 307 : 303;
}

/**
 * The sign-in page for a request without a session: back to the requested
 * path afterwards (`from`), and `expired=1` (the page's "session expired"
 * notice) when the request still carried a session cookie.
 */
export function signInPath(req: NextRequest): string {
  const params = new URLSearchParams();
  if (hasSessionCookie(req)) params.set("expired", "1");
  params.set("from", req.nextUrl.pathname);
  return `/sign-in?${params.toString()}`;
}

/**
 * In production this guard redirects unauthenticated users to /sign-in.
 * When DEMO_MODE=1 we skip the check entirely so the UI is browsable
 * without Microsoft Entra ID configured.
 *
 * Order (WD08): the DEMO short-circuit first (no @/auth import at all),
 * then the public allowlist, which never costs a session decode; auth()
 * runs only for guarded paths.
 *
 * A Server Action without a session (its Strapi JWT expired while the page
 * was open) is not answered with a 307: Next's action client follows it as
 * a POST to /sign-in and fails with "An unexpected response was received
 * from the server", and the form's input is lost to the error boundary. It
 * gets the answer Next itself gives for a redirect() inside an action: a
 * 200 with `x-action-redirect: <path>;push` and no body (next 16.3.4
 * app-render/action-handler.js createRedirectRenderResult;
 * server-action-reducer.js accepts it as a redirect without Flight data and
 * navigates to it). So an expired session ends at /sign-in?expired=1 for an
 * action exactly as for a page load (proxy.test.ts). Any other request gets
 * a plain redirect: 307 for GET/HEAD, 303 for the rest, so that a form
 * posted without JavaScript is followed with a GET (signInRedirectStatus).
 */
export default async function proxy(req: NextRequest) {
  if (DEMO_MODE) return NextResponse.next();

  const { nextUrl } = req;
  if (isPublicPath(nextUrl.pathname)) return NextResponse.next();

  const { auth } = await import("@/auth");
  if (await auth()) return NextResponse.next();

  const target = signInPath(req);
  if (isServerActionRequest(req)) {
    return new NextResponse(null, {
      status: 200,
      headers: { "x-action-redirect": `${target};push`, "cache-control": "no-store" },
    });
  }
  return NextResponse.redirect(new URL(target, nextUrl), signInRedirectStatus(req));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
