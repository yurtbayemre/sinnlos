/**
 * The password baseline of local accounts (v0.27): the length rule of
 * @sinnlos/domain plus the common-password list, which only the cms holds.
 * Every place that sets a password applies it (the user write guard, the
 * users-permissions validatePassword rule, POST /api/auth/password/set);
 * sign-in never does, so existing shorter passwords keep working.
 */
import { passwordLengthProblem, type PasswordProblem } from "@sinnlos/domain";

import { COMMON_PASSWORDS } from "./common-passwords";

export function passwordProblem(password: string): PasswordProblem | null {
  const length = passwordLengthProblem(password);
  if (length) return length;
  const lower = password.toLowerCase();
  // A single repeated character ("aaaaaaaaaaaa") is as common as the list.
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1*$/u.test(lower)) return "common";
  return null;
}
