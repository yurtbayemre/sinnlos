"use server";

/**
 * Self-service profile actions. Both call the CMS as the signed-in user
 * (the strapi() helper injects the session JWT):
 *
 *  - updateProfile → PUT /api/me, a whitelisted self-update route
 *    (apps/cms/src/api/profile) so users can't touch their own role.
 *  - changePassword → Strapi's built-in users-permissions endpoint;
 *    only meaningful for local-credentials accounts. Since FX40 the cms
 *    then revokes every older JWT of the user (its token version) and
 *    answers with a new one, which goes into this tab's Auth.js session
 *    (keepSessionSignedIn): this tab stays signed in, every other session
 *    of the user lands on /sign-in?expired=1 with its next cms request.
 *
 * Both answer machine codes (AC02); the forms translate them through
 * lib/auth/form-messages.ts. No Strapi message reaches the UI.
 */
import { refresh } from "next/cache";
import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { unstable_update } from "@/auth";
import { runCmsAction } from "@/lib/action-result";
import type { StrapiJwtUpdate } from "@/lib/auth/callbacks";
import { PASSWORD_MIN_LENGTH, PROFILE_TEXT_MAX } from "@/lib/auth/form-messages";
import { clientIpFrom } from "@/lib/login-rate-limit";
import { strapi } from "@/lib/strapi";

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

/** The free-text fields; the CMS rejects values over PROFILE_TEXT_MAX (FX26). */
const TEXT_FIELDS = ["displayName", "jobTitle", "phone", "officeLocation"] as const;
export type ProfileTextField = (typeof TEXT_FIELDS)[number];

/**
 * A profile save's failure: "tooLong" (a text over PROFILE_TEXT_MAX, with
 * `field`), "invalid" (the CMS refused a value, 400) or "profileSaveFailed"
 * (anything else: an outage, a refusal).
 */
export type ProfileErrorCode = "tooLong" | "invalid" | "profileSaveFailed";

export type ProfileFormState = {
  success?: "profileSaved";
  error?: ProfileErrorCode;
  /** With "tooLong": the field over the limit. */
  field?: ProfileTextField;
  /** Echoed on every error, see updateProfile. */
  values?: ProfileFormValues;
};

/**
 * A password change's failure: the local checks, then Strapi's refusal of
 * the current password (400), its throttle (429) and an outage.
 */
export type PasswordErrorCode =
  | "passwordTooShort"
  | "passwordMismatch"
  | "passwordWrongOrThrottled"
  | "passwordRateLimited"
  | "passwordChangeUnavailable";

export type PasswordFormState = { success?: "passwordChanged"; error?: PasswordErrorCode };

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
  const text = (field: ProfileTextField) => String(formData.get(field) ?? "").trim();
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

  // Same limit as the CMS, answered here with the field's name instead of
  // a generic failure.
  const tooLong = TEXT_FIELDS.find((field) => Array.from(values[field]).length > PROFILE_TEXT_MAX);
  if (tooLong) return { error: "tooLong", field: tooLong, values };

  // runCmsAction lets strapi()'s 401 redirect (NEXT_REDIRECT) escape: an
  // expired session must navigate to sign-in, not surface as a save error.
  const result = await runCmsAction(
    () =>
      strapi("/api/me", {
        method: "PUT",
        body: JSON.stringify({ data: { ...values, birthday: birthday || null } }),
      }),
    {
      label: "[profile] save",
      // Profile/people data is read uncached (D-DC01) — re-render so the
      // saved values show up immediately.
      after: () => refresh(),
    },
  );
  if (result.ok) return { success: "profileSaved" };
  // A 400 is the CMS refusing a value (FX26), not an outage.
  return { error: result.code === "invalid" ? "invalid" : "profileSaveFailed", values };
}

/**
 * Hands the Strapi JWT of a password change to this tab's Auth.js session
 * (FX40): unstable_update() runs the jwt callback with trigger "update",
 * which takes it for a local session of the same user
 * (lib/auth/callbacks.ts applyStrapiJwtUpdate) and re-issues the session
 * cookie with it through the request's cookie jar. Next then re-renders the
 * page in this same request, and strapi() there already sends the new JWT:
 * lib/strapi-token.ts reads the session from the cookie jar
 * (withJarCookies), not from the request's Cookie header, which still
 * carries the JWT the cms has just revoked. Never throws: the password did
 * change, and without the new JWT this session merely ends with its next
 * cms request (/sign-in?expired=1), like every other one of the user.
 */
async function keepSessionSignedIn(jwt: unknown): Promise<void> {
  if (typeof jwt !== "string" || jwt === "") {
    console.error(
      "[profile] change password: the cms answered without a JWT; this session ends with its next request",
    );
    return;
  }
  const update: StrapiJwtUpdate = { strapiJwt: jwt };
  try {
    await unstable_update(update as unknown as Parameters<typeof unstable_update>[0]);
  } catch (error) {
    unstable_rethrow(error);
    console.error("[profile] change password: could not store the new JWT in the session", error);
  }
}

export async function changePassword(
  _prev: PasswordFormState,
  formData: FormData,
): Promise<PasswordFormState> {
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const password = String(formData.get("password") ?? "");
  const passwordConfirmation = String(formData.get("passwordConfirmation") ?? "");
  if (password.length < PASSWORD_MIN_LENGTH) return { error: "passwordTooShort" };
  if (password !== passwordConfirmation) return { error: "passwordMismatch" };
  const clientIp = clientIpFrom(await headers());
  const result = await runCmsAction<"passwordRateLimited", { jwt?: unknown } | null>(
    () =>
      strapi<{ jwt?: unknown } | null>("/api/auth/change-password", {
        method: "POST",
        // Real client IP, like sign-in/register (FX11): the CMS trusts it
        // via server.proxy.koa. The throttle key here is path +
        // ctx.request.ip + the caller's user id (koa2-ratelimit appends it),
        // so users never shared a bucket; the header makes the IP part the
        // client's.
        headers: { "X-Forwarded-For": clientIp },
        body: JSON.stringify({ currentPassword, password, passwordConfirmation }),
      }),
    {
      label: "[profile] change password",
      // Strapi's throttle (10 attempts/min): say so instead of blaming the
      // current password (FX11).
      mapError: (cms) => (cms.status === 429 ? "passwordRateLimited" : undefined),
      // FX40: the cms revoked the session's JWT; keep this tab signed in.
      after: (answer) => keepSessionSignedIn(answer?.jwt),
    },
  );
  if (result.ok) return { success: "passwordChanged" };
  if (result.code === "passwordRateLimited") return { error: "passwordRateLimited" };
  if (result.code === "unavailable") return { error: "passwordChangeUnavailable" };
  // A wrong current password is Strapi's 400 (and so is every other
  // refusal of the request): the form's "check your current password".
  return { error: "passwordWrongOrThrottled" };
}
