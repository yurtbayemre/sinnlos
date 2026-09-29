/**
 * The message keys of the auth and profile form codes (AC02): the four
 * forms (sign-in, register, profile, password) translate the codes their
 * Server Actions answer through these maps, never a Strapi message.
 * Checked against the catalog's keys by the type (messages/en.json via
 * global.d.ts) and against both catalogs by form-messages.test.ts. No
 * server-only import: the forms are client components.
 */
import type { Messages } from "next-intl";
import type { RegisterErrorCode, SignInErrorCode } from "@/lib/auth-actions";
import type {
  PasswordErrorCode,
  PasswordFormState,
  ProfileErrorCode,
  ProfileFormState,
} from "@/lib/profile-actions";

/** Minimum password length of the register and change-password forms. */
export const PASSWORD_MIN_LENGTH = 6;

/**
 * Longest profile text (FX26); mirrors PROFILE_TEXT_MAX in
 * apps/cms/src/api/profile/controllers/profile.ts (varchar(255), counted in
 * characters as Postgres does).
 */
export const PROFILE_TEXT_MAX = 255;

/** Sign-in and register codes → keys of the `auth` namespace. */
export const AUTH_FORM_MESSAGES = {
  invalidCredentials: "error_invalidCredentials",
  rateLimited: "error_rateLimited",
  registrationDisabled: "error_registrationDisabled",
  missingFields: "error_missingFields",
  passwordTooShort: "error_passwordTooShort",
  emailTaken: "error_emailTaken",
  registrationFailed: "error_registrationFailed",
  accountCreatedSignInManually: "error_accountCreatedSignInManually",
} as const satisfies Record<SignInErrorCode | RegisterErrorCode, keyof Messages["auth"]>;

type ProfileCode = ProfileErrorCode | NonNullable<ProfileFormState["success"]>;
type PasswordCode = PasswordErrorCode | NonNullable<PasswordFormState["success"]>;

/** Profile and password codes → keys of the `profile` namespace. */
export const PROFILE_FORM_MESSAGES = {
  // AC02: the save's success reuses the existing profileUpdated text.
  profileSaved: "profileUpdated",
  tooLong: "error_tooLong",
  invalid: "error_invalid",
  profileSaveFailed: "error_saveFailed",
  passwordChanged: "passwordChanged",
  passwordTooShort: "passwordTooShort",
  passwordMismatch: "passwordMismatch",
  passwordWrongOrThrottled: "passwordChangeFailed",
  passwordRateLimited: "passwordRateLimited",
  passwordChangeUnavailable: "passwordChangeUnavailable",
} as const satisfies Record<ProfileCode | PasswordCode, keyof Messages["profile"]>;
