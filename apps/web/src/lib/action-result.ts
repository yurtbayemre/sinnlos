/**
 * One result contract for the web's mutations (AC01; the shape is fixed by
 * deep-dive decision 06 §L3 for the v2 authoring actions too).
 *
 * A Server Action answers an ActionResult instead of throwing: Next masks a
 * thrown action error in production (an opaque digest, or the error page for
 * a caller without a catch), and a message string would bypass the i18n
 * rule. The component translates the code (messages/*.json); no Strapi
 * message ever reaches the UI (AC02 rule).
 *
 *   - Server side: runCmsAction(fn, { label, mapError, after, data }) wraps
 *     the strapi() call(s). It rethrows Next's control flow first
 *     (unstable_rethrow: strapi()'s redirect("/sign-in?expired=1") on a 401
 *     with a session token never becomes a result), logs the failure and
 *     maps it: the action's own mapError first (a specific code for one CMS
 *     answer), then the common mapping by status below.
 *   - Client side: startCmsAction(startTransition, steps) runs the call in a
 *     transition, applies the optimistic update first and hands the code to
 *     the component; the redirect is rethrown there too.
 *
 * Common mapping (decision 06 §L3):
 *   400 → invalid (with `fields` from details.keys/details.codes; a key
 *         without a code maps to "invalid")
 *   401 → forbidden (only reachable without a session token: with one,
 *         strapi() redirects to sign-in)
 *   403 → forbidden, 404 → notFound
 *   412 → conflict (+ `version`, the CMS's details.current)
 *   428 → failed (a web bug: If-Match missing), logged as an error
 *   429, 5xx and network errors → unavailable
 *   anything else → failed
 *
 * Imports nothing server-only: the types and startCmsAction are used by
 * client components as well.
 */
import { unstable_rethrow } from "next/navigation";
import { StrapiError } from "@/lib/strapi-error";

/** The codes every action may answer (decision 06 §L3). */
export type CommonCode =
  | "forbidden"
  | "notFound"
  | "invalid"
  | "conflict"
  | "unavailable"
  | "failed";

export type ActionResult<Code extends string = never, Data = undefined> =
  | { ok: true; data?: Data }
  | {
      ok: false;
      code: Code | CommonCode;
      /** field → code: with "invalid" (local checks or CMS details.keys/codes). */
      fields?: Readonly<Record<string, string>>;
      /** With "conflict": the CMS's details.current. */
      version?: string;
    };

/** The failure branch of an ActionResult. */
export type ActionFailure<Code extends string = never> = Extract<
  ActionResult<Code, never>,
  { ok: false }
>;

/** A failure with `code` (a local check before any request). */
export function actionFailure<Code extends string = never>(
  code: Code | CommonCode,
  extra: { fields?: Readonly<Record<string, string>>; version?: string } = {},
): ActionFailure<Code> {
  return { ok: false, code, ...extra };
}

