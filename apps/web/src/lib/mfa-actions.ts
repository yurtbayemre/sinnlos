"use server";

/**
 * The caller's own second factor (v0.27, deep-dive v027-contract.md):
 * turn it on at /mfa/setup (also the forced step of a restricted session)
 * and off on /profile. Both answer a new Strapi JWT (the cms bumps the
 * token version), which goes into this tab's session like after a password
 * change (lib/auth/keep-session.ts). Machine codes only; the forms translate
 * them (mfa.error_<code>).
 */
import { refresh } from "next/cache";
import { runCmsAction } from "@/lib/action-result";
import { keepSessionSignedIn } from "@/lib/auth/keep-session";
import { strapi } from "@/lib/strapi";

export type MfaErrorCode =
  | "enrollmentInvalid"
  | "passwordInvalid"
  | "mfaInvalid"
  | "alreadyEnabled"
  | "notEnabled"
  | "requiredByRole"
  | "unavailable"
  | "failed";

/** The cms's details.code → the form's code. */
const CMS_CODES: Readonly<Record<string, MfaErrorCode>> = {
  enrollment_invalid: "enrollmentInvalid",
  password_invalid: "passwordInvalid",
  mfa_invalid: "mfaInvalid",
  already_enabled: "alreadyEnabled",
  mfa_not_enabled: "notEnabled",
  mfa_required_by_role: "requiredByRole",
  mfa_unavailable: "unavailable",
};

const mapError = (cms: { details: Readonly<Record<string, unknown>> | null }) => {
  const code = cms.details?.code;
  return typeof code === "string" ? CMS_CODES[code] : undefined;
};

const field = (formData: FormData, name: string) => String(formData.get(name) ?? "").slice(0, 512);

export type MfaActivateState = { recoveryCodes?: string[]; error?: MfaErrorCode };

/** Turns the second factor on with the setup page's sealed enrollment. */
export async function activateMfa(
  _prev: MfaActivateState,
  formData: FormData,
): Promise<MfaActivateState> {
  const result = await runCmsAction<
    MfaErrorCode,
    { data?: { jwt?: unknown; recoveryCodes?: unknown } },
    string[]
  >(
    () =>
      strapi("/api/me/mfa/activate", {
        method: "POST",
        body: JSON.stringify({
          enrollment: field(formData, "enrollment"),
          code: field(formData, "code").trim(),
          password: field(formData, "password"),
        }),
      }),
    {
      label: "[mfa] activate",
      mapError,
      after: (answer) => keepSessionSignedIn(answer.data?.jwt, "[mfa] activate"),
      data: (answer) =>
        Array.isArray(answer.data?.recoveryCodes)
          ? answer.data.recoveryCodes.filter((c): c is string => typeof c === "string")
          : [],
    },
  );
  if (result.ok) return { recoveryCodes: result.data ?? [] };
  return { error: isMfaCode(result.code) ? result.code : "failed" };
}

export type MfaDisableState = { success?: true; error?: MfaErrorCode };

/** Turns a voluntary second factor off (a code and the password). */
export async function disableMfa(
  _prev: MfaDisableState,
  formData: FormData,
): Promise<MfaDisableState> {
  const result = await runCmsAction<MfaErrorCode, { data?: { jwt?: unknown } }>(
    () =>
      strapi("/api/me/mfa/disable", {
        method: "POST",
        body: JSON.stringify({
          code: field(formData, "code").trim(),
          password: field(formData, "password"),
        }),
      }),
    {
      label: "[mfa] disable",
      mapError,
      after: async (answer) => {
        await keepSessionSignedIn(answer.data?.jwt, "[mfa] disable");
        refresh();
      },
    },
  );
  if (result.ok) return { success: true };
  return { error: isMfaCode(result.code) ? result.code : "failed" };
}

function isMfaCode(code: string): code is MfaErrorCode {
  return Object.values(CMS_CODES).includes(code as MfaErrorCode);
}
