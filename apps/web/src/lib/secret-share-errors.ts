/**
 * The error wrapper of the secret-share Server Actions (v0.35, plan §3.10).
 *
 * runCmsAction (lib/action-result.ts) logs the caught error itself, and a
 * StrapiError carries the upstream body in its message; a malformed success
 * answer puts response text into a JSON.parse error. Neither may reach a log
 * line here (the reveal answer holds the secret), so this wrapper maps every
 * failure to a fixed code and logs only the status and that code. Next's
 * control-flow errors (the sign-in redirect, notFound) pass through first.
 *
 * The codes are the refusals of @sinnlos/domain SECRET_SHARE_REFUSALS, found
 * by status AND `details.code` (`unavailable` has three causes with three
 * statuses), or the common codes of action-result.ts.
 */
import { unstable_rethrow } from "next/navigation";
import { SECRET_SHARE_REFUSALS, type SecretShareRefusal } from "@sinnlos/domain";
import {
  actionFailure,
  cmsErrorInfo,
  commonCmsFailure,
  isNetworkError,
  type ActionResult,
  type CommonCode,
} from "@/lib/action-result";
import { StrapiError } from "@/lib/strapi-error";

export type SecretCode = SecretShareRefusal | CommonCode;

const REFUSALS = Object.entries(SECRET_SHARE_REFUSALS) as [
  SecretShareRefusal,
  { status: number; code: string },
][];

/** The code of a caught failure (never a control-flow error). */
export function secretFailureCode(error: unknown): SecretCode {
  if (error instanceof StrapiError) {
    const code = error.strapiDetails?.code;
    const refusal = REFUSALS.find(([, r]) => r.status === error.status && r.code === code);
    return refusal ? refusal[0] : commonCmsFailure(cmsErrorInfo(error)).code;
  }
  return isNetworkError(error) ? "unavailable" : "failed";
}

/**
 * Runs one cms call of a secret-share action and answers an ActionResult;
 * `data` builds the success data and may throw on a malformed answer.
 */
export async function runSecretAction<T, Data>(
  label: string,
  fn: () => Promise<T>,
  data: (value: T) => Data,
): Promise<ActionResult<SecretShareRefusal, Data>> {
  try {
    return { ok: true, data: data(await fn()) };
  } catch (error) {
    unstable_rethrow(error);
    const code = secretFailureCode(error);
    const status = error instanceof StrapiError ? error.status : "-";
    console.warn(`[secrets] ${label} failed: ${status} → ${code}`);
    return actionFailure(code);
  }
}
