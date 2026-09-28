/**
 * Request-scoped session access (D-DC01, deep-dive decisions/03-caching.md
 * §2; WD08). Every Server Component, Server Action and Route Handler reads
 * the Auth.js session through getSession(); only proxy.ts (runs outside any
 * render, and only for guarded paths) and auth.ts (defines auth()) call
 * auth() directly.
 *
 * getStrapiToken() is the ONLY place the Strapi bearer token is read —
 * strapi() and the raw multipart/ICS fetches all go through it. Since
 * D-SESSION-01 the token is no longer on the Session object (it would be
 * served by GET /api/auth/session); it is decrypted server-side from the
 * session cookie by lib/strapi-token.ts. Role and department are not on the
 * session either: lib/viewer.ts resolves them per request.
 */
import { cache } from "react";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { DEMO_MODE } from "@/lib/config";
import { getStrapiJwt } from "@/lib/strapi-token";

/**
 * The session every DEMO_MODE request gets (the demo has no sign-in): the
 * fixture's Ada Lovelace (lib/demo.ts, user id 1), the same person as
 * DEMO_VIEWER in lib/viewer.ts. The id makes the per-user reads work in
 * the preview (the notification bell, "my ads", the kudos picker without
 * the caller). No provider: the demo offers neither sign-out nor a password
 * change. Frozen: it is shared by every render.
 */
export const DEMO_SESSION: Session = Object.freeze({
  user: Object.freeze({ id: 1, name: "Ada Lovelace", email: "ada@sinnlos.local", image: null }),
  expires: "9999-12-31T23:59:59.999Z",
});

/**
 * One Auth.js session decode per RSC render: React cache() memoises only
 * inside a server render. Server Actions, Route Handlers and proxy have no
 * render scope, so there every call runs auth() again — correctness must
 * never depend on the memo. The returned object is shared by every
 * component of the render: treat it as READ-ONLY.
 *
 * DEMO_MODE answers DEMO_SESSION without reading a cookie (the only DEMO
 * branch for the session: the Topbar, the bell, the pages and the actions
 * all see the same demo user).
 *
 * Nothing else may be wrapped in cache() for Strapi access: strapi() also
 * performs mutations, and response bodies must not be memoised (D-DC01 §1).
 * The one exception is getViewer() (lib/viewer.ts, D-SESSION-01): the
 * caller's own identity, read-only and render-scoped like this session.
 */
export const getSession = cache(
  async (): Promise<Session | null> => (DEMO_MODE ? DEMO_SESSION : auth()),
);

/**
 * The caller's Strapi JWT, or null without a (Strapi-backed) session.
 * Gated on getSession() first: auth() runs the jwt callback, which ends a
 * session whose Strapi JWT has expired (lib/strapi-jwt.ts) — the raw cookie
 * read alone would still hand out that token. DEMO_MODE has no Strapi and
 * no token (strapi() answers from the fixtures before it asks).
 */
export async function getStrapiToken(): Promise<string | null> {
  if (DEMO_MODE || !(await getSession())) return null;
  return getStrapiJwt();
}
