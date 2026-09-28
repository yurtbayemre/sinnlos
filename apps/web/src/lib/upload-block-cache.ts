/**
 * Revocation for the /uploads byte proxy (roadmap FX41, owner default
 * 2026-09-28: a bounded in-process status map, 60 s TTL).
 *
 * The session gate alone (app/uploads/[...path]/route.ts, issue #21) served
 * file bytes for as long as the Auth.js session lived — up to the 7 days of
 * its embedded Strapi JWT — even after an admin blocked the account: pages
 * failed at once (strapi() gets a 401 and redirects to sign-in), the files
 * did not. Now every /uploads request also needs the session's Strapi JWT
 * to be accepted by Strapi: a no-store GET /api/users/me with that JWT.
 * users-permissions answers it with 401 for a blocked account, a deleted
 * user and an invalid or expired token alike (strategies/users-permissions
 * `authenticate`), so all of them lose the files.
 *
 * One page shows many images, so the answer is remembered per user id for
 * BLOCK_STATUS_TTL_MS (60 s): a block reaches the files within a minute.
 * What is kept is the status only (`active` | `blocked`), never a Strapi
 * response, in a plain Map in this process:
 *   - bounded: at most BLOCK_STATUS_MAX_ENTRIES users, the oldest write goes
 *     first, an expired entry is dropped when read;
 *   - bound to the JWT: an entry carries a hash of the JWT it was checked
 *     with and answers only for that JWT, so another session of the same
 *     user (a fresh sign-in after an unblock, a stale tab with an old token)
 *     is checked on its own and cannot poison or reuse the entry;
 *   - one request in flight per (user, JWT): a page's images wait for the
 *     same check instead of sending one each;
 *   - never next/cache or fetch caching (D-DC01, decisions/03-caching.md:
 *     a data-cache entry would outlive the block and be keyed per JWT).
 * Anything else (a 403, a 5xx, a timeout, cms unreachable) is `unavailable`:
 * not cached, and the route answers 503 without serving bytes.
 *
 * With several web replicas each has its own map; the bound stays one TTL.
 */
import { createHash } from "node:crypto";

export type AccountStatus = "active" | "blocked";
export type UploadAccess = AccountStatus | "unavailable";

export const BLOCK_STATUS_TTL_MS = 60_000;
export const BLOCK_STATUS_MAX_ENTRIES = 1000;
/** How long the check may wait for Strapi's answer. */
export const BLOCK_CHECK_TIMEOUT_MS = 10_000;

interface Entry {
  tag: string;
  status: AccountStatus;
  expiresAt: number;
}

/** A bounded map user id → account status of one JWT, with a TTL. */
export class BlockStatusCache {
  private readonly entries = new Map<number, Entry>();

  constructor(
    private readonly ttlMs: number = BLOCK_STATUS_TTL_MS,
    private readonly maxEntries: number = BLOCK_STATUS_MAX_ENTRIES,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The status remembered for this user AND this JWT, while it is fresh. */
  get(userId: number, tag: string): AccountStatus | undefined {
    const entry = this.entries.get(userId);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(userId);
      return undefined;
    }
    return entry.tag === tag ? entry.status : undefined;
  }

  set(userId: number, tag: string, status: AccountStatus): void {
    // Re-inserting moves the user to the end: the first key is the oldest write.
    this.entries.delete(userId);
    this.entries.set(userId, { tag, status, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** The process-wide map the /uploads route uses. */
export const uploadBlockCache = new BlockStatusCache();

/** A JWT's cache tag: its SHA-256, so the map never holds the token itself. */
export function tokenTag(jwt: string): string {
  return createHash("sha256").update(jwt).digest("hex");
}

/** The account-status probe: the caller's own profile, field-limited. */
export function userCheckUrl(strapiUrl: string): string {
  return `${strapiUrl}/api/users/me?fields[0]=blocked`;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Ask Strapi once, without any cache. */
export async function probeAccountStatus(
  strapiUrl: string,
  jwt: string,
  fetchImpl: Fetch = fetch,
  timeoutMs: number = BLOCK_CHECK_TIMEOUT_MS,
): Promise<UploadAccess> {
  let res: Response;
  try {
    res = await fetchImpl(userCheckUrl(strapiUrl), {
      headers: { Authorization: `Bearer ${jwt}` },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return "unavailable";
  }
  // Blocked, deleted, or a token Strapi no longer accepts.
  if (res.status === 401) return "blocked";
  if (!res.ok) return "unavailable";
  try {
    const me: unknown = await res.json();
    if (typeof me !== "object" || me === null) return "unavailable";
    // The strategy refuses a blocked account before this answer is built;
    // the flag is checked anyway.
    return (me as { blocked?: unknown }).blocked === true ? "blocked" : "active";
  } catch {
    return "unavailable";
  }
}

const inflight = new Map<string, Promise<UploadAccess>>();

export interface UploadAccessOptions {
  /** The session's Strapi user id; without one nothing is cached. */
  userId: number | undefined;
  jwt: string;
  strapiUrl: string;
  fetchImpl?: Fetch;
  cache?: BlockStatusCache;
}

/**
 * May the holder of this session's JWT still read /uploads? `active` or
 * `blocked` from the map or from Strapi (then remembered), `unavailable`
 * when Strapi could not say.
 */
export async function checkUploadAccess({
  userId,
  jwt,
  strapiUrl,
  fetchImpl = fetch,
  cache = uploadBlockCache,
}: UploadAccessOptions): Promise<UploadAccess> {
  if (userId === undefined) return probeAccountStatus(strapiUrl, jwt, fetchImpl);
  const tag = tokenTag(jwt);
  const cached = cache.get(userId, tag);
  if (cached) return cached;

  const key = `${userId}:${tag}`;
  const running = inflight.get(key);
  if (running) return running;
  const check = probeAccountStatus(strapiUrl, jwt, fetchImpl)
    .then((status) => {
      if (status !== "unavailable") cache.set(userId, tag, status);
      return status;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, check);
  return check;
}
