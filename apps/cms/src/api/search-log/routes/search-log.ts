import { factories } from "@strapi/strapi";

/**
 * Only `create` exists as a CRUD route: rows are write-only telemetry.
 * Nobody lists raw logs through the content API — aggregated reads go
 * through the admin-only /search-logs/summary custom route.
 */
export default factories.createCoreRouter("api::search-log.search-log", {
  only: ["create"],
  config: {
    create: { policies: [] },
  },
});
