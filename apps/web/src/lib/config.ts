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
