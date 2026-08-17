/**
 * Self-service profile endpoints. The generic users-permissions
 * `user.update` permission is deliberately NOT granted to end users —
 * it would let them change anyone's role. These routes whitelist the
 * editable fields and force the target to be the caller.
 *
 * Note on private fields: `me` reads via strapi.db.query, which bypasses
 * REST sanitization. That is deliberate — the caller sees their OWN
 * record, including schema-`private` fields (birthday, birthdayVisible)
 * that must never appear on /api/users for other people.
 *
 * The caller's OWN sensitive fields (email/phone/hireDate/...) are fine to
 * return to themselves. But `me` also populates `manager` — a DIFFERENT user —
 * and answers via ctx.send, which BYPASSES the content-api output sanitizer
 * (issue #10). So a non-privileged caller (guest / the pre-role-mapping
 * `authenticated` fallback) would otherwise read their manager's
 * email/phone/hireDate/officeLocation/microsoftOid. We reduce `safe.manager`
 * for exactly the roles the sanitizer would strip, keeping privileged callers'
 * manager contact intact (consistent with the /api/users directory). F3.
 */
import {
  USER_UID,
  shouldSanitizeForRole,
  stripSensitiveUserFields,
  type ModelSchema,
} from "../../../utils/sanitize-user-contact";

const EDITABLE_FIELDS = [
  "displayName",
  "jobTitle",
  "phone",
  "officeLocation",
  "locale",
  "birthday",
  "birthdayVisible",
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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

    // `manager` is a foreign user reached via ctx.send (sanitizer bypassed).
    // Strip its contact fields for the same roles the content-api sanitizer
    // would (guest / authenticated / unknown); privileged callers keep it.
    // department/avatar/role are populated too but are NOT user relations
    // (department scalars, a media file, the role row), so they carry no
    // foreign staff contact data and are left untouched.
    if (safe.manager && shouldSanitizeForRole(user.role?.type)) {
      const getModel = (uid: string): ModelSchema | undefined => (strapi as any).getModel(uid);
      stripSensitiveUserFields(safe.manager, getModel(USER_UID), { getModel });
    }

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

    // Normalize the birthday fields: empty string clears the date, anything
    // else must be a plain ISO date; the visibility flag is coerced to boolean
    // so form-encoded values ("on"/"true") behave predictably.
    if ("birthday" in data) {
      if (data.birthday === "" || data.birthday === null) {
        data.birthday = null;
      } else if (typeof data.birthday !== "string" || !ISO_DATE.test(data.birthday)) {
        return ctx.badRequest("birthday must be a YYYY-MM-DD date or null");
      } else {
        // The regex alone accepts impossible calendar dates (2026-02-31),
        // which Postgres rejects with a 500 at insert time. Roundtrip
        // through Date: ISO date-only strings parse as UTC midnight, so a
        // real date survives toISOString() unchanged, while an overflowing
        // one normalizes to a different day (2026-02-31 → 2026-03-03) and
        // an impossible month/day yields Invalid Date.
        const parsed = new Date(data.birthday);
        if (isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== data.birthday) {
          return ctx.badRequest("birthday must be a valid calendar date");
        }
      }
    }
    if ("birthdayVisible" in data) {
      data.birthdayVisible =
        data.birthdayVisible === true || data.birthdayVisible === "true" || data.birthdayVisible === "on";
    }

    await strapi.db.query("plugin::users-permissions.user").update({
      where: { id: user.id },
      data,
    });

    // No `manager` populate here (unlike `me`), and role/department/avatar are
    // not user relations — so `safe` is the caller's OWN record only and needs
    // no foreign-user stripping (F3 audit).
    const refreshed = await strapi.db.query("plugin::users-permissions.user").findOne({
      where: { id: user.id },
      populate: { role: true, department: true, avatar: true },
    });
    const { password, resetPasswordToken, confirmationToken, ...safe } = refreshed;
    return ctx.send({ data: safe });
  },
};
