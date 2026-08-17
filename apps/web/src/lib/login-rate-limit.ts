/**
 * In-memory sliding-window rate limiter for the password login (issue #23).
 *
 * Why in the app and not (only) at the edge: the credentials login runs as
 * a Server Action POST — Server Action requests are not path-bound — and
 * Auth.js additionally exposes POST /api/auth/callback/local, which calls
 * authorize() directly (the CSRF token is fetchable from /api/auth/csrf,
 * trivially scriptable). A limiter on any outer route alone is therefore
 * bypassable; the authoritative gate sits in authorize() (see @/auth), with
 * the Traefik router limit (infra/docker-compose.traefik.yml) as a coarse
 * pre-filter only.
 *
 * Two dimensions, both counting FAILURES only — an office NAT produces many
 * legitimate logins from one IP and those must never throttle anyone:
 *  - per client IP: fast brute force from a single host,
 *  - per identifier (case-insensitive) across ALL IPs: distributed guessing
 *    against one account; a successful login resets this bucket.
 *
 * The store is process-local and resets on container restart — accepted and
 * fine: an attacker cannot trigger restarts, and a few forgotten failure
 * counts are harmless. The standalone web container runs a single Node
 * process, but that alone does NOT give us one store: Turbopack compiles
 * consumers of this module into separate layer chunks with their own module
 * registries (the Server-Action layer vs. the /api/auth route layer), so a
 * plain module-scope singleton exists once PER layer with disjoint buckets.
 * The shared instance at the bottom is therefore pinned on globalThis — the
 * one registry every chunk in the process sees. Expired timestamps are
 * pruned on access, and each map carries a hard key cap with
 * least-recently-touched eviction (skipping actively blocked buckets, see
 * evictOne) so a stream of random identifiers cannot grow the store without
 * bound (the limiter must not be a memory-DoS vector itself).
 *
 * Pure logic, no I/O; the clock is injected per call (`now` parameter,
 * default Date.now) so the tests need no fake timers. Unit tested in
 * `login-rate-limit.test.ts`.
 */

/** Window for the per-IP dimension. */
export const IP_WINDOW_MS = 60_000;
/** Failures per IP within {@link IP_WINDOW_MS} before the IP is blocked. */
export const IP_MAX_FAILURES = 10;
/** Window for the per-identifier dimension (longer: guards one account). */
export const IDENTIFIER_WINDOW_MS = 15 * 60_000;
/** Failures per identifier within {@link IDENTIFIER_WINDOW_MS} before lockout. */
export const IDENTIFIER_MAX_FAILURES = 10;
/** Hard cap per dimension; beyond it the least-recently-touched bucket goes. */
export const MAX_TRACKED_KEYS = 10_000;
/** How many head-of-map buckets eviction probes for a non-blocked victim. */
export const EVICTION_SCAN_LIMIT = 100;

/** The limiter consulted by authorize() — see createLoginRateLimiter. */
export interface LoginRateLimiter {
  /** Read-only check (never counts as an attempt). */
  isBlocked(ip: string, identifier: string, now?: number): boolean;
  /**
   * Count one FAILED verification against both dimensions. Returns true
   * only when THIS failure tips a bucket into the block state — callers
   * log that transition (once per lock window), not every rejected
   * follow-up attempt, so a scripted flood cannot spam the log.
   */
  recordFailure(ip: string, identifier: string, now?: number): boolean;
  /** Successful login: clear the identifier bucket (the IP bucket stays). */
  recordSuccess(identifier: string): void;
  /** Total tracked buckets across both dimensions — pins the cap in tests. */
  size(): number;
}

/**
 * One account = one bucket: Strapi lowercases email identifiers, so
 * `Foo@x.de` and `foo@x.de` hit the same account and must share a bucket.
 */
export function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase();
}

/**
 * Client IP as seen behind the reverse proxy. Trustworthy here: Traefik
 * (and Caddy in the manual profile) overwrite any client-supplied
 * X-Forwarded-For, so the first entry is the real peer. "unknown" only
 * happens in local dev with no proxy in front — all of dev then shares one
 * bucket, which is fine.
 */
export function clientIpFrom(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "unknown";
}

/**
 * Bucket key for a client IP. IPv4 keys as-is (so does "unknown"), but a
 * single IPv6 subscriber typically controls a whole /64 — keying the full
 * address would hand an attacker 2^64 fresh buckets to rotate through, one
 * per attempt. IPv6 therefore keys on its /64 prefix: "::" compression is
 * expanded and the first four hextets, zero-padded, form the key (e.g.
 * "2a03:4000:0064:079a"). IPv4-mapped addresses ("::ffff:1.2.3.4") come
 * from an IPv4 peer and key as that IPv4 address.
 */
export function rateLimitKeyForIp(ip: string): string {
  if (!ip.includes(":")) return ip;
  // IPv4-mapped/embedded form — everything after the last colon is the
  // dotted IPv4 address of the actual peer.
  if (ip.includes(".")) return ip.slice(ip.lastIndexOf(":") + 1);
  const [head, tail = ""] = ip.split("::", 2);
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [
        ...headParts,
        ...Array<string>(Math.max(8 - headParts.length - tailParts.length, 0)).fill("0"),
        ...tailParts,
      ]
    : headParts;
  return groups
    .slice(0, 4)
    .map((part) => part.toLowerCase().padStart(4, "0"))
    .join(":");
}

