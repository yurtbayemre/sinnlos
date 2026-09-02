import { factories } from "@strapi/strapi";

/**
 * Reads are scoped to the caller's own progress rows (admin_role
 * bypasses for the /manage/training report). Create runs the custom
 * controller (server-authoritative user + duplicate/target checks,
 * acknowledgement clone). update/delete stay core routes but are only
 * granted to admin_role in the bootstrap matrix — receipts are
 * immutable evidence.
 */
export default factories.createCoreRouter("api::lesson-progress.lesson-progress", {
  config: {
    find: { policies: ["global::lesson-progress-visibility"] },
    findOne: { policies: ["global::lesson-progress-visibility"] },
    create: { policies: [] },
  },
});
