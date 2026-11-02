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
 *
 * A mutation (create, reveal, revoke) whose outcome is unknown answers
 * `busy`, like the cms's own: a lost or cut answer (network, timeout), a 5xx
 * without a refusal code and a malformed success may all follow a committed
 * write, so "try again" could send a second share or meet a consumed one.
 * The same holds when the browser loses the Server Action call itself
 * (`settleSecretCall`).
 */
import { unstable_rethrow } from "next/navigation";
import { SECRET_SHARE_REFUSALS, type SecretShareRefusal } from "@sinnlos/domain";
import {
  actionFailure,
  cmsErrorInfo,
  commonCmsFailure,
  isNetworkError,
  type ActionFailure,
  type ActionResult,
  type CommonCode,
} from "@/lib/action-result";
import { StrapiError } from "@/lib/strapi-error";

export type SecretCode = SecretShareRefusal | CommonCode;

const REFUSALS = Object.entries(SECRET_SHARE_REFUSALS) as [
  SecretShareRefusal,
  { status: number; code: string },
][];

/** The code of a caught failure (never a control-flow error); see the header for `mutation`. */
export function secretFailureCode(error: unknown, mutation = false): SecretCode {
  if (error instanceof StrapiError) {
    const code = error.strapiDetails?.code;
    const refusal = REFUSALS.find(([, r]) => r.status === error.status && r.code === code);
    if (refusal) return refusal[0];
    return mutation && error.status >= 500 ? "busy" : commonCmsFailure(cmsErrorInfo(error)).code;
  }
  if (mutation) return "busy";
  return isNetworkError(error) ? "unavailable" : "failed";
}

/**
 * A Server Action call of a mutation from the browser: when the call itself
 * fails (the web unreachable, the answer lost), its outcome is unknown.
 * The sign-in redirect still reaches Next.
 */
export function settleSecretCall<R>(
  call: Promise<R>,
): Promise<R | ActionFailure<SecretShareRefusal>> {
  return call.catch((error: unknown) => {
    unstable_rethrow(error);
    return actionFailure<SecretShareRefusal>("busy");
  });
}

/**
 * Runs one cms call of a secret-share action and answers an ActionResult;
 * `data` builds the success data and may throw on a malformed answer.
 */
export async function runSecretAction<T, Data>(
  label: string,
  fn: () => Promise<T>,
  data: (value: T) => Data,
  mutation = true,
): Promise<ActionResult<SecretShareRefusal, Data>> {
  try {
    return { ok: true, data: data(await fn()) };
  } catch (error) {
    unstable_rethrow(error);
    const code = secretFailureCode(error, mutation);
    const status = error instanceof StrapiError ? error.status : "-";
    console.warn(`[secrets] ${label} failed: ${status} → ${code}`);
    return actionFailure(code);
  }
}
