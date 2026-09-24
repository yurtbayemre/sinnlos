/**
 * Request-scoped session access (D-DC01, deep-dive decisions/03-caching.md
 * §2). Every Server Component, Server Action and Route Handler reads the
 * Auth.js session through getSession(); only proxy.ts (runs outside any
 * render) and auth.ts (defines auth()) call auth() directly.
 *
 * getStrapiToken() is the ONLY place the Strapi bearer token is read —
 * strapi() and the raw multipart/ICS fetches all go through it. Since
 * D-SESSION-01 the token is no longer on the Session object (it would be
 * served by GET /api/auth/session); it is decrypted server-side from the
 * session cookie by lib/strapi-token.ts. Role and department are not on the
 * session either: lib/viewer.ts resolves them per request.
 */
import { cache } from "react";
import { auth } from "@/auth";
import { getStrapiJwt } from "@/lib/strapi-token";

/**
 * One Auth.js session decode per RSC render: React cache() memoises only
 * inside a server render. Server Actions, Route Handlers and proxy have no
 * render scope, so there every call runs auth() again — correctness must
 * never depend on the memo. The returned object is shared by every
 * component of the render: treat it as READ-ONLY.
 *
 * Nothing else may be wrapped in cache() for Strapi access: strapi() also
 * performs mutations, and response bodies must not be memoised (D-DC01 §1).
 * The one exception is getViewer() (lib/viewer.ts, D-SESSION-01): the
 * caller's own identity, read-only and render-scoped like this session.
 */
export const getSession = cache(() => auth());

/**
 * The caller's Strapi JWT, or null without a (Strapi-backed) session.
 * Gated on getSession() first: auth() runs the jwt callback, which ends a
 * session whose Strapi JWT has expired (lib/strapi-jwt.ts) — the raw cookie
 * read alone would still hand out that token.
 */
export async function getStrapiToken(): Promise<string | null> {
  if (!(await getSession())) return null;
  return getStrapiJwt();
}
