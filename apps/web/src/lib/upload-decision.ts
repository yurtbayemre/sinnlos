/**
 * May this viewer open this file? (v0.34, audit finding B1.)
 *
 * Until v0.34 the /uploads proxy (app/uploads/[...path]/route.ts) served
 * every file to every signed-in account that was not blocked. Now, after
 * that account check (lib/upload-block-cache.ts), it asks the cms
 * POST /api/auth/uploads/access with the session's Strapi JWT and the
 * internal secret, and serves the bytes only on `allow`: the file follows
 * the content it belongs to (apps/cms/src/utils/upload-access.ts).
 *
 * One page shows many images, so each answer is remembered per (user id,
 * file name) for DECISION_TTL_MS (60 s), in a bounded in-process map like
 * the account status, with one request in flight per key. A change of
 * audience, an unpublish or a role change therefore reaches a file within a
 * minute. Anything but a clear answer (a 404 without the secret, a 5xx, a
 * timeout, an unreachable cms) is `unavailable`: not remembered, and the
 * route answers 503 without bytes.
 */
import { BlockStatusCache } from "@/lib/upload-block-cache";

export type UploadDecision = "allow" | "deny";
export type UploadDecisionResult = UploadDecision | "unavailable";

export const DECISION_TTL_MS = 60_000;
export const DECISION_MAX_ENTRIES = 5000;
/** How long the question may wait for the cms's answer. */
export const DECISION_TIMEOUT_MS = 10_000;

/** The header the cms reads the internal secret from (api/password-auth, api/upload-access). */
export const INTERNAL_TOKEN_HEADER = "x-internal-token";

/** The process-wide map the /uploads route uses. */
export const uploadDecisionCache = new BlockStatusCache<UploadDecision>(
  DECISION_TTL_MS,
  DECISION_MAX_ENTRIES,
);

export function accessCheckUrl(strapiUrl: string): string {
  return `${strapiUrl}/api/auth/uploads/access`;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Ask the cms once, without any cache. */
export async function probeUploadDecision(
  strapiUrl: string,
  jwt: string,
  name: string,
  internalToken: string | undefined,
  fetchImpl: Fetch = fetch,
  timeoutMs: number = DECISION_TIMEOUT_MS,
): Promise<UploadDecisionResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  };
  if (internalToken) headers[INTERNAL_TOKEN_HEADER] = internalToken;
  let res: Response;
  try {
    res = await fetchImpl(accessCheckUrl(strapiUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({ name }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return "unavailable";
  }
  // A token the cms no longer accepts, or a session that may read nothing.
  if (res.status === 401 || res.status === 403) return "deny";
  if (!res.ok) return "unavailable";
  try {
    const body: unknown = await res.json();
    const data =
      typeof body === "object" && body !== null ? (body as { data?: unknown }).data : null;
    const allow =
      typeof data === "object" && data !== null ? (data as { allow?: unknown }).allow : null;
    if (allow === true) return "allow";
    if (allow === false) return "deny";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

const inflight = new Map<string, Promise<UploadDecisionResult>>();

export interface UploadDecisionOptions {
  /** The session's Strapi user id; without one nothing is cached. */
  userId: number | undefined;
  jwt: string;
  /** The file name: the path below /uploads/. */
  name: string;
  strapiUrl: string;
  internalToken: string | undefined;
  fetchImpl?: Fetch;
  cache?: BlockStatusCache<UploadDecision>;
}

/** `allow` or `deny` from the map or from the cms (then remembered), else `unavailable`. */
export async function checkUploadDecision({
  userId,
  jwt,
  name,
  strapiUrl,
  internalToken,
  fetchImpl = fetch,
  cache = uploadDecisionCache,
}: UploadDecisionOptions): Promise<UploadDecisionResult> {
  const ask = () => probeUploadDecision(strapiUrl, jwt, name, internalToken, fetchImpl);
  if (userId === undefined) return ask();
  const cached = cache.get(userId, name);
  if (cached) return cached;

  const key = `${userId}:${name}`;
  const running = inflight.get(key);
  if (running) return running;
  // Dated by when the probe was sent, like checkUploadAccess: an answer is never older than the TTL.
  const startedAt = cache.stamp();
  const check = ask()
    .then((decision) => {
      if (decision !== "unavailable") cache.set(userId, name, decision, startedAt);
      return decision;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, check);
  return check;
}
