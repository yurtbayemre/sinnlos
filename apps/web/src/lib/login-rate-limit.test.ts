import { describe, expect, it } from "vitest";
import {
  clientIpFrom,
  createLoginRateLimiter,
  EVICTION_SCAN_LIMIT,
  IDENTIFIER_MAX_FAILURES,
  IDENTIFIER_WINDOW_MS,
  IP_MAX_FAILURES,
  IP_WINDOW_MS,
  maskIdentifier,
  MAX_TRACKED_KEYS,
  rateLimitKeyForIp,
} from "./login-rate-limit";

/**
 * Rate limiting for the password login (GitHub issue #23).
 *
 * The login had no effective limit: the Server Action posts to the
 * un-limited web catch-all router, and POST /api/auth/callback/local calls
 * authorize() directly. authorize() now consults this in-memory limiter as
 * the authoritative gate. These tests pin
 *   1. only FAILURES count — per IP (short window) and per identifier
 *      (long window, case-insensitive) — so an office NAT full of
 *      legitimate logins never throttles anyone,
 *   2. an identifier lockout holds across IPs (distributed guessing) while
 *      unrelated accounts and fresh IPs stay unaffected,
 *   3. a successful login resets the identifier bucket but NOT the IP
 *      bucket (the attacker sharing the NAT stays blocked),
 *   4. expired entries are pruned and the store caps its key count — a
 *      stream of random identifiers must not become a memory DoS — while
 *      eviction skips ACTIVELY BLOCKED buckets (a key flood must not wash
 *      an ongoing lockout out of the store),
 *   5. IPv6 keys on the /64 prefix — one subscriber is ONE bucket, not
 *      2^64 fresh ones per interface id,
 *   6. recordFailure reports exactly the transition into the block state,
 *      so authorize() logs once per lock window instead of per attempt.
 */

// Fixed base timestamp — the clock is injected per call, no fake timers.
const T0 = 1_700_000_000_000;

describe("per-IP dimension", () => {
  it("blocks an IP after IP_MAX_FAILURES failures within the window", () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < IP_MAX_FAILURES; i++) {
      // Distinct identifiers: only the IP dimension may trip here.
      expect(limiter.isBlocked("10.0.0.1", `user${i}@x.de`, T0 + i)).toBe(false);
      limiter.recordFailure("10.0.0.1", `user${i}@x.de`, T0 + i);
    }
    expect(limiter.isBlocked("10.0.0.1", "someone-else@x.de", T0 + 20)).toBe(true);
    // A different IP is a different bucket.
    expect(limiter.isBlocked("10.0.0.2", "someone-else@x.de", T0 + 20)).toBe(false);
  });

  it("forgets IP failures once the window slides past", () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < IP_MAX_FAILURES; i++) {
      limiter.recordFailure("10.0.0.1", `user${i}@x.de`, T0);
    }
    expect(limiter.isBlocked("10.0.0.1", "victim@x.de", T0 + IP_WINDOW_MS - 1)).toBe(true);
    expect(limiter.isBlocked("10.0.0.1", "victim@x.de", T0 + IP_WINDOW_MS)).toBe(false);
  });

  it("slides — expired failures stop counting individually", () => {
    const limiter = createLoginRateLimiter();
    const half = IP_MAX_FAILURES / 2;
    for (let i = 0; i < half; i++) limiter.recordFailure("10.0.0.9", `a${i}@x.de`, T0);
    for (let i = 0; i < half; i++) {
      limiter.recordFailure("10.0.0.9", `b${i}@x.de`, T0 + IP_WINDOW_MS / 2);
    }
    // All 10 failures inside the window: blocked.
    expect(limiter.isBlocked("10.0.0.9", "x@x.de", T0 + IP_WINDOW_MS - 1)).toBe(true);
    // The first half expired; the remaining 5 are below the limit.
    expect(limiter.isBlocked("10.0.0.9", "x@x.de", T0 + IP_WINDOW_MS + 1)).toBe(false);
  });

  it("never throttles on successes alone (office NAT)", () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < 100; i++) {
      expect(limiter.isBlocked("10.0.0.1", `user${i}@x.de`, T0 + i)).toBe(false);
      limiter.recordSuccess(`user${i}@x.de`);
    }
  });
});