/** What mapError sees of a refused CMS request (Strapi's error envelope). */
export interface CmsErrorInfo {
  status: number;
  /** Strapi's error.name (BadRequestError, ValidationError, PolicyError, …) or null. */
  name: string | null;
  /** Strapi's error.message or null: for mapping only, never for display. */
  message: string | null;
  /** Strapi's error.details when it is an object, or null. */
  details: Readonly<Record<string, unknown>> | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `fields` of a 400 (decision 06 §B5): every key of details.keys, with its
 * code from details.codes or "invalid", plus codes without a listed key.
 * Undefined when the CMS named no field.
 */
function fieldCodes(details: CmsErrorInfo["details"]): Record<string, string> | undefined {
  if (!details) return undefined;
  const fields: Record<string, string> = {};
  const codes = isRecord(details.codes) ? details.codes : {};
  if (Array.isArray(details.keys)) {
    for (const key of details.keys) {
      if (typeof key === "string" && key !== "") {
        fields[key] = typeof codes[key] === "string" ? codes[key] : "invalid";
      }
    }
  }
  for (const [key, code] of Object.entries(codes)) {
    if (key !== "" && typeof code === "string" && !(key in fields)) fields[key] = code;
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

/** details.current of a 412 as the opaque version string, when there is one. */
function currentVersion(details: CmsErrorInfo["details"]): string | undefined {
  const current = details?.current;
  if (typeof current === "string" && current !== "") return current;
  if (typeof current === "number" && Number.isFinite(current)) return String(current);
  return undefined;
}

/** The common mapping of a refused CMS request (see the header). */
export function commonCmsFailure(info: CmsErrorInfo): ActionFailure {
  const { status, details } = info;
  if (status === 400) {
    const fields = fieldCodes(details);
    return actionFailure("invalid", fields ? { fields } : {});
  }
  if (status === 401 || status === 403) return actionFailure("forbidden");
  if (status === 404) return actionFailure("notFound");
  if (status === 412) {
    const version = currentVersion(details);
    return actionFailure("conflict", version ? { version } : {});
  }
  if (status === 429 || status >= 500) return actionFailure("unavailable");
  return actionFailure("failed");
}

/**
 * A request that never got an answer: fetch's network failure (a
 * TypeError, "fetch failed") or an aborted/timed-out request.
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** The CMS answer of a StrapiError, as mapError sees it. */
export function cmsErrorInfo(error: StrapiError): CmsErrorInfo {
  return {
    status: error.status,
    name: error.strapiName,
    message: error.strapiMessage,
    details: error.strapiDetails,
  };
}

/**
 * The failure a caught error maps to: a StrapiError through mapError, then
 * the common mapping; a network error is "unavailable"; anything else
 * (a bug, an unparsable answer) is "failed". Never called with Next's
 * control-flow errors (runCmsAction rethrows them first).
 */
export function failureFor<Code extends string = never>(
  error: unknown,
  mapError?: (info: CmsErrorInfo) => Code | CommonCode | undefined,
): ActionFailure<Code> {
  if (error instanceof StrapiError) {
    const info = cmsErrorInfo(error);
    const specific = mapError?.(info);
    return specific ? actionFailure<Code>(specific) : commonCmsFailure(info);
  }
  return actionFailure(isNetworkError(error) ? "unavailable" : "failed");
}

export interface RunCmsActionOptions<Code extends string, T, Data> {
  /** Log prefix, e.g. "[events] rsvp". */
  label: string;
  /**
   * A specific code for one CMS answer (e.g. RSVP's capacity refusal →
   * "full"); undefined falls through to the common mapping.
   */
  mapError?: (info: CmsErrorInfo) => Code | CommonCode | undefined;
  /** Runs after a successful call, before the answer (refresh(), …). */
  after?: (value: T) => void | Promise<void>;
  /** The success data, from the CMS answer. */
  data?: (value: T) => Data;
}

/** One log line per failure: refusals as warnings, outages and bugs as errors. */
function logFailure(label: string, error: unknown, failure: ActionFailure<string>) {
  if (error instanceof StrapiError && error.status < 500 && error.status !== 428) {
    console.warn(`${label} refused: ${error.status} ${error.strapiName ?? "-"} → ${failure.code}`);
    return;
  }
  console.error(`${label} failed → ${failure.code}`, error);
}

/**
 * Runs `fn` (the strapi() call or calls of one mutation) and answers an
 * ActionResult (see the header). `after` runs only on success.
 */
export async function runCmsAction<Code extends string = never, T = unknown, Data = undefined>(
  fn: () => Promise<T>,
  options: RunCmsActionOptions<Code, T, Data>,
): Promise<ActionResult<Code, Data>> {
  let value: T;
  try {
    value = await fn();
  } catch (error) {
    // strapi()'s sign-in redirect (NEXT_REDIRECT) and Next's other
    // control-flow errors must reach Next, never become a result.
    unstable_rethrow(error);
    const failure = failureFor(error, options.mapError);
    logFailure(options.label, error, failure);
    return failure;
  }
  await options.after?.(value);
  return options.data ? { ok: true, data: options.data(value) } : { ok: true };
}

/** React's startTransition, as the client helper needs it. */
export type StartTransition = (callback: () => Promise<void>) => void;

export interface CmsActionSteps<Code extends string, Data> {
  /** Applied first, inside the transition (a useOptimistic setter must be). */
  optimistic?: () => void;
  /** The Server Action call. */
  action: () => Promise<ActionResult<Code, Data>>;
  /** After `ok: true` (the owner's refetch, …), still inside the transition. */
  onSuccess?: (data: Data | undefined) => void | Promise<void>;
  /** After `ok: false`, with the code the component translates. */
  onFailure?: (code: Code | CommonCode) => void | Promise<void>;
  /** Always, last. */
  onSettled?: () => void;
}

/**
 * The client side of the contract: runs `steps` in `startTransition`. A
 * rejected call (the web server unreachable, or an error the action did not
 * answer, which Next masks in production) or a failing onSuccess reports
 * "unavailable"; an expired session's redirect (NEXT_REDIRECT) is rethrown
 * so Next navigates to sign-in instead of the component showing an error.
 * The optimistic state of useOptimistic falls back by itself when the
 * transition ends without new props.
 */
export function startCmsAction<Code extends string, Data>(
  startTransition: StartTransition,
  steps: CmsActionSteps<Code, Data>,
): void {
  startTransition(async () => {
    try {
      steps.optimistic?.();
      const result = await steps.action();
      if (result.ok) await steps.onSuccess?.(result.data);
      else await steps.onFailure?.(result.code);
    } catch (error) {
      unstable_rethrow(error);
      await steps.onFailure?.("unavailable");
    } finally {
      steps.onSettled?.();
    }
  });
}

/**
 * The common codes with one shared text (messages: actionErrors.<code>).
 * "invalid" and "failed" get the action's own text instead: they are about
 * what the user just did ("Couldn't post your comment").
 */
export const SHARED_ERROR_CODES = ["forbidden", "notFound", "conflict", "unavailable"] as const;
export type SharedErrorCode = (typeof SHARED_ERROR_CODES)[number];

/** Whether `code` has a shared text (actionErrors.<code>). */
export function isSharedErrorCode(code: string): code is SharedErrorCode {
  return (SHARED_ERROR_CODES as readonly string[]).includes(code);
}
