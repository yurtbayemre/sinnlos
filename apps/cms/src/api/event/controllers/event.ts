import { factories } from "@strapi/strapi";

import { parseEntryRef } from "../../../utils/entry-id";
import { buildIcs } from "../../../utils/ics";
import { appTimeZone } from "../../../utils/time";

export default factories.createCoreController("api::event.event", ({ strapi }) => ({
  /**
   * GET /api/events/:id/ics. `:id` is the event's documentId (what the web
   * links) or, for links from before 2026-09-27, the numeric id of its
   * published row. Anything else never reaches the query (a malformed value
   * made Postgres fail with a 500, utils/entry-id.ts) and answers the same
   * 404 as an unknown event.
   */
  async ics(ctx) {
    const ref = parseEntryRef(ctx.params.id);
    if (!ref) return ctx.notFound();

    // Published rows only (FX06): db.query spans draft AND published rows,
    // and the action is granted to every role — a draft row id or a
    // draft-only documentId must answer the same 404 as a missing one.
    const entry = await strapi.db.query("api::event.event").findOne({
      where: { ...ref, publishedAt: { $notNull: true } },
    });
    if (!entry) return ctx.notFound();

    // The file itself (UID by documentId, dates, escaping, folding, the
    // RFC 6266 file name) is built by the pure utils/ics.ts (FX12).
    const file = buildIcs(entry, { tz: appTimeZone(), now: new Date() });
    ctx.set("Content-Type", file.contentType);
    ctx.set("Content-Disposition", file.contentDisposition);
    ctx.body = file.body;
  },
}));