describe("per-identifier dimension", () => {
  it("locks an identifier across many IPs (distributed guessing)", () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < IDENTIFIER_MAX_FAILURES; i++) {
      // One failure per IP: only the identifier dimension may trip.
      limiter.recordFailure(`10.0.0.${i}`, "victim@x.de", T0 + i);
    }
    expect(limiter.isBlocked("192.168.7.7", "victim@x.de", T0 + 100)).toBe(true);
    // An unrelated account from a fresh IP is unaffected.
    expect(limiter.isBlocked("192.168.7.7", "other@x.de", T0 + 100)).toBe(false);
  });

  it("holds the lockout beyond the IP window and releases after its own", () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < IDENTIFIER_MAX_FAILURES; i++) {
      limiter.recordFailure(`10.0.0.${i}`, "victim@x.de", T0);
    }
    // Long after every per-IP bucket expired, the account lock still holds.
    expect(limiter.isBlocked("10.0.0.0", "victim@x.de", T0 + 2 * IP_WINDOW_MS)).toBe(true);
    expect(limiter.isBlocked("10.0.0.0", "victim@x.de", T0 + IDENTIFIER_WINDOW_MS)).toBe(false);
  });

  it("normalises identifiers case-insensitively into ONE bucket", () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < IDENTIFIER_MAX_FAILURES; i++) {
      limiter.recordFailure(`10.1.0.${i}`, i % 2 ? "Victim@X.de" : " victim@x.de ", T0 + i);
    }
    expect(limiter.isBlocked("10.2.0.1", "VICTIM@x.DE", T0 + 100)).toBe(true);
  });

  it("resets the identifier bucket on success — the IP bucket stays", () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < IP_MAX_FAILURES; i++) {
      limiter.recordFailure("10.0.0.1", "victim@x.de", T0 + i);
    }
    // Both dimensions tripped; the account lock is visible from another IP.
    expect(limiter.isBlocked("10.0.0.2", "victim@x.de", T0 + 20)).toBe(true);
    limiter.recordSuccess("Victim@X.de"); // normalised like the failures
    expect(limiter.isBlocked("10.0.0.2", "victim@x.de", T0 + 20)).toBe(false);
    // The attacker's IP (or shared NAT) stays blocked.
    expect(limiter.isBlocked("10.0.0.1", "anyone@x.de", T0 + 20)).toBe(true);
  });
});

