import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isRateLimitedSignIn,
  LoginBlockedSignIn,
  StrapiRateLimitedSignIn,
} from "@/lib/auth-errors";
import {
  createLoginRateLimiter,
  IDENTIFIER_MAX_FAILURES,
  IDENTIFIER_WINDOW_MS,
  type LoginRateLimiter,
} from "@/lib/login-rate-limit";
import {
  authorizeCredentials,
  countsAsFailure,
  LOCAL_SIGN_IN_TIMEOUT_MS,
  type CredentialsDeps,
} from "./credentials";

/**
 * The local sign-in core (WD09) with injected fetch, limiter and clock:
 *   - the request (identifier, password, the client IP forwarded, no-store,
 *     a timeout) and the user it resolves (email from the /auth/local
 *     payload, name and id from /users/me, the payload's user when that
 *     read fails);
 *   - the counting rule: a 400 counts, 5xx, 429 and network errors do not;
 *     Strapi's 429 throws StrapiRateLimitedSignIn;
 *   - the block transition is logged once; a blocked attempt never reaches
 *     Strapi, logs nothing and throws LoginBlockedSignIn (code
 *     rate_limited: "too many attempts", not a wrong password).
 */
const STRAPI = "http://strapi.test";
const T0 = 1_700_000_000_000;
const IP = "203.0.113.7";
const EMAIL = "ada@example.test";

type Answer = { status: number; body?: unknown } | "network-error";

