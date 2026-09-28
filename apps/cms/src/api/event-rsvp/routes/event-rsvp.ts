import { factories } from "@strapi/strapi";

/**
 * Raw reads return the CALLER's own rows only (FX21): the
 * `global::event-rsvp-own-rows` policy narrows find/findOne to
 * `user = caller` (admin_role bypasses) and refuses a client filter on the
 * user relation; the controller refuses the Strapi-Response-Format header
 * for non-admins and still strips other people's maybe/no users as a
 * backstop. Who else answered what is served only aggregated, by
 * GET /api/event-rsvps/summary (custom-event-rsvp.ts: counts, "yes" names,
 * the caller's own answer — decliner names never leave the CMS). guest is
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
    find: { policies: ["global::event-rsvp-own-rows"] },
    findOne: { policies: ["global::event-rsvp-own-rows"] },
    create: { policies: [] },
    update: { policies: ["global::is-event-rsvp-owner"] },
    delete: { policies: [] },
  },
});
