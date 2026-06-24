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
