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
import { unstable_rethrow } from "next/navigation";
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
export type ProfileFormState = { error?: string; success?: string; values?: ProfileFormValues };

export async function updateProfile(
  _prev: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  // Empty date input clears the stored birthday; an unchecked checkbox is
  // absent from FormData, so map its presence ("on") to an explicit boolean.
  const birthday = String(formData.get("birthday") ?? "").trim();
  // Echoed back on error: React 19 resets the form after every settled
  // action, which silently reverted all typed changes on a transient CMS
  // failure (issue #30; classified-form pattern).
  const values: ProfileFormValues = {
    displayName: String(formData.get("displayName") ?? ""),
    jobTitle: String(formData.get("jobTitle") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    officeLocation: String(formData.get("officeLocation") ?? ""),
    birthday,
    birthdayVisible: formData.get("birthdayVisible") === "on",
    digestAnnouncements: formData.get("digestAnnouncements") === "on",
    digestMentions: formData.get("digestMentions") === "on",
    digestKudos: formData.get("digestKudos") === "on",
    digestFrequency: formData.get("digestFrequency") === "daily" ? "daily" : "weekly",
  };
  try {
    await strapi("/api/me", {
      method: "PUT",
      body: JSON.stringify({
        data: {
          displayName: formData.get("displayName"),
          jobTitle: formData.get("jobTitle"),
          phone: formData.get("phone"),
          officeLocation: formData.get("officeLocation"),
          birthday: birthday || null,
          birthdayVisible: formData.get("birthdayVisible") === "on",
          // E-mail digest opt-ins (issue #18) — checkbox presence → boolean.
          digestAnnouncements: formData.get("digestAnnouncements") === "on",
          digestMentions: formData.get("digestMentions") === "on",
          digestKudos: formData.get("digestKudos") === "on",
          digestFrequency: formData.get("digestFrequency") === "daily" ? "daily" : "weekly",
        },
      }),
      noCache: true,
    });
    // Profile/people data is fetched with noCache — re-render so the saved
    // values show up immediately.
    refresh();
    return { success: "Profile updated." };
  } catch (e) {
    // Don't swallow strapi()'s 401 redirect (NEXT_REDIRECT) — an expired
    // session must navigate to sign-in, not surface as a save error.
    unstable_rethrow(e);
    return { error: "Could not save profile.", values };
  }
}

export async function changePassword(
  _prev: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const password = String(formData.get("password") ?? "");
  const passwordConfirmation = String(formData.get("passwordConfirmation") ?? "");
  if (password.length < 6) return { error: "New password needs at least 6 characters." };
  if (password !== passwordConfirmation) return { error: "Passwords do not match." };
  try {
    await strapi("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, password, passwordConfirmation }),
      noCache: true,
    });
    return { success: "Password changed." };
  } catch (e) {
    // A wrong current password is a 400 and stays a friendly error; an
    // expired session is a 401 that strapi() turns into a redirect
    // (NEXT_REDIRECT) — that control-flow error must not be swallowed.
    unstable_rethrow(e);
    return { error: "Could not change password — check your current password." };
  }
}