/** Log-safe form of an identifier: two leading chars + domain survive. */
export function maskIdentifier(identifier: string): string {
  const normalized = normalizeIdentifier(identifier);
  const at = normalized.indexOf("@");
  const local = at === -1 ? normalized : normalized.slice(0, at);
  const domain = at === -1 ? "" : normalized.slice(at);
  return `${local.slice(0, 2)}***${domain}`;
}

/**
 * Create an isolated limiter instance. Production uses the singleton below;
 * tests create their own so state never leaks between test cases.
 */
export function createLoginRateLimiter(): LoginRateLimiter {
  // key -> timestamps (ms) of failed attempts, oldest first.
  const ipFailures = new Map<string, number[]>();
  const identifierFailures = new Map<string, number[]>();

  /** Drop expired timestamps for one key; delete the bucket when empty. */
  function liveFailures(
    store: Map<string, number[]>,
    key: string,
    windowMs: number,
    now: number,
  ): number[] {
    const stamps = store.get(key);
    if (!stamps) return [];
    const live = stamps.filter((t) => now - t < windowMs);
    if (live.length === 0) store.delete(key);
    else if (live.length !== stamps.length) store.set(key, live);
    return live;
  }

  /**
   * Evict one bucket to keep the map under the cap. Blocked buckets are no
   * longer touched (authorize() rejects before recordFailure), so they age
   * towards the Map head — naive oldest-first eviction would let an
   * attacker wash an ACTIVE lockout out of the store by flooding fresh
   * identifier keys. Prefer the least-recently-touched bucket that is NOT
   * currently blocked; only if all probed buckets (the first
   * EVICTION_SCAN_LIMIT) are blocked does the oldest go anyway — the hard
   * memory cap always wins over lockout persistence.
   */
  function evictOne(
    store: Map<string, number[]>,
    windowMs: number,
    maxFailures: number,
    now: number,
  ) {
    let scanned = 0;
    for (const [key, stamps] of store) {
      if (scanned++ >= EVICTION_SCAN_LIMIT) break;
      const liveCount = stamps.filter((t) => now - t < windowMs).length;
      if (liveCount < maxFailures) {
        store.delete(key);
        return;
      }
    }
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }

  /**
   * Append a failure, keeping the map within MAX_TRACKED_KEYS. Returns true
   * when this failure moves the bucket exactly TO the limit — i.e. the
   * transition into the block state (while blocked, callers stop recording,
   * so the count only re-reaches the limit after the window slid past).
   */
  function record(
    store: Map<string, number[]>,
    key: string,
    windowMs: number,
    maxFailures: number,
    now: number,
  ): boolean {
    const live = liveFailures(store, key, windowMs, now);
    live.push(now);
    // Delete + set moves the key to the end of the Map's insertion order,
    // so eviction below scans least-recently-touched buckets first.
    store.delete(key);
    if (store.size >= MAX_TRACKED_KEYS) {
      evictOne(store, windowMs, maxFailures, now);
    }
    store.set(key, live);
    return live.length === maxFailures;
  }

  return {
    isBlocked(ip, identifier, now = Date.now()) {
      return (
        liveFailures(ipFailures, rateLimitKeyForIp(ip), IP_WINDOW_MS, now).length >=
          IP_MAX_FAILURES ||
        liveFailures(identifierFailures, normalizeIdentifier(identifier), IDENTIFIER_WINDOW_MS, now)
          .length >= IDENTIFIER_MAX_FAILURES
      );
    },
    recordFailure(ip, identifier, now = Date.now()) {
      // Evaluate both dimensions unconditionally — the transition of either
      // one must be reported (no short-circuit).
      const ipTipped = record(
        ipFailures,
        rateLimitKeyForIp(ip),
        IP_WINDOW_MS,
        IP_MAX_FAILURES,
        now,
      );
      const identifierTipped = record(
        identifierFailures,
        normalizeIdentifier(identifier),
        IDENTIFIER_WINDOW_MS,
        IDENTIFIER_MAX_FAILURES,
        now,
      );
      return ipTipped || identifierTipped;
    },
    recordSuccess(identifier) {
      identifierFailures.delete(normalizeIdentifier(identifier));
    },
    size() {
      return ipFailures.size + identifierFailures.size;
    },
  };
}

/**
 * Process-wide instance shared by authorize() and the auth Server Actions.
 *
 * Pinned on globalThis, NOT a plain module-scope const: Turbopack compiles
 * this module into multiple layer chunks with separate module registries
 * (empirically: the Server-Action layer and the /api/auth route layer each
 * instantiate the module in the prod build). A module-scope singleton would
 * exist once per layer with disjoint buckets — an attacker could then split
 * attempts across the two entry points and double every limit. globalThis
 * is shared by every chunk in the Node process, so this is the one true
 * instance.
 */
const g = globalThis as typeof globalThis & {
  __sinnlosLoginRateLimiter?: LoginRateLimiter;
};
export const loginRateLimiter = (g.__sinnlosLoginRateLimiter ??= createLoginRateLimiter());
