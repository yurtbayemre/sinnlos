/**
 * Single source of truth for runtime configuration that was previously
 * duplicated across modules.
 */

/** Internal URL the server uses to reach Strapi (Docker service name in prod). */
export const STRAPI_URL = process.env.STRAPI_URL || "http://localhost:1337";

/** Browser-facing Strapi URL (admin links, uploaded media). */
export const STRAPI_PUBLIC_URL =
  process.env.STRAPI_PUBLIC_URL || process.env.STRAPI_URL || "http://localhost:1337";

export const DEMO_MODE = process.env.DEMO_MODE === "1";

/**
 * Resolve a Strapi media URL.
 *
 * Strapi returns upload URLs that are absolute when an external provider
 * (e.g. S3) is configured, but relative (e.g. "/uploads/avatar.png") for
 * the default local provider.
 *
 * A local-provider path (`/uploads/...`) stays RELATIVE (WD10): the web
 * serves /uploads itself, through the session-gated proxy
 * (app/uploads/[...path]/route.ts, architecture §7b P1.4), so the browser
 * must load it from the web origin with the session cookie. Prefixing the
 * CMS public URL was right only while both hosts coincided; with a separate
 * CMS host the images would bypass the proxy and fail.
 *
 * Any other relative URL still gets the browser-facing Strapi base. Only
 * `NEXT_PUBLIC_*` env vars are inlined into the browser bundle, so
 * `process.env.STRAPI_PUBLIC_URL` is undefined in client components; we read
 * the raw env (not the localhost-fallback STRAPI_PUBLIC_URL constant), so
 * without an explicit public base such a URL stays relative too and a
 * browser is never pointed at "http://localhost:1337".
 */
const MEDIA_BASE = process.env.STRAPI_PUBLIC_URL || "";

export function mediaUrl(url: string): string;
export function mediaUrl(url: string | null | undefined): string | null;
export function mediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  if (url.startsWith("/uploads/")) return url;
  return `${MEDIA_BASE}${url}`;
}

/**
 * Smallest usable rendition of an avatar upload (issue #30): profile
 * photos are shown in 40–64px circles, but the type used to model only
 * the original `url` — a phone photo (3–8 MB) was delivered N× through
 * the auth-gated /uploads proxy (JWT decode + internal fetch per image).
 * Strapi generates `formats` for every image upload; prefer thumbnail
 * (156px box), then small, then the original as last resort.
 */
export function avatarThumbUrl(
  avatar:
    | {
        url?: string;
        formats?: { thumbnail?: { url?: string }; small?: { url?: string } } | null;
      }
    | null
    | undefined,
): string | null {
  if (!avatar) return null;
  return mediaUrl(avatar.formats?.thumbnail?.url ?? avatar.formats?.small?.url ?? avatar.url);
}
