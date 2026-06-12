/**
 * Self-service profile endpoints. The generic users-permissions
 * `user.update` permission is deliberately NOT granted to end users —
 * it would let them change anyone's role. These routes whitelist the
 * editable fields and force the target to be the caller.
 */
const EDITABLE_FIELDS = ["displayName", "jobTitle", "phone", "officeLocation", "locale"] as const;

export default {
  async me(ctx: any) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const full = await strapi.db.query("plugin::users-permissions.user").findOne({
      where: { id: user.id },
      populate: { role: true, department: true, avatar: true, manager: true },
    });
    if (!full) return ctx.notFound();

    const { password, resetPasswordToken, confirmationToken, ...safe } = full;
    return ctx.send({ data: safe });
  },

  async updateMe(ctx: any) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const body = ((ctx.request.body as any)?.data ?? ctx.request.body) as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    for (const field of EDITABLE_FIELDS) {
      if (field in body) data[field] = body[field];
    }
    if (Object.keys(data).length === 0) return ctx.badRequest("No editable fields provided");

    await strapi.db.query("plugin::users-permissions.user").update({
      where: { id: user.id },
      data,
    });

    const refreshed = await strapi.db.query("plugin::users-permissions.user").findOne({
      where: { id: user.id },
      populate: { role: true, department: true, avatar: true },
    });
    const { password, resetPasswordToken, confirmationToken, ...safe } = refreshed;
    return ctx.send({ data: safe });
  },
};
