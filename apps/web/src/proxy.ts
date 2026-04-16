/**
 * Global route guard. Unauthenticated users are redirected to /sign-in
 * except for the sign-in page itself and the Auth.js internal endpoints.
 */
import { NextResponse, type NextRequest } from "next/server";

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
    nextUrl.pathname.startsWith("/api/auth") ||
    nextUrl.pathname.startsWith("/_next") ||
    nextUrl.pathname.startsWith("/favicon");

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
