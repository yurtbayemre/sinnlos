/**
 * Request-scoped session access (D-DC01, deep-dive decisions/03-caching.md
 * §2). Every Server Component, Server Action and Route Handler reads the
 * Auth.js session through getSession(); only proxy.ts (runs outside any
 * render) and auth.ts (defines auth()) call auth() directly.
 *
 * getStrapiToken() is the ONLY place the Strapi bearer token is read —
 * strapi() and the raw multipart/ICS fetches all go through it. A change of
 * the token source (e.g. a server-only token reader instead of
 * `session.strapiJwt`) therefore edits this file alone, never strapi().
 */
import { cache } from "react";
import { auth } from "@/auth";

/**
 * One Auth.js session decode per RSC render: React cache() memoises only
 * inside a server render. Server Actions, Route Handlers and proxy have no
 * render scope, so there every call runs auth() again — correctness must
 * never depend on the memo. The returned object is shared by every
 * component of the render: treat it as READ-ONLY.
 *
 * Nothing else may be wrapped in cache() for Strapi access: strapi() also
 * performs mutations, and response bodies must not be memoised (D-DC01 §1).
 */
export const getSession = cache(() => auth());

/** The caller's Strapi JWT, or null without a (Strapi-backed) session. */
export async function getStrapiToken(): Promise<string | null> {
  return (await getSession())?.strapiJwt ?? null;
}
