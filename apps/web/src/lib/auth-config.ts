/**
 * Which sign-in methods are active, derived from env:
 *  - Microsoft: enabled iff its OAuth client env vars are present.
 *  - Local (email+password against Strapi /api/auth/local): enabled via
 *    AUTH_LOCAL_ENABLED=1, and automatically whenever Microsoft is not
 *    configured — so a fresh clone signs in with zero auth config.
 *  - Registration form: LOCAL_REGISTRATION=1 (must match the CMS env).
 */
export const MICROSOFT_ENABLED = Boolean(
  process.env.AUTH_MICROSOFT_ENTRA_ID_ID && process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
);

export const LOCAL_ENABLED =
  process.env.AUTH_LOCAL_ENABLED === "1" || !MICROSOFT_ENABLED;

export const REGISTRATION_ENABLED = LOCAL_ENABLED && process.env.LOCAL_REGISTRATION === "1";
