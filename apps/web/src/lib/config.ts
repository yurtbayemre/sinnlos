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
 * the default local provider. For a relative URL we prefix the browser-facing
 * Strapi base so the asset loads from the public host.
 *
 * Note on client components: only `NEXT_PUBLIC_*` env vars are inlined into
 * the browser bundle, so `process.env.STRAPI_PUBLIC_URL` is undefined there.
 * We therefore read the raw env (not the localhost-fallback STRAPI_PUBLIC_URL
 * constant) and, when no explicit public base is configured, leave the URL
 * relative — it then resolves same-origin, which is correct in deployments
 * that serve the web app and Strapi from the same host (the current setup:
 * WEB_PUBLIC_URL === CMS_PUBLIC_URL). This avoids ever pointing a browser at
 * "http://localhost:1337".
 */
const MEDIA_BASE = process.env.STRAPI_PUBLIC_URL || "";

export function mediaUrl(url: string): string;
export function mediaUrl(url: string | null | undefined): string | null;
export function mediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http")) return url;
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
