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

    const publicUser = (u: any) => ({
      id: u.id,
      displayName: u.displayName,
      username: u.username,
      email: u.email,
      jobTitle: u.jobTitle,
      avatar: u.avatar,
      department: u.department,
    });

    for (const u of users) {
      if (u.hireDate) {
        const occ = nextOccurrence(u.hireDate);
        if (occ && occ.daysUntil <= windowDays) {
          upcoming.push({
            user: publicUser(u),
            type: "work-anniversary",
            date: occ.next.toISOString().split("T")[0],
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
