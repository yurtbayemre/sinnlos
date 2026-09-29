/**
 * In-memory sliding-window rate limiter for the password login (issue #23).
 *
 * Why in the app and not (only) at the edge: the credentials login runs as
 * a Server Action POST — Server Action requests are not path-bound — and
 * Auth.js additionally exposes POST /api/auth/callback/local, which calls
 * authorize() directly (the CSRF token is fetchable from /api/auth/csrf,
 * trivially scriptable). A limiter on any outer route alone is therefore
 * bypassable; the authoritative gate sits in authorize() (see @/auth,
 * lib/auth/credentials.ts), with the Traefik router limit
 * (infra/docker-compose.traefik.yml) as a coarse pre-filter only. The
 * register action uses the same limiter.
 *
 * Two dimensions, both counting FAILURES only — an office NAT produces many
 * legitimate logins from one IP and those must never throttle anyone:
 *  - per client IP: fast brute force from a single host,
 *  - per identifier (case-insensitive) across ALL IPs: distributed guessing
 *    against one account; a successful login resets this bucket.
 *
 * Reserve, then verify (FX39): tryAcquire() checks AND reserves a place in
 * both buckets in one synchronous step, before the Strapi call; settle()
 * then turns the reservation into a failure, or gives it back (success, and
 * the "neutral" outcomes: Strapi's 429, a 5xx, a network error). The former
 * check-then-record split let a burst of parallel attempts all pass the
 * check before the first failure was recorded, so a burst went past the
 * limit. An attempt in flight therefore holds its place until it settles:
 * at most the limit's number of attempts per IP and per identifier are in
 * flight at once (a sign-in takes well under a second, see the 5 s timeout).
 * Only failures stay counted.
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

declare const loginAttemptBrand: unique symbol;

/** A reserved attempt (tryAcquire), settled exactly once (settle). Opaque. */
export interface LoginAttemptTicket {
  readonly [loginAttemptBrand]: true;
}

/**
 * How a reserved attempt ended: "failure" = a genuine verification failure
 * (it stays counted); "success" gives the place back and clears the
 * identifier bucket; "neutral" (Strapi's 429, a 5xx, a network error, no
 * verdict) gives the place back.
 */
export type LoginAttemptOutcome = "success" | "failure" | "neutral";

