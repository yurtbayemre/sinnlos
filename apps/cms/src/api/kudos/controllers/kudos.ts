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
    const users = await strapi.db.query("plugin::users-permissions.user").findMany({
      where: { hireDate: { $notNull: true } },
      populate: { department: true, avatar: true },
    });

    const now = new Date();
    const windowDays = Number(ctx.query.window) || 30;
    const upcoming: any[] = [];

    for (const u of users) {
      const hire = new Date(u.hireDate);
      if (isNaN(hire.getTime())) continue;

      const thisYearAnniversary = new Date(now.getFullYear(), hire.getMonth(), hire.getDate());
      if (thisYearAnniversary < now) {
        thisYearAnniversary.setFullYear(thisYearAnniversary.getFullYear() + 1);
      }
      const daysUntil = Math.ceil((thisYearAnniversary.getTime() - now.getTime()) / 86400000);

      if (daysUntil <= windowDays) {
        const years = thisYearAnniversary.getFullYear() - hire.getFullYear();
        upcoming.push({
          user: {
            id: u.id,
            displayName: u.displayName,
            username: u.username,
            email: u.email,
            jobTitle: u.jobTitle,
            avatar: u.avatar,
            department: u.department,
          },
          type: "work-anniversary",
          date: thisYearAnniversary.toISOString().split("T")[0],
          years,
          daysUntil,
        });
      }
    }

    upcoming.sort((a, b) => a.daysUntil - b.daysUntil);
    return ctx.send({ data: upcoming });
  },
}));
