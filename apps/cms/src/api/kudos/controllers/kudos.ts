import { factories } from "@strapi/strapi";

export default factories.createCoreController("api::kudos.kudos", ({ strapi }) => ({
  async create(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const body = ((ctx.request.body as any)?.data ?? ctx.request.body) as any;
    ctx.request.body = {
      data: { ...body, from: user.id },
    };
    return super.create(ctx);
  },

  async celebrations(ctx) {
    // db.query bypasses REST sanitization, so the schema-`private` fields
    // birthday/birthdayVisible are readable here. Birthdays are strictly
    // opt-in (birthdayVisible) and exposed without the year of birth.
    const users = await strapi.db.query("plugin::users-permissions.user").findMany({
      where: {
        $or: [
          { hireDate: { $notNull: true } },
          { birthday: { $notNull: true }, birthdayVisible: true },
        ],
      },
      populate: { department: true, avatar: true },
    });

    const now = new Date();
    // Compare against the LOCAL start of today, not the current instant:
    // an occurrence is materialized as a local midnight, so any time of
    // day past 00:00 would make `next < now` true ON the event day itself
    // and push it a full year out — birthdays/anniversaries would vanish
    // exactly when they happen. Against `today` the event day yields
    // daysUntil = 0 (the "today" label in the web UI).
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const windowDays = Number(ctx.query.window) || 30;
    const upcoming: any[] = [];

    // Next occurrence of a date's month/day (year ignored), or null if invalid.
    const nextOccurrence = (value: string) => {
      const parsed = new Date(value);
      if (isNaN(parsed.getTime())) return null;
      const next = new Date(today.getFullYear(), parsed.getMonth(), parsed.getDate());
      if (next < today) next.setFullYear(next.getFullYear() + 1);
      return {
        next,
        // Both operands are local midnights, so the difference is a whole
        // number of days ± a DST hour — Math.round absorbs that.
        daysUntil: Math.round((next.getTime() - today.getTime()) / 86400000),
      };
    };

    // celebrations answers via ctx.send with raw db.query rows, which BYPASS
    // the content-api output sanitizer (issue #10). So the shape here is the
    // security boundary — it must not carry any sensitive contact field.
    // `email` is deliberately omitted: a birthday/anniversary card never shows
    // it, and this endpoint is granted to the non-privileged `authenticated`
    // fallback role too, which must never read staff email (F2).
    const publicUser = (u: any) => ({
      id: u.id,
      displayName: u.displayName,
      username: u.username,
      jobTitle: u.jobTitle,
      avatar: u.avatar,
      department: u.department,
    });

    for (const u of users) {
      if (u.hireDate) {
        const occ = nextOccurrence(u.hireDate);
        if (occ && occ.daysUntil <= windowDays) {
          // No absolute `date` on purpose (F2): the anniversary occurrence date
          // combined with `years` would let a non-privileged caller (the
          // `authenticated` fallback that also holds this grant) reconstruct the
          // exact hireDate — a sensitive field the sanitizer strips everywhere
          // else. Emit only the jubilee count (integer) + a relative countdown;
          // the card renders "N years · in M days", never a hire date.
          upcoming.push({
            user: publicUser(u),
            type: "work-anniversary",
            years: occ.next.getFullYear() - new Date(u.hireDate).getFullYear(),
            daysUntil: occ.daysUntil,
          });
        }
      }

      if (u.birthday && u.birthdayVisible) {
        const occ = nextOccurrence(u.birthday);
        if (occ && occ.daysUntil <= windowDays) {
          // No `years` on purpose — the year of birth stays private.
          upcoming.push({
            user: publicUser(u),
            type: "birthday",
            date: occ.next.toISOString().split("T")[0],
            daysUntil: occ.daysUntil,
          });
        }
      }
    }

    upcoming.sort((a, b) => a.daysUntil - b.daysUntil);
    return ctx.send({ data: upcoming });
  },
}));