describe("memory bounds", () => {
  it("holds the hard key cap under a flood of random identifiers", () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < MAX_TRACKED_KEYS + 500; i++) {
      limiter.recordFailure(`10.9.${i >> 8}.${i & 255}`, `rnd${i}@x.de`, T0 + i);
    }
    // Both dimensions together never exceed 2 * cap.
    expect(limiter.size()).toBeLessThanOrEqual(2 * MAX_TRACKED_KEYS);
  });

  it("an ACTIVELY BLOCKED bucket survives a flood past the key cap", () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < IDENTIFIER_MAX_FAILURES; i++) {
      limiter.recordFailure(`10.0.1.${i}`, "victim@x.de", T0);
    }
    expect(limiter.isBlocked("10.9.9.9", "victim@x.de", T0 + 1)).toBe(true);
    for (let i = 0; i < MAX_TRACKED_KEYS; i++) {
      limiter.recordFailure(`10.8.${i >> 8}.${i & 255}`, `rnd${i}@x.de`, T0 + 2);
    }
    // The victim bucket is the oldest, but it is in the block state —
    // eviction skips it and takes the oldest NON-blocked bucket instead,
    // so an attacker cannot lift an active lockout by flooding fresh keys.
    expect(limiter.isBlocked("10.9.9.9", "victim@x.de", T0 + 3)).toBe(true);
  });

  it("still washes out a PARTIALLY-filled bucket (below the limit) at the cap", () => {
    const limiter = createLoginRateLimiter();
    // One failure short of the identifier limit: not blocked yet.
    for (let i = 0; i < IDENTIFIER_MAX_FAILURES - 1; i++) {
      limiter.recordFailure(`10.0.1.${i}`, "victim@x.de", T0);
    }
    for (let i = 0; i < MAX_TRACKED_KEYS; i++) {
      limiter.recordFailure(`10.8.${i >> 8}.${i & 255}`, `rnd${i}@x.de`, T0 + 1);
    }
    // The near-blocked bucket was evictable and gone — one more failure
    // starts a fresh count of 1 instead of reaching the limit. Accepted:
    // only ACTIVE lockouts are protected, partial counts may be washed.
    limiter.recordFailure("10.0.1.9", "victim@x.de", T0 + 2);
    expect(limiter.isBlocked("10.9.9.9", "victim@x.de", T0 + 3)).toBe(false);
  });

  it("evicts the oldest bucket anyway when all probed buckets are blocked (hard cap)", () => {
    const limiter = createLoginRateLimiter();
    // Fill the head of the identifier map with EVICTION_SCAN_LIMIT blocked
    // buckets — the eviction probe will see only blocked candidates.
    for (let i = 0; i < EVICTION_SCAN_LIMIT; i++) {
      for (let j = 0; j < IDENTIFIER_MAX_FAILURES; j++) {
        limiter.recordFailure(`10.${j}.0.1`, `hot${i}@x.de`, T0);
      }
    }
    expect(limiter.isBlocked("10.99.99.99", "hot0@x.de", T0 + 1)).toBe(true);
    // Overflow the cap by exactly one identifier: the probe finds only
    // blocked buckets and the hard memory cap wins — the oldest blocked
    // bucket (hot0) is evicted, the younger ones survive.
    for (let i = 0; i < MAX_TRACKED_KEYS - EVICTION_SCAN_LIMIT + 1; i++) {
      limiter.recordFailure(`10.8.${i >> 8}.${i & 255}`, `rnd${i}@x.de`, T0 + 2);
    }
    expect(limiter.isBlocked("10.99.99.99", "hot0@x.de", T0 + 3)).toBe(false);
    expect(limiter.isBlocked("10.99.99.99", "hot1@x.de", T0 + 3)).toBe(true);
  });

  it("prunes an expired bucket from the store on access", () => {
    const limiter = createLoginRateLimiter();
    limiter.recordFailure("10.0.0.1", "user@x.de", T0);
    expect(limiter.size()).toBe(2); // one IP bucket + one identifier bucket
    limiter.isBlocked("10.0.0.1", "user@x.de", T0 + IDENTIFIER_WINDOW_MS);
    expect(limiter.size()).toBe(0);
  });
});

describe("IPv6 /64 bucketing", () => {
  it("rotating interface ids within one /64 share ONE bucket", () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < IP_MAX_FAILURES; i++) {
      // Distinct addresses (and identifiers) — only the /64 prefix repeats.
      limiter.recordFailure(`2a03:4000:64:79a::${i.toString(16)}`, `u${i}@x.de`, T0 + i);
    }
    // Same /64, different notation and interface id: same bucket, blocked.
    expect(limiter.isBlocked("2a03:4000:0064:079a:dead:beef:1:2", "x@x.de", T0 + 20)).toBe(true);
    // The neighbouring /64 is a different bucket.
    expect(limiter.isBlocked("2a03:4000:64:79b::1", "x@x.de", T0 + 20)).toBe(false);
  });
});

