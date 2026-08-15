import { factories } from "@strapi/strapi";

/**
 * Reads are scoped to the caller's own acknowledgements (admin_role
 * bypasses for the /manage/acknowledgements report). Create runs the
 * custom controller (server-authoritative user + duplicate/target
 * checks). update/delete stay core routes but are only granted to
 * admin_role in the bootstrap permission matrix.
 */
export default factories.createCoreRouter("api::acknowledgement.acknowledgement", {
  config: {
    find: { policies: ["global::acknowledgement-visibility"] },
    findOne: { policies: ["global::acknowledgement-visibility"] },
    create: { policies: [] },
  },
});
