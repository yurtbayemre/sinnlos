import { factories } from "@strapi/strapi";

/**
 * Reads are scoped to the caller's own acknowledgements (admin_role
 * bypasses for the /manage/acknowledgements report). Create runs the
 * custom controller (server-authoritative user + duplicate/target
 * checks). No update/delete (v0.28): receipts are immutable, the web never
 * called them, and an admin update answered with another person's row past
 * the read policy. Corrections go through the Strapi admin.
 */
export default factories.createCoreRouter("api::acknowledgement.acknowledgement", {
  only: ["find", "findOne", "create"],
  config: {
    find: { policies: ["global::acknowledgement-visibility"] },
    findOne: { policies: ["global::acknowledgement-visibility"] },
    create: { policies: [] },
  },
});