describe("rateLimitKeyForIp", () => {
  it("keys IPv4 (and 'unknown') as-is", () => {
    expect(rateLimitKeyForIp("203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitKeyForIp("unknown")).toBe("unknown");
  });

  it("normalises IPv6 to the zero-padded /64 prefix", () => {
    expect(rateLimitKeyForIp("2a03:4000:64:79a:1:2:3:4")).toBe("2a03:4000:0064:079a");
    expect(rateLimitKeyForIp("2A03:4000:64:79A::1")).toBe("2a03:4000:0064:079a");
  });

  it("expands '::' compression before taking the prefix", () => {
    expect(rateLimitKeyForIp("2a03:4000::1")).toBe("2a03:4000:0000:0000");
    expect(rateLimitKeyForIp("::1")).toBe("0000:0000:0000:0000");
    expect(rateLimitKeyForIp("fe80::")).toBe("fe80:0000:0000:0000");
  });

  it("keys an IPv4-mapped address as its embedded IPv4 (same peer)", () => {
    expect(rateLimitKeyForIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
  });
});

describe("block-transition reporting (recordFailure return value)", () => {
  it("reports true exactly on the failure that tips the IP bucket", () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < IP_MAX_FAILURES - 1; i++) {
      // Distinct identifiers: only the IP dimension can tip here.
      expect(limiter.recordFailure("10.0.0.1", `u${i}@x.de`, T0 + i)).toBe(false);
    }
    expect(limiter.recordFailure("10.0.0.1", "u-last@x.de", T0 + 20)).toBe(true);
  });

  it("reports true exactly on the failure that tips the identifier bucket", () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < IDENTIFIER_MAX_FAILURES - 1; i++) {
      // Distinct IPs: only the identifier dimension can tip here.
      expect(limiter.recordFailure(`10.0.0.${i}`, "victim@x.de", T0 + i)).toBe(false);
    }
    expect(limiter.recordFailure("10.0.0.99", "victim@x.de", T0 + 20)).toBe(true);
  });

  it("stays false for further failures while already blocked", () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < IP_MAX_FAILURES; i++) {
      limiter.recordFailure("10.0.0.1", `u${i}@x.de`, T0 + i);
    }
    // authorize() would not even record while blocked — but if a caller
    // does, the transition must not be reported (and logged) again.
    expect(limiter.recordFailure("10.0.0.1", "u-more@x.de", T0 + 21)).toBe(false);
  });

  it("reports a NEW transition once the window slid and the bucket refills", () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < IP_MAX_FAILURES; i++) {
      limiter.recordFailure("10.0.0.1", `u${i}@x.de`, T0);
    }
    const later = T0 + IP_WINDOW_MS + 1;
    for (let i = 0; i < IP_MAX_FAILURES - 1; i++) {
      expect(limiter.recordFailure("10.0.0.1", `v${i}@x.de`, later + i)).toBe(false);
    }
    expect(limiter.recordFailure("10.0.0.1", "v-last@x.de", later + 20)).toBe(true);
  });
});

describe("clientIpFrom", () => {
  it("takes the FIRST x-forwarded-for hop (Traefik overwrites spoofed values)", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.2, 172.18.0.1" });
    expect(clientIpFrom(headers)).toBe("203.0.113.7");
  });

  it("trims whitespace around the first hop", () => {
    expect(clientIpFrom(new Headers({ "x-forwarded-for": "  203.0.113.7 , 10.0.0.2" }))).toBe(
      "203.0.113.7",
    );
  });

  it("falls back to x-real-ip, then to 'unknown' (local dev, no proxy)", () => {
    expect(clientIpFrom(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIpFrom(new Headers())).toBe("unknown");
  });

  it("ignores an empty x-forwarded-for header", () => {
    const headers = new Headers({ "x-forwarded-for": "", "x-real-ip": "203.0.113.9" });
    expect(clientIpFrom(headers)).toBe("203.0.113.9");
  });
});

describe("maskIdentifier", () => {
  it("keeps two leading chars and the domain for log correlation", () => {
    expect(maskIdentifier("Victim@Example.com")).toBe("vi***@example.com");
  });

  it("handles short and domain-less identifiers", () => {
    expect(maskIdentifier("a@x.de")).toBe("a***@x.de");
    expect(maskIdentifier("bob")).toBe("bo***");
  });
});