/** The limiter consulted by authorize() — see createLoginRateLimiter. */
export interface LoginRateLimiter {
  /**
   * Read-only check (never counts as an attempt): whether an attempt now
   * would be refused. Attempts in flight hold their place too.
   */
  isBlocked(ip: string, identifier: string, now?: number): boolean;
  /**
   * Check and reserve in one step: "blocked" (nothing recorded), or a
   * ticket holding one place in the IP and in the identifier bucket until
   * it is settled.
   */
  tryAcquire(ip: string, identifier: string, now?: number): LoginAttemptTicket | "blocked";
  /**
   * Settles a ticket (a second settle, or a ticket of another limiter, is
   * ignored and answers false). Returns true only when THIS failure tips a
   * bucket into the block state — callers log that transition (once per
   * lock window), not every rejected follow-up attempt, so a scripted flood
   * cannot spam the log.
   */
  settle(ticket: LoginAttemptTicket, outcome: LoginAttemptOutcome, now?: number): boolean;
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

/** One attempt in a bucket: reserved (pending) or a counted failure. */
interface Attempt {
  /** When it was reserved (or, re-added after its bucket went, failed). */
  at: number;
  pending: boolean;
}

/** What a ticket reserved. */
interface Reservation {
  ipKey: string;
  identifierKey: string;
  ipAttempt: Attempt;
  identifierAttempt: Attempt;
}

/**
 * Create an isolated limiter instance. Production uses the singleton below;
 * tests create their own so state never leaks between test cases.
 */
export function createLoginRateLimiter(): LoginRateLimiter {
  // key -> attempts (reserved or failed), oldest first.
  const ipAttempts = new Map<string, Attempt[]>();
  const identifierAttempts = new Map<string, Attempt[]>();
  // Open tickets of THIS limiter; a settled one is removed.
  const open = new WeakMap<LoginAttemptTicket, Reservation>();

  /** Drop expired attempts for one key; delete the bucket when empty. */
  function liveAttempts(
    store: Map<string, Attempt[]>,
    key: string,
    windowMs: number,
    now: number,
  ): Attempt[] {
    const attempts = store.get(key);
    if (!attempts) return [];
    const live = attempts.filter((a) => now - a.at < windowMs);
    if (live.length === 0) store.delete(key);
    else if (live.length !== attempts.length) store.set(key, live);
    return live;
  }

  /**
   * Evict one bucket to keep the map under the cap. Blocked buckets are no
   * longer touched (tryAcquire refuses before reserving), so they age
   * towards the Map head — naive oldest-first eviction would let an
   * attacker wash an ACTIVE lockout out of the store by flooding fresh
   * identifier keys. Prefer the least-recently-touched bucket that is NOT
   * currently blocked; only if all probed buckets (the first
   * EVICTION_SCAN_LIMIT) are blocked does the oldest go anyway — the hard
   * memory cap always wins over lockout persistence.
   */
  function evictOne(
    store: Map<string, Attempt[]>,
    windowMs: number,
    maxFailures: number,
    now: number,
  ) {
    let scanned = 0;
    for (const [key, attempts] of store) {
      if (scanned++ >= EVICTION_SCAN_LIMIT) break;
      const liveCount = attempts.filter((a) => now - a.at < windowMs).length;
      if (liveCount < maxFailures) {
        store.delete(key);
        return;
      }
    }
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }

  /** Append an attempt, keeping the map within MAX_TRACKED_KEYS. */
  function append(
    store: Map<string, Attempt[]>,
    key: string,
    attempt: Attempt,
    windowMs: number,
    maxFailures: number,
    now: number,
  ) {
    const live = liveAttempts(store, key, windowMs, now);
    live.push(attempt);
    // Delete + set moves the key to the end of the Map's insertion order,
    // so eviction scans least-recently-touched buckets first.
    store.delete(key);
    if (store.size >= MAX_TRACKED_KEYS) {
      evictOne(store, windowMs, maxFailures, now);
    }
    store.set(key, live);
  }

  /**
   * Turns a reservation into a failure. Its bucket may have gone meanwhile
   * (a concurrent success cleared the identifier, or eviction): the failure
   * is then counted afresh, as a failure recorded now always was. Returns
   * true when this failure moves the bucket's failures exactly TO the limit
   * — the transition into the block state (the block itself engages as
   * soon as reservations and failures reach it).
   */
  function confirm(
    store: Map<string, Attempt[]>,
    key: string,
    attempt: Attempt,
    windowMs: number,
    maxFailures: number,
    now: number,
  ): boolean {
    const live = liveAttempts(store, key, windowMs, now);
    if (live.includes(attempt)) {
      attempt.pending = false;
    } else {
      append(store, key, { at: now, pending: false }, windowMs, maxFailures, now);
    }
    const failures = liveAttempts(store, key, windowMs, now).filter((a) => !a.pending);
    return failures.length === maxFailures;
  }

  /** Gives a reservation back (success or neutral outcome). */
  function refund(store: Map<string, Attempt[]>, key: string, attempt: Attempt) {
    const attempts = store.get(key);
    const index = attempts ? attempts.indexOf(attempt) : -1;
    if (!attempts || index === -1) return;
    attempts.splice(index, 1);
    if (attempts.length === 0) store.delete(key);
  }

  function isBlocked(ip: string, identifier: string, now: number): boolean {
    return (
      liveAttempts(ipAttempts, rateLimitKeyForIp(ip), IP_WINDOW_MS, now).length >=
        IP_MAX_FAILURES ||
      liveAttempts(identifierAttempts, normalizeIdentifier(identifier), IDENTIFIER_WINDOW_MS, now)
        .length >= IDENTIFIER_MAX_FAILURES
    );
  }

  return {
    isBlocked(ip, identifier, now = Date.now()) {
      return isBlocked(ip, identifier, now);
    },
    tryAcquire(ip, identifier, now = Date.now()) {
      // One synchronous step: nothing can interleave between the check and
      // the reservation (FX39).
      if (isBlocked(ip, identifier, now)) return "blocked";
      const reservation: Reservation = {
        ipKey: rateLimitKeyForIp(ip),
        identifierKey: normalizeIdentifier(identifier),
        ipAttempt: { at: now, pending: true },
        identifierAttempt: { at: now, pending: true },
      };
      append(
        ipAttempts,
        reservation.ipKey,
        reservation.ipAttempt,
        IP_WINDOW_MS,
        IP_MAX_FAILURES,
        now,
      );
      append(
        identifierAttempts,
        reservation.identifierKey,
        reservation.identifierAttempt,
        IDENTIFIER_WINDOW_MS,
        IDENTIFIER_MAX_FAILURES,
        now,
      );
      const ticket = Object.freeze({}) as LoginAttemptTicket;
      open.set(ticket, reservation);
      return ticket;
    },
    settle(ticket, outcome, now = Date.now()) {
      const reservation = open.get(ticket);
      if (!reservation) return false;
      open.delete(ticket);
      const { ipKey, identifierKey, ipAttempt, identifierAttempt } = reservation;
      if (outcome === "failure") {
        // Evaluate both dimensions unconditionally — the transition of
        // either one must be reported (no short-circuit).
        const ipTipped = confirm(ipAttempts, ipKey, ipAttempt, IP_WINDOW_MS, IP_MAX_FAILURES, now);
        const identifierTipped = confirm(
          identifierAttempts,
          identifierKey,
          identifierAttempt,
          IDENTIFIER_WINDOW_MS,
          IDENTIFIER_MAX_FAILURES,
          now,
        );
        return ipTipped || identifierTipped;
      }
      refund(ipAttempts, ipKey, ipAttempt);
      refund(identifierAttempts, identifierKey, identifierAttempt);
      // A successful login resets the identifier bucket (the IP bucket
      // stays: an attacker sharing the NAT stays blocked).
      if (outcome === "success") identifierAttempts.delete(identifierKey);
      return false;
    },
    size() {
      return ipAttempts.size + identifierAttempts.size;
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
