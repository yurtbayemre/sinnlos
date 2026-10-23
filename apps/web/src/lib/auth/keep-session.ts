import "server-only";
import { unstable_rethrow } from "next/navigation";
import { unstable_update } from "@/auth";
import { strapiJwtUpdate } from "@/lib/auth/callbacks";

/**
 * Hands a Strapi JWT the cms answered with to this tab's Auth.js session
 * (FX40): after a password change, and since v0.27 after a second factor
 * was turned on or off (both bump the token version and revoke the older
 * JWTs). unstable_update() runs the jwt callback with trigger "update",
 * which takes it with the server's proof (strapiJwtUpdate: an HMAC under
 * the Auth.js secret, so a browser's own POST /api/auth/session cannot
 * store a JWT it made up) for a local session of the same user
 * (lib/auth/callbacks.ts applyStrapiJwtUpdate) and re-issues the session
 * cookie with it through the request's cookie jar. Next then re-renders the
 * page in this same request, and strapi() there already sends the new JWT:
 * lib/strapi-token.ts reads the session from the cookie jar
 * (withJarCookies), not from the request's Cookie header, which still
 * carries the JWT the cms has just revoked. Never throws: the change did
 * happen, and without the new JWT this session merely ends with its next
 * cms request (/sign-in?expired=1), like every other one of the user.
 *
 * A plain server module, not a Server Action: it must not be callable from
 * a browser.
 */
export async function keepSessionSignedIn(jwt: unknown, label: string): Promise<void> {
  if (typeof jwt !== "string" || jwt === "") {
    console.error(
      `${label}: the cms answered without a JWT; this session ends with its next request`,
    );
    return;
  }
  const update = strapiJwtUpdate(jwt);
  if (!update) {
    console.error(
      `${label}: no AUTH_SECRET to sign the session update; this session ends with its next request`,
    );
    return;
  }
  try {
    await unstable_update(update as unknown as Parameters<typeof unstable_update>[0]);
  } catch (error) {
    unstable_rethrow(error);
    console.error(`${label}: could not store the new JWT in the session`, error);
  }
}
