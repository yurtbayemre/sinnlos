import { factories } from "@strapi/strapi";

/**
 * Reads are scoped to the caller's own progress rows (admin_role
 * bypasses for the /manage/training report). Create runs the custom
 * controller (server-authoritative user + duplicate/target checks,
 * acknowledgement clone). There are no update/delete routes (FX01) —
 * receipts are immutable evidence; corrections happen in the Strapi
 * admin panel.
 */
export default factories.createCoreRouter("api::lesson-progress.lesson-progress", {
  only: ["find", "findOne", "create"],
  config: {
    find: { policies: ["global::lesson-progress-visibility"] },
    findOne: { policies: ["global::lesson-progress-visibility"] },
    create: { policies: [] },
  },
});
