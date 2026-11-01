import { handlers } from "@/auth";

/**
 * v0.34 (A-02): Auth.js's own sign-out endpoint (/api/auth/signout, GET
 * shows a form, POST clears the cookie) answers 404. It would clear this
 * browser's cookie without ending the account's sessions on the cms, so a
 * copied cookie would outlive it. The app signs out through signOutAction
 * (lib/auth-actions.ts) only, whose server signOut() calls Auth.js directly,
 * never this route. Matched on the decoded, lower-cased path with repeated
 * slashes collapsed, so every spelling that could reach Auth.js's signout
 * action (a trailing slash, an extra segment) is caught, and more.
 */
export function isSignOutPath(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  const forms = [pathname];
  try {
    forms.push(decodeURIComponent(pathname));
  } catch {
    // A malformed escape: the raw form only.
  }
  return forms.some((form) => {
    const path = form.replace(/\/+/g, "/").toLowerCase();
    if (!path.startsWith("/api/auth/")) return false;
    return path.slice("/api/auth/".length).split("/")[0] === "signout";
  });
}

const notFound = () => new Response("Not found", { status: 404 });

export const GET: typeof handlers.GET = (req) =>
  isSignOutPath(req.url) ? Promise.resolve(notFound()) : handlers.GET(req);

export const POST: typeof handlers.POST = (req) =>
  isSignOutPath(req.url) ? Promise.resolve(notFound()) : handlers.POST(req);
