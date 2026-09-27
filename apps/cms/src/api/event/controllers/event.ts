import { factories } from "@strapi/strapi";

import { parseEntryRef } from "../../../utils/entry-id";
import { icsEventDateLines } from "../../../utils/ics-dates";

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

    // The documentId, not the row id: publishing re-creates the published
    // row with a new id, and a calendar client would then import the same
    // event a second time.
    const uid = `event-${entry.documentId}@sinnlos`;

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Sinnlos//Events//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      // Timed events in UTC; all-day events as calendar days of APP_TIME_ZONE.
      ...icsEventDateLines(entry, new Date()),
      `SUMMARY:${(entry.title ?? "").replace(/[,;\\]/g, "\\$&")}`,
    ];
    if (entry.location) lines.push(`LOCATION:${entry.location.replace(/[,;\\]/g, "\\$&")}`);
    if (entry.url) lines.push(`URL:${entry.url}`);
    lines.push("END:VEVENT", "END:VCALENDAR");

    ctx.set("Content-Type", "text/calendar; charset=utf-8");
    ctx.set("Content-Disposition", `attachment; filename="${entry.title ?? "event"}.ics"`);
    ctx.body = lines.join("\r\n");
  },
}));
