/**
 * The password baseline of local accounts (v0.27, owner decision
 * 2026-10-23): at least PASSWORD_MIN_LENGTH characters, at most bcrypt's 72
 * bytes, and no password from the common-password list. The length rules
 * live here for the cms and the web forms; the list check runs in the cms
 * only (apps/cms/src/utils/password-rule.ts), so the list never reaches a
 * browser bundle. Existing shorter passwords keep working: sign-in never
 * applies the rule, only setting a password does.
 */

/** Minimum length, in characters (code points). */
export const PASSWORD_MIN_LENGTH = 12;

/** bcrypt reads at most 72 bytes; users-permissions refuses longer passwords. */
export const PASSWORD_MAX_BYTES = 72;

/** Why a password is refused; the cms answers `password_<problem>`. */
export type PasswordProblem = "tooShort" | "tooLong" | "common";

/** The length rule alone: tooShort, tooLong or null. */
export function passwordLengthProblem(password: string): "tooShort" | "tooLong" | null {
  if (Array.from(password).length < PASSWORD_MIN_LENGTH) return "tooShort";
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) return "tooLong";
  return null;
}
