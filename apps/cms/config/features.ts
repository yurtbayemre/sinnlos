/**
 * Strapi feature flags (config/features).
 *
 * `useLegacyMediaLibrary`: Strapi 5.54 made the redesigned admin Media
 * Library the default. This install keeps the previous one, so the Strapi
 * 5.55.1 upgrade does not change the editors' media workflow along the way;
 * switching is a separate decision. Setting `false` (or removing the key)
 * turns the new one on. Both use the same upload service, so sizeLimit,
 * security.deniedTypes (config/plugins.ts) and the content-api hardening
 * (extensions/upload/strapi-server.ts) apply either way.
 *
 * The admin panel reads this at build time (`strapi build` bakes the
 * features config into the admin bundle): a change needs a rebuild, which
 * the Docker image does anyway.
 */
export default () => ({
  useLegacyMediaLibrary: true,
});
