import { factories } from "@strapi/strapi";

import { parseWindowDays, planCelebrations } from "../../../utils/celebrations";
import { isRowId } from "../../../utils/entry-id";
import { todayIn } from "../../../utils/time";

export default factories.createCoreController("api::kudos.kudos", ({ strapi }) => ({
  /**
   * `from` is always the caller (§5.21). `to` must be a user's row id (an
   * integer, which is what the web's sendKudos sends) and not the caller
   * (FX27): a missing `to` created kudos for nobody, and kudos to oneself
   * were stored and listed.
   */
  async create(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const body = ((ctx.request.body as any)?.data ?? ctx.request.body) as any;
    const to: unknown = body?.to;
    if (!isRowId(to)) return ctx.badRequest("to must be a user id");
    if (to === user.id) return ctx.badRequest("Kudos cannot be sent to yourself");
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

    // celebrations answers via ctx.send with raw db.query rows, which BYPASS
    // the content-api output sanitizer (issue #10). The planner builds every
    // card from an allowlist (no email, no hire or anniversary date, no birth
    // year; F2), in calendar dates of APP_TIME_ZONE (utils/celebrations.ts).
    const data = planCelebrations(users, todayIn(), parseWindowDays(ctx.query.window));
    return ctx.send({ data });
  },
}));
