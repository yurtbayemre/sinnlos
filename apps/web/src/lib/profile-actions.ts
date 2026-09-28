"use server";

/**
 * Self-service profile actions. Both call the CMS as the signed-in user
 * (the strapi() helper injects the session JWT):
 *
 *  - updateProfile → PUT /api/me, a whitelisted self-update route
 *    (apps/cms/src/api/profile) so users can't touch their own role.
 *  - changePassword → Strapi's built-in users-permissions endpoint;
 *    only meaningful for local-credentials accounts.
 */
import { refresh } from "next/cache";
import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { clientIpFrom } from "@/lib/login-rate-limit";
import { strapi } from "@/lib/strapi";
import { StrapiError } from "@/lib/strapi-error";

export type ProfileFormValues = {
  displayName: string;
  jobTitle: string;
  phone: string;
  officeLocation: string;
  birthday: string;
  birthdayVisible: boolean;
  digestAnnouncements: boolean;
  digestMentions: boolean;
  digestKudos: boolean;
  digestFrequency: "daily" | "weekly";
};
export type ProfileFormState = { error?: string; success?: string; values?: ProfileFormValues };

/** The free-text fields; the CMS rejects values over TEXT_MAX (FX26). */
const TEXT_FIELDS = ["displayName", "jobTitle", "phone", "officeLocation"] as const;
/**
 * Mirrors PROFILE_TEXT_MAX in apps/cms/src/api/profile/controllers/profile.ts
 * (varchar(255), counted in characters as Postgres does).
 */
const TEXT_MAX = 255;
/** Same minimum as the form's minLength (change-password-form.tsx). */
const PASSWORD_MIN = 6;

export async function updateProfile(
  _prev: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  // Empty date input clears the stored birthday; an unchecked checkbox is
  // absent from FormData, so map its presence ("on") to an explicit boolean.
  const birthday = String(formData.get("birthday") ?? "").trim();
  // Trimmed (FX26): the CMS trims too and stores an empty displayName as
  // null. Echoed back on error: React 19 resets the form after every
  // settled action, which silently reverted all typed changes on a
  // transient CMS failure (issue #30; classified-form pattern).
  const text = (field: (typeof TEXT_FIELDS)[number]) => String(formData.get(field) ?? "").trim();
  const values: ProfileFormValues = {
    displayName: text("displayName"),
    jobTitle: text("jobTitle"),
    phone: text("phone"),
    officeLocation: text("officeLocation"),
    birthday,
    birthdayVisible: formData.get("birthdayVisible") === "on",
    // E-mail digest opt-ins (issue #18) — checkbox presence → boolean.
    digestAnnouncements: formData.get("digestAnnouncements") === "on",
    digestMentions: formData.get("digestMentions") === "on",
    digestKudos: formData.get("digestKudos") === "on",
    digestFrequency: formData.get("digestFrequency") === "daily" ? "daily" : "weekly",
  };

  // Every message is in the viewer's language (messages/*.json, profile).
  const t = await getTranslations("profile");

  // Same limit as the CMS, answered here with the field's name instead of
  // a generic failure.
  const tooLong = TEXT_FIELDS.find((field) => Array.from(values[field]).length > TEXT_MAX);
  if (tooLong) {
    return { error: t("error_tooLong", { field: t(tooLong), max: TEXT_MAX }), values };
  }

  try {
    await strapi("/api/me", {
      method: "PUT",
      body: JSON.stringify({ data: { ...values, birthday: birthday || null } }),
    });
    // Profile/people data is read uncached (D-DC01) — re-render so the saved
    // values show up immediately.
    refresh();
    return { success: t("profileUpdated") };
  } catch (e) {
    // Don't swallow strapi()'s 401 redirect (NEXT_REDIRECT) — an expired
    // session must navigate to sign-in, not surface as a save error.
    unstable_rethrow(e);
    // A 400 is the CMS refusing a value (FX26), not an outage.
    if (e instanceof StrapiError && e.status === 400) {
      return { error: t("error_invalid"), values };
    }
    return { error: t("error_saveFailed"), values };
  }
}

export async function changePassword(
  _prev: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const password = String(formData.get("password") ?? "");
  const passwordConfirmation = String(formData.get("passwordConfirmation") ?? "");
  const t = await getTranslations("profile");
  if (password.length < PASSWORD_MIN) {
    return { error: t("passwordTooShort", { min: PASSWORD_MIN }) };
  }
  if (password !== passwordConfirmation) return { error: t("passwordMismatch") };
  try {
    await strapi("/api/auth/change-password", {
      method: "POST",
      // Real client IP, like sign-in/register (FX11): the CMS trusts it via
      // server.proxy.koa. The throttle key here is path + ctx.request.ip +
      // the caller's user id (koa2-ratelimit appends it), so users never
      // shared a bucket; the header makes the IP part the client's.
      headers: { "X-Forwarded-For": clientIpFrom(await headers()) },
      body: JSON.stringify({ currentPassword, password, passwordConfirmation }),
    });
    return { success: t("passwordChanged") };
  } catch (e) {
    // A wrong current password is a 400 and stays a friendly error; an
    // expired session is a 401 that strapi() turns into a redirect
    // (NEXT_REDIRECT) — that control-flow error must not be swallowed.
    unstable_rethrow(e);
    // Strapi's throttle (10 attempts/min): say so instead of blaming the
    // current password (FX11).
    if (e instanceof StrapiError && e.status === 429) {
      return { error: t("passwordRateLimited") };
    }
    return { error: t("passwordChangeFailed") };
  }
}
