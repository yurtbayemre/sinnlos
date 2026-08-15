import { factories } from "@strapi/strapi";

/**
 * Reads use the core routes without a policy, but the CONTROLLER post-
 * filters them: attendance ("yes") is public inside the intranet, while
 * the user relation of maybe/no rows is stripped unless the row belongs
 * to the caller or the caller is admin_role (see stripPrivateUsers in the
 * controller) — counts stay possible, decliner names don't leak. guest is
 * additionally kept out via the bootstrap permission matrix (it reads
 * events but holds no event-rsvp grants).
 *
 * create runs the custom upsert controller (server-authoritative user +
 * published/rsvpEnabled target check + capacity gate). update stays a core
 * route but is ownership-gated (admin_role bypasses) AND sanitized in the
 * controller (only `status` is writable). delete is granted to admin_role
 * only in the matrix.
 */
export default factories.createCoreRouter("api::event-rsvp.event-rsvp", {
  config: {
    find: { policies: [] },
    findOne: { policies: [] },
    create: { policies: [] },
    update: { policies: ["global::is-event-rsvp-owner"] },
    delete: { policies: [] },
  },
});
