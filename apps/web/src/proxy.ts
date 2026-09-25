/**
 * Global route guard. Unauthenticated users are redirected to /sign-in
 * except for the sign-in page itself and the Auth.js internal endpoints.
 */
import { NextResponse, type NextRequest } from "next/server";

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
    // Without this entry the CMS POST gets a 307 and live updates die
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
 * In production this guard redirects unauthenticated users to /sign-in.
 * When DEMO_MODE=1 we skip the check entirely so the UI is browsable
 * without Microsoft Entra ID configured.
 */
export default async function proxy(req: NextRequest) {
  if (process.env.DEMO_MODE === "1") return NextResponse.next();

  const { auth } = await import("@/auth");
  const session = await auth();
  const { nextUrl } = req;
  const isPublic = isPublicPath(nextUrl.pathname);

  if (!session && !isPublic) {
    const url = new URL("/sign-in", nextUrl);
    url.searchParams.set("from", nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
