/**
 * The RSVP summary (FX21): counts, "yes" names and the caller's own answer
 * per published event, aggregated in the controller (controllers/
 * event-rsvp.ts `summary`). Granted via CUSTOM_ACTION_GRANTS in
 * src/index.ts to exactly the roles that hold event-rsvp find — never
 * guest. No route policy: the action reads through strapi.db.query and
 * returns only the aggregate, with the privacy rules of utils/rsvp.ts.
 *
 * ROUTE ORDER: Strapi registers the route files of an API in file-name
 * order (@strapi/core loaders/apis.js readdir, sorted by libuv), and the
 * first matching route wins. This file sorts before event-rsvp.ts, so
 * GET /event-rsvps/summary is matched here before the core
 * GET /event-rsvps/:id could take "summary" as an id
 * (routes.matrix.test.ts pins the order).
 */
export default {
  routes: [
    {
      method: "GET",
      path: "/event-rsvps/summary",
      handler: "api::event-rsvp.event-rsvp.summary",
      config: { policies: [] },
    },
  ],
};
