import { factories } from "@strapi/strapi";

import { icsEventDateLines } from "../../../utils/ics-dates";

export default factories.createCoreController("api::event.event", ({ strapi }) => ({
  async ics(ctx) {
    // Published rows only (FX06): db.query spans draft AND published rows,
    // and the action is granted to every role — a draft row id must answer
    // the same 404 as a missing one.
    const entry = await strapi.db.query("api::event.event").findOne({
      where: { id: ctx.params.id, publishedAt: { $notNull: true } },
    });
    if (!entry) return ctx.notFound();

    const uid = `event-${entry.id}@sinnlos`;

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
