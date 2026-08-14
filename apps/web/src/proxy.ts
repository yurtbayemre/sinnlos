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
 * In production this guard redirects unauthenticated users to /sign-in.
 * When DEMO_MODE=1 we skip the check entirely so the UI is browsable
 * without Microsoft Entra ID configured.
 */
export default async function proxy(req: NextRequest) {
  if (process.env.DEMO_MODE === "1") return NextResponse.next();

  const { auth } = await import("@/auth");
  const session = await auth();
  const { nextUrl } = req;
  const isPublic =
    nextUrl.pathname === "/sign-in" ||
    // The register page gates itself on REGISTRATION_ENABLED and redirects
    // to /sign-in when registration is off.
    nextUrl.pathname === "/register" ||
    nextUrl.pathname.startsWith("/api/auth") ||
    nextUrl.pathname === "/api/revalidate" ||
    nextUrl.pathname.startsWith("/_next") ||
    nextUrl.pathname.startsWith("/favicon") ||
    // Known static files served from /public. Exact allowlist (see
    // PUBLIC_FILES) so an authed route ending in .png/.svg/.xml can't
    // bypass the auth check.
    PUBLIC_FILES.has(nextUrl.pathname);

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
