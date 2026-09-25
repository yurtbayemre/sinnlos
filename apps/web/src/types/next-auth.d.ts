/**
 * Module augmentation for Auth.js (NextAuth v5).
 *
 * These declarations make the Strapi-specific fields we stash on the
 * session/token/user first-class TypeScript properties, replacing the
 * `(session.user as any)` / `(session as any)` casts that used to litter
 * the codebase. The actual values are assigned in the auth callbacks
 * (see @/auth):
 *   - authorize()  → User
 *   - jwt()        → JWT
 *   - session()    → Session
 *
 * The Session is PUBLIC: GET /api/auth/session serves it to the browser.
 * It carries no Strapi JWT, role or department (D-SESSION-01) — the JWT
 * stays on the encrypted JWT (read server-side by lib/strapi-token.ts),
 * role and department come per request from getViewer() (lib/viewer.ts).
 */
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    /** Which sign-in provider issued this session ("local" | "microsoft-entra-id"). */
    provider?: string;
    // `id` is omitted from the default user before intersecting: the default
    // NextAuth user types it as `string`, but our Strapi primary key is a
    // number. Intersecting `number & string` would collapse to `never`.
    user: {
      /** Strapi user id (numeric primary key). */
      id?: number;
    } & Omit<NonNullable<DefaultSession["user"]>, "id">;
  }

  /**
   * Shape returned by the Credentials `authorize()` callback and threaded
   * into the first `jwt()` call as `user` (server-side only).
   */
  interface User {
    strapiJwt?: string;
    strapiUserId?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    strapiJwt?: string;
    strapiUserId?: number;
    /** `exp` (epoch seconds) of strapiJwt; the session ends then (lib/strapi-jwt.ts). */
    strapiJwtExp?: number;
    provider?: string;
  }
}
