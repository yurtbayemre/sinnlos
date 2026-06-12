import { factories } from "@strapi/strapi";

export default factories.createCoreController("api::event.event", ({ strapi }) => ({
  async ics(ctx) {
    const entry = await strapi.db.query("api::event.event").findOne({
      where: { id: ctx.params.id },
    });
    if (!entry) return ctx.notFound();

    const uid = `event-${entry.id}@sinnlos`;
    const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const dtstart = new Date(entry.start).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const dtend = entry.end
      ? new Date(entry.end).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "")
      : dtstart;

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Sinnlos//Events//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${now}`,
      `DTSTART:${dtstart}`,
      `DTEND:${dtend}`,
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
