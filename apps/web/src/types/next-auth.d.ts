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
 */
import type { DefaultSession } from "next-auth";

/** Department shape carried on the session/token (a subset of the Strapi entity). */
interface SessionDepartment {
  id: number;
  name: string;
  slug: string;
}

declare module "next-auth" {
  interface Session {
    /** Strapi JWT used to authenticate every server-side Strapi fetch. */
    strapiJwt?: string;
    /** Which sign-in provider issued this session ("local" | "microsoft-entra-id"). */
    provider?: string;
    // `id` is omitted from the default user before intersecting: the default
    // NextAuth user types it as `string`, but our Strapi primary key is a
    // number. Intersecting `number & string` would collapse to `never`.
    user: {
      /** Strapi user id (numeric primary key). */
      id?: number;
      /** Strapi role type (e.g. "authenticated", "admin"). */
      role?: string;
      department?: SessionDepartment | null;
    } & Omit<NonNullable<DefaultSession["user"]>, "id">;
  }

  /**
   * Shape returned by the Credentials `authorize()` callback and threaded
   * into the first `jwt()` call as `user`.
   */
  interface User {
    strapiJwt?: string;
    strapiUserId?: number;
    strapiRole?: string;
    strapiDepartment?: SessionDepartment | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    strapiJwt?: string;
    strapiUserId?: number;
    strapiRole?: string;
    strapiDepartment?: SessionDepartment | null;
    provider?: string;
  }
}
