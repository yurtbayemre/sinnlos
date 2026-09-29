import { describe, expect, it } from "vitest";

import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import type { RegisterErrorCode, SignInErrorCode } from "@/lib/auth-actions";
import type { PasswordErrorCode, ProfileErrorCode } from "@/lib/profile-actions";
import { AUTH_FORM_MESSAGES, PROFILE_FORM_MESSAGES } from "./form-messages";

/**
 * Every code the auth and profile form actions answer (AC02) has its text
 * in BOTH catalogs: the maps' `satisfies Record<Code, …>` makes them
 * exhaustive over the code unions (tsc), and the lists below must name
 * every code (the Exact checks), so a new code without keys fails here and
 * not as MISSING_MESSAGE on a German page.
 */
type Catalog = Record<string, Record<string, unknown>>;

/** true when the list names exactly the union. */
type Exact<Union, List extends readonly unknown[]> = [Union] extends [List[number]]
  ? [List[number]] extends [Union]
    ? true
    : false
  : false;

const SIGN_IN_CODES = ["invalidCredentials", "rateLimited"] as const;
const REGISTER_CODES = [
  "registrationDisabled",
  "missingFields",
  "passwordTooShort",
  "rateLimited",
  "emailTaken",
  "registrationFailed",
  "accountCreatedSignInManually",
] as const;
const PROFILE_CODES = ["profileSaved", "tooLong", "invalid", "profileSaveFailed"] as const;
const PASSWORD_CODES = [
  "passwordChanged",
  "passwordTooShort",
  "passwordMismatch",
  "passwordWrongOrThrottled",
  "passwordRateLimited",
  "passwordChangeUnavailable",
] as const;

const exhaustive: [
  Exact<SignInErrorCode, typeof SIGN_IN_CODES>,
  Exact<RegisterErrorCode, typeof REGISTER_CODES>,
  Exact<ProfileErrorCode | "profileSaved", typeof PROFILE_CODES>,
  Exact<PasswordErrorCode | "passwordChanged", typeof PASSWORD_CODES>,
] = [true, true, true, true];

function text(catalog: Catalog, namespace: string, key: string): unknown {
  return catalog[namespace]?.[key];
}

describe("auth and profile form codes (AC02)", () => {
  it("lists every code of the actions", () => {
    expect(exhaustive).toEqual([true, true, true, true]);
  });

  it.each([...SIGN_IN_CODES, ...REGISTER_CODES])("auth code %s has en and de texts", (code) => {
    const key = AUTH_FORM_MESSAGES[code];
    for (const catalog of [en, de] as Catalog[]) {
      expect(text(catalog, "auth", key), key).toEqual(expect.any(String));
      expect(String(text(catalog, "auth", key)).length).toBeGreaterThan(0);
    }
  });

  it.each([...PROFILE_CODES, ...PASSWORD_CODES])("profile code %s has en and de texts", (code) => {
    const key = PROFILE_FORM_MESSAGES[code];
    for (const catalog of [en, de] as Catalog[]) {
      expect(text(catalog, "profile", key), key).toEqual(expect.any(String));
      expect(String(text(catalog, "profile", key)).length).toBeGreaterThan(0);
    }
  });

  it("reuses the existing profileUpdated text for a saved profile", () => {
    expect(PROFILE_FORM_MESSAGES.profileSaved).toBe("profileUpdated");
  });

  it("gives the messages with a limit their argument in both languages", () => {
    for (const catalog of [en, de]) {
      expect(catalog.auth.error_passwordTooShort).toContain("{min}");
      expect(catalog.profile.passwordTooShort).toContain("{min}");
      expect(catalog.profile.error_tooLong).toContain("{field}");
      expect(catalog.profile.error_tooLong).toContain("{max}");
    }
  });
});