function harness() {
  const answers: { local: Answer; me: Answer } = {
    local: {
      status: 200,
      body: { jwt: "strapi.jwt.value", user: { id: 7, email: EMAIL, username: "ada" } },
    },
    me: { status: 200, body: { id: 7, username: "ada", displayName: "Ada" } },
  };
  const calls: { url: string; init: RequestInit }[] = [];
  const respond = (answer: Answer) => {
    if (answer === "network-error") throw new TypeError("fetch failed");
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url === `${STRAPI}/api/auth/local`) return respond(answers.local);
    if (url === `${STRAPI}/api/users/me`) return respond(answers.me);
    throw new Error(`unexpected fetch ${url}`);
  });
  let clock = T0;
  const warn = vi.fn<(message: string) => void>();
  const limiter: LoginRateLimiter = createLoginRateLimiter();
  const deps: CredentialsDeps = {
    strapiUrl: STRAPI,
    fetch: fetchMock,
    limiter,
    now: () => clock,
    warn,
  };
  const signIn = (identifier: unknown = EMAIL, password: unknown = "pw", clientIp = IP) =>
    authorizeCredentials({ identifier, password, clientIp }, deps);
  return {
    answers,
    calls,
    fetchMock,
    warn,
    limiter,
    signIn,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

let h: ReturnType<typeof harness>;

beforeEach(() => {
  h = harness();
});

describe("authorizeCredentials: the request and the user", () => {
  it("posts identifier and password with the client IP, no-store and a timeout", async () => {
    await h.signIn();
    const [local] = h.calls;
    expect(local!.url).toBe(`${STRAPI}/api/auth/local`);
    expect(local!.init.method).toBe("POST");
    expect(JSON.parse(String(local!.init.body))).toEqual({ identifier: EMAIL, password: "pw" });
    expect(new Headers(local!.init.headers).get("x-forwarded-for")).toBe(IP);
    expect(local!.init.cache).toBe("no-store");
    expect(local!.init.signal).toBeInstanceOf(AbortSignal);
    expect(LOCAL_SIGN_IN_TIMEOUT_MS).toBe(5_000);
  });

  it("resolves the user: name and id from /users/me, email from the /auth/local payload", async () => {
    // /users/me runs through the content-api sanitizer and lacks the email.
    await expect(h.signIn()).resolves.toEqual({
      id: "7",
      name: "Ada",
      email: EMAIL,
      strapiJwt: "strapi.jwt.value",
      strapiUserId: 7,
    });
    const me = h.calls[1]!;
    expect(me.url).toBe(`${STRAPI}/api/users/me`);
    expect(new Headers(me.init.headers).get("authorization")).toBe("Bearer strapi.jwt.value");
  });

  it.each([
    ["answers an error", { status: 500 }],
    ["is unreachable", "network-error"],
  ] as const)("falls back to the payload's user when /users/me %s", async (_label, me) => {
    h.answers.me = me;
    await expect(h.signIn()).resolves.toMatchObject({ id: "7", name: "ada", email: EMAIL });
  });

  it.each([
    ["no identifier", "", "pw"],
    ["no password", EMAIL, ""],
    ["a non-string identifier", 7, "pw"],
    ["a non-string password", EMAIL, ["pw"]],
  ])("answers null for %s without a request", async (_label, identifier, password) => {
    await expect(h.signIn(identifier, password)).resolves.toBeNull();
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["no JWT", { user: { id: 7 } }],
    ["no user id", { jwt: "x", user: { email: EMAIL } }],
    ["no JSON", undefined],
  ])("answers null for a 200 with %s", async (_label, body) => {
    h.answers.local = { status: 200, body };
    await expect(h.signIn()).resolves.toBeNull();
  });
});

describe("authorizeCredentials: the counting rule", () => {
  it("counts a 400 (wrong credentials) and blocks at the limit without a further request", async () => {
    h.answers.local = { status: 400, body: { error: { name: "ValidationError" } } };
    for (let i = 0; i < IDENTIFIER_MAX_FAILURES; i++) {
      await expect(h.signIn(EMAIL, "pw", `10.0.0.${i}`)).resolves.toBeNull();
    }
    expect(h.limiter.isBlocked("192.0.2.1", EMAIL, T0)).toBe(true);
    h.fetchMock.mockClear();
    await expect(h.signIn(EMAIL, "pw", "192.0.2.1")).rejects.toBeInstanceOf(LoginBlockedSignIn);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("answers a blocked attempt as rate_limited, not as a wrong password, and logs nothing", async () => {
    h.answers.local = { status: 400 };
    for (let i = 0; i < IDENTIFIER_MAX_FAILURES; i++) {
      await h.signIn(EMAIL, "pw", `10.0.6.${i}`);
    }
    h.warn.mockClear();
    const blocked: unknown = await h.signIn(EMAIL, "right-pw", "192.0.2.2").catch((e) => e);
    expect(blocked).toBeInstanceOf(LoginBlockedSignIn);
    // The code the sign-in action maps to rateLimited (and the raw callback
    // route puts into its error redirect).
    expect(isRateLimitedSignIn(blocked)).toBe(true);
    expect((blocked as LoginBlockedSignIn).code).toBe("rate_limited");
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("logs the block transition exactly once, with the masked identifier", async () => {
    h.answers.local = { status: 400 };
    for (let i = 0; i < IDENTIFIER_MAX_FAILURES; i++) {
      await h.signIn(EMAIL, "pw", `10.0.1.${i}`);
    }
    // Three refused follow-ups: no further log line.
    for (let i = IDENTIFIER_MAX_FAILURES; i < IDENTIFIER_MAX_FAILURES + 3; i++) {
      await expect(h.signIn(EMAIL, "pw", `10.0.1.${i}`)).rejects.toBeInstanceOf(LoginBlockedSignIn);
    }
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith(
      `[login-rate-limit] block engaged ip=10.0.1.${IDENTIFIER_MAX_FAILURES - 1} identifier=ad***@example.test`,
    );
  });

  it.each([
    ["a 500", { status: 500 }],
    ["a 503", { status: 503 }],
    ["a network error", "network-error"],
  ] as const)("does not count %s", async (_label, answer) => {
    h.answers.local = answer;
    for (let i = 0; i < IDENTIFIER_MAX_FAILURES + 2; i++) {
      await expect(h.signIn()).resolves.toBeNull();
    }
    expect(h.limiter.isBlocked(IP, EMAIL, T0)).toBe(false);
    expect(h.limiter.size()).toBe(0);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it("throws StrapiRateLimitedSignIn on Strapi's 429 and does not count it", async () => {
    h.answers.local = { status: 429 };
    for (let i = 0; i < IDENTIFIER_MAX_FAILURES + 2; i++) {
      await expect(h.signIn()).rejects.toBeInstanceOf(StrapiRateLimitedSignIn);
    }
    expect(h.limiter.isBlocked(IP, EMAIL, T0)).toBe(false);
  });

  it("clears the identifier's failures on a success", async () => {
    h.answers.local = { status: 400 };
    for (let i = 0; i < IDENTIFIER_MAX_FAILURES - 1; i++) {
      await h.signIn(EMAIL, "pw", `10.0.2.${i}`);
    }
    h.answers.local = {
      status: 200,
      body: { jwt: "strapi.jwt.value", user: { id: 7, email: EMAIL } },
    };
    await expect(h.signIn(EMAIL, "pw", "10.0.3.1")).resolves.not.toBeNull();
    h.answers.local = { status: 400 };
    await h.signIn(EMAIL, "pw", "10.0.3.2");
    expect(h.limiter.isBlocked("10.0.3.3", EMAIL, T0)).toBe(false);
  });

  it("reads the injected clock: the lock ends with its window", async () => {
    h.answers.local = { status: 400 };
    for (let i = 0; i < IDENTIFIER_MAX_FAILURES; i++) {
      await h.signIn(EMAIL, "pw", `10.0.4.${i}`);
    }
    h.fetchMock.mockClear();
    await expect(h.signIn(EMAIL, "pw", "10.0.5.1")).rejects.toBeInstanceOf(LoginBlockedSignIn);
    expect(h.fetchMock).not.toHaveBeenCalled();
    h.tick(IDENTIFIER_WINDOW_MS);
    await h.signIn(EMAIL, "pw", "10.0.5.1");
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets no parallel burst past the limit: attempts in flight hold their places (FX39)", async () => {
    // Every /auth/local answer waits until the whole burst was started.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const local = h.fetchMock.getMockImplementation()!;
    h.fetchMock.mockImplementation(async (input, init) => {
      await gate;
      return local(input, init);
    });
    h.answers.local = { status: 400 };
    const burst = Array.from({ length: IDENTIFIER_MAX_FAILURES + 5 }, (_, i) =>
      h.signIn(EMAIL, "pw", `10.9.0.${i}`),
    );
    await Promise.resolve();
    release();
    const settled = await Promise.allSettled(burst);
    // The first ten held a place and got Strapi's answer (a wrong password:
    // null); the five beyond the limit were refused as rate_limited.
    expect(settled.slice(0, IDENTIFIER_MAX_FAILURES)).toEqual(
      Array.from({ length: IDENTIFIER_MAX_FAILURES }, () => ({ status: "fulfilled", value: null })),
    );
    for (const outcome of settled.slice(IDENTIFIER_MAX_FAILURES)) {
      expect(outcome.status).toBe("rejected");
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(LoginBlockedSignIn);
    }
    // Exactly the limit reached Strapi; the transition was logged once.
    expect(h.fetchMock).toHaveBeenCalledTimes(IDENTIFIER_MAX_FAILURES);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.limiter.isBlocked("10.9.1.1", EMAIL, T0)).toBe(true);
  });

  it("gives an outage's places back: a burst during a 503 blocks nobody afterwards", async () => {
    h.answers.local = { status: 503 };
    await Promise.all(
      Array.from({ length: IDENTIFIER_MAX_FAILURES }, (_, i) =>
        h.signIn(EMAIL, "pw", `10.9.2.${i}`),
      ),
    );
    expect(h.limiter.size()).toBe(0);
    expect(h.limiter.isBlocked(IP, EMAIL, T0)).toBe(false);
  });

  it("names the statuses that count", () => {
    for (const status of [400, 401, 403, 404])
      expect(countsAsFailure(status), `${status}`).toBe(true);
    for (const status of [429, 500, 502, 503])
      expect(countsAsFailure(status), `${status}`).toBe(false);
  });
});
