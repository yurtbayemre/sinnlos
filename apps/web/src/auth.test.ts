import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decode, encode, type JWT } from "next-auth/jwt";

/**
 * D-SESSION-01 regression suite (deep-dive decisions/01-microsoft-signin.md
 * spec C/M, investigations.md #1/#2). Runs the REAL apps/web/src/auth.ts
 * through the REAL Auth.js route handlers (GET/POST /api/auth/*) and the real
 * server-side auth(); only Strapi (global fetch) and `next/headers` (the
 * request headers auth() and the token reader see) are stubbed. Pins:
 *   1. GET /api/auth/session — reachable by any script on the origin — never
 *      carries the Strapi JWT, a role or a department, for either provider.
 *   2. The Auth.js session ends with the Strapi JWT: the jwt callback records
 *      strapiJwtExp and returns null once it has passed.
 *   3. getStrapiToken() reads the JWT server-side from the session cookie
 *      under the cookie name/salt Auth.js actually used: plain
 *      `authjs.session-token` over http, `__Secure-authjs.session-token`
 *      behind an https AUTH_URL or x-forwarded-proto (lib/strapi-token.ts).
 *   4. Server-side auth() yields null (fails closed) when Auth.js answers the
 *      session read with a configuration error.
 */
const SECRET = "vitest-auth-secret-0123456789-abcdefghijklmnop";
const STRAPI = "http://strapi.test";
const DAY = 24 * 60 * 60;
const nowSec = () => Math.floor(Date.now() / 1000);

/** A Strapi-shaped JWT (unsigned for the web: only `exp` is ever decoded). */
function fakeStrapiJwt(exp: number, id = 7): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ id, iat: exp - 7 * DAY, exp })}.sig-${id}-${exp}`;
}

const stub = vi.hoisted(() => ({
  /** Headers the server-side auth()/getStrapiJwt() read via next/headers. */
  headers: new Headers(),
  /** HTTP status of Strapi's POST /api/auth/local (429 = its throttle). */
  localStatus: 200,
  localExp: 0,
  localJwt: "",
  exchangeExp: 0,
  exchangeJwt: "",
  /** HTTP status of the Microsoft callback exchange (400 = Strapi 5.51+). */
  exchangeStatus: 200,
}));

vi.mock("next/headers", () => ({
  headers: async () => stub.headers,
  cookies: async () => ({
    get: () => undefined,
    getAll: () => [],
    has: () => false,
    set: () => {},
  }),
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Strapi answers WITH role and department everywhere, so the assertions
// below prove the web drops them rather than never receiving them.
const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === `${STRAPI}/api/auth/local`) {
    if (stub.localStatus !== 200) {
      return json({ error: { status: stub.localStatus } }, stub.localStatus);
    }
    return json({
      jwt: stub.localJwt,
      user: { id: 7, username: "ada", email: "ada@example.test" },
    });
  }
  if (url.startsWith(`${STRAPI}/api/users/me`)) {
    return json({
      id: 7,
      username: "ada",
      displayName: "Ada",
      email: "ada@example.test",
      role: { type: "admin_role" },
      department: { id: 3, name: "Engineering", slug: "engineering" },
    });
  }
  if (url.startsWith(`${STRAPI}/api/auth/microsoft/callback?access_token=`)) {
    if (stub.exchangeStatus === 400) {
      // What @strapi/plugin-users-permissions 5.51+ answers a callback that
      // did not come through its own OAuth (grant) session.
      return json(
        {
          data: null,
          error: {
            status: 400,
            name: "ApplicationError",
            message: "OAuth authentication requires a completed provider session",
            details: {},
          },
        },
        400,
      );
    }
    return json({
      jwt: stub.exchangeJwt,
      user: {
        id: 42,
        username: "grace",
        email: "grace@example.test",
        displayName: "Grace",
        role: { id: 1, type: "admin_role", name: "Admin" },
        department: { id: 3, name: "Engineering", slug: "engineering" },
      },
    });
  }
  throw new Error(`unexpected fetch ${url}`);
});
vi.stubGlobal("fetch", fetchMock);

type Env = Record<string, string | undefined>;
const BASE_ENV: Env = {
  AUTH_SECRET: SECRET,
  NEXTAUTH_SECRET: undefined,
  AUTH_URL: undefined,
  NEXTAUTH_URL: undefined,
  STRAPI_URL: STRAPI,
  AUTH_LOCAL_ENABLED: "1",
  AUTH_MICROSOFT_ENTRA_ID_ID: undefined,
  AUTH_MICROSOFT_ENTRA_ID_SECRET: undefined,
  DEMO_MODE: undefined,
};

/** Fresh auth.ts (+ session/token modules) under the given env. */
async function load(env: Env = {}) {
  vi.resetModules();
  // The login limiter lives on globalThis (lib/login-rate-limit.ts) and
  // would otherwise outlive resetModules().
  delete (globalThis as { __sinnlosLoginRateLimiter?: unknown }).__sinnlosLoginRateLimiter;
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...env })) vi.stubEnv(key, value);
  const authModule = await import("@/auth");
  const session = await import("@/lib/session");
  const token = await import("@/lib/strapi-token");
  return { ...authModule, ...session, ...token };
}

/** Minimal cookie jar: remembers Set-Cookie pairs, replays them. */
function cookieJar() {
  const jar = new Map<string, string>();
  return {
    absorb(res: Response) {
      for (const line of res.headers.getSetCookie()) {
        const pair = line.split(";")[0] ?? "";
        const i = pair.indexOf("=");
        const [name, value] = [pair.slice(0, i), pair.slice(i + 1)];
        if (value === "") jar.delete(name);
        else jar.set(name, value);
      }
    },
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    names: () => [...jar.keys()],
  };
}

type Loaded = Awaited<ReturnType<typeof load>>;

/** csrf → POST /api/auth/callback/local, exactly like the sign-in form. */
async function signInLocal(mod: Loaded, base: string) {
  const jar = cookieJar();
  const csrfRes = await mod.handlers.GET(new NextRequest(`${base}/api/auth/csrf`));
  jar.absorb(csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const res = await mod.handlers.POST(
    new NextRequest(`${base}/api/auth/callback/local`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
      body: new URLSearchParams({ csrfToken, identifier: "ada@example.test", password: "pw" }),
    }),
  );
  jar.absorb(res);
  return { jar, res };
}

async function getSessionJson(mod: Loaded, base: string, cookie: string): Promise<Response> {
  return mod.handlers.GET(new NextRequest(`${base}/api/auth/session`, { headers: { cookie } }));
}

/** Everything a browser could learn from the session JSON must lack these. */
function expectNoStrapiSecrets(body: unknown, jwt: string) {
  const text = JSON.stringify(body);
  expect(text).not.toContain(jwt);
  expect(text).not.toContain(jwt.split(".")[2]!);
  for (const key of ["strapiJwt", "strapiJwtExp", "strapiUserId", "role", "department"]) {
    expect(text).not.toContain(`"${key}"`);
  }
}

beforeEach(() => {
  stub.headers = new Headers();
  stub.localStatus = 200;
  stub.localExp = nowSec() + 7 * DAY;
  stub.localJwt = fakeStrapiJwt(stub.localExp);
  stub.exchangeExp = nowSec() + 7 * DAY - 5;
  stub.exchangeJwt = fakeStrapiJwt(stub.exchangeExp, 42);
  stub.exchangeStatus = 200;
  fetchMock.mockClear();
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/auth/session never exposes the Strapi JWT", () => {
  it("local sign-in: only id, provider and the display fields reach the browser", async () => {
    const mod = await load();
    const { jar, res } = await signInLocal(mod, "http://localhost:3000");
    expect(res.status).toBe(302);
    expect(jar.names()).toContain("authjs.session-token");

    const sRes = await getSessionJson(mod, "http://localhost:3000", jar.header());
    const body = (await sRes.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      provider: "local",
      user: { id: 7, name: "Ada", email: "ada@example.test" },
    });
    expect(Object.keys(body).sort()).toEqual(["expires", "provider", "user"]);
    expectNoStrapiSecrets(body, stub.localJwt);
  });

  it("local sign-in keeps the JWT and its exp on the encrypted token only", async () => {
    const mod = await load();
    const { jar } = await signInLocal(mod, "http://localhost:3000");
    const cookie = jar.header().match(/authjs\.session-token=([^;]+)/)?.[1];
    const token = await decode({ token: cookie, secret: SECRET, salt: "authjs.session-token" });
    expect(token).toMatchObject({
      strapiJwt: stub.localJwt,
      strapiUserId: 7,
      strapiJwtExp: stub.localExp,
      provider: "local",
    });
    // Role and department are resolved per request (getViewer), never frozen.
    expect(token).not.toHaveProperty("strapiRole");
    expect(token).not.toHaveProperty("strapiDepartment");
  });

  // Contract of the jwt callback for a SUCCESSFUL exchange. The CMS no longer
  // produces one (Strapi 5.51+ answers 400, pinned in the Microsoft describe
  // below); this stays as the D-SESSION-01 pin for the Microsoft branch until
  // the Entra exchange (D-ENTRA-01) replaces it.
  it("Microsoft sign-in: the jwt callback stores JWT + exp, and the session omits them", async () => {
    const mod = await load();
    const token = await mod.callbacks.jwt({
      token: { name: "Entra Name", email: "entra@example.test", sub: "entra-oid" },
      user: { id: "entra-oid", name: "Entra Name", email: "entra@example.test" },
      account: {
        provider: "microsoft-entra-id",
        type: "oidc",
        providerAccountId: "entra-oid",
        access_token: "graph-access-token",
      },
    });
    // The current exchange path (D-ENTRA-01 replaces it).
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${STRAPI}/api/auth/microsoft/callback?access_token=graph-access-token`,
    );
    expect(token).toMatchObject({
      strapiJwt: stub.exchangeJwt,
      strapiUserId: 42,
      strapiJwtExp: stub.exchangeExp,
      name: "Grace",
      email: "grace@example.test",
      provider: "microsoft-entra-id",
    });
    expect(token).not.toHaveProperty("strapiRole");
    expect(token).not.toHaveProperty("strapiDepartment");

    if (!token) throw new Error("the Microsoft sign-in produced no token");
    const cookie = await encode({ token, secret: SECRET, salt: "authjs.session-token" });
    const sRes = await getSessionJson(
      mod,
      "http://localhost:3000",
      `authjs.session-token=${cookie}`,
    );
    const body = (await sRes.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ provider: "microsoft-entra-id", user: { id: 42, name: "Grace" } });
    expectNoStrapiSecrets(body, stub.exchangeJwt);
  });

  it("a session cookie from before D-SESSION-01 (role/department on the token) leaks neither", async () => {
    const mod = await load();
    const legacy = await encode({
      token: {
        name: "Ada",
        strapiJwt: stub.localJwt,
        strapiUserId: 7,
        strapiRole: "admin_role",
        strapiDepartment: { id: 3, name: "Engineering", slug: "engineering" },
        provider: "local",
      },
      secret: SECRET,
      salt: "authjs.session-token",
    });
    const sRes = await getSessionJson(
      mod,
      "http://localhost:3000",
      `authjs.session-token=${legacy}`,
    );
    const body = (await sRes.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ provider: "local", user: { id: 7 } });
    expectNoStrapiSecrets(body, stub.localJwt);
  });
});

describe("Microsoft sign-in against Strapi 5.51+ (the exchange is rejected)", () => {
  const microsoftAccount = {
    token: { name: "Entra Name", email: "entra@example.test", sub: "entra-oid" },
    user: { id: "entra-oid", name: "Entra Name", email: "entra@example.test" },
    account: {
      provider: "microsoft-entra-id",
      type: "oidc" as const,
      providerAccountId: "entra-oid",
      access_token: "graph-access-token",
    },
  };

  it("the 400 fails the sign-in closed, after one attempt and without a session", async () => {
    const mod = await load();
    stub.exchangeStatus = 400;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(mod.callbacks.jwt(microsoftAccount)).rejects.toThrow(
        /Could not exchange Microsoft access token.*Strapi 5\.51\+ rejects this exchange/,
      );
      // A 4xx is not retried: one call, to the users-permissions callback.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        `${STRAPI}/api/auth/microsoft/callback?access_token=graph-access-token`,
      );
      // Strapi's reason reaches the log for the operator.
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("Strapi JWT exchange failed (attempt 1/3)"),
        400,
        expect.stringContaining("OAuth authentication requires a completed provider session"),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a configured Microsoft sign-in logs an error at boot; none without it", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await load({
        AUTH_MICROSOFT_ENTRA_ID_ID: "entra-client-id",
        AUTH_MICROSOFT_ENTRA_ID_SECRET: "entra-client-secret",
      });
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("[auth] Microsoft sign-in is configured but cannot complete"),
      );
      consoleError.mockClear();
      await load();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("the Auth.js session ends with the Strapi JWT", () => {
  async function cookieFor(token: JWT) {
    return `authjs.session-token=${await encode({ token, secret: SECRET, salt: "authjs.session-token" })}`;
  }

  it("expired strapiJwtExp: /api/auth/session is null and the cookie is cleared", async () => {
    const mod = await load();
    const cookie = await cookieFor({
      strapiJwt: fakeStrapiJwt(nowSec() - 60),
      strapiUserId: 7,
      strapiJwtExp: nowSec() - 60,
      provider: "local",
    });
    const res = await getSessionJson(mod, "http://localhost:3000", cookie);
    expect(await res.json()).toBeNull();
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith("authjs.session-token="));
    expect(cleared).toMatch(/^authjs\.session-token=;/);
    expect(cleared).toMatch(/Max-Age=0/i);
  });

  it("server-side auth() and getStrapiToken() yield null for an expired session", async () => {
    const mod = await load();
    stub.headers = new Headers({
      cookie: await cookieFor({
        strapiJwt: fakeStrapiJwt(nowSec() - 1),
        strapiUserId: 7,
        strapiJwtExp: nowSec() - 1,
        provider: "microsoft-entra-id",
      }),
      "x-forwarded-proto": "http",
    });
    expect(await mod.auth()).toBeNull();
    expect(await mod.getStrapiToken()).toBeNull();
  });

  it("a pre-D-SESSION-01 token without strapiJwtExp ends at the embedded JWT's exp", async () => {
    const mod = await load();
    const res = await getSessionJson(
      mod,
      "http://localhost:3000",
      await cookieFor({
        strapiJwt: fakeStrapiJwt(nowSec() - 60),
        strapiUserId: 7,
        provider: "local",
      }),
    );
    expect(await res.json()).toBeNull();
  });

  it("a token without a Strapi JWT is no session", async () => {
    const mod = await load();
    const res = await getSessionJson(
      mod,
      "http://localhost:3000",
      await cookieFor({ name: "x", strapiUserId: 7, provider: "local" }),
    );
    expect(await res.json()).toBeNull();
  });

  it("a live session stays valid until exp", async () => {
    const mod = await load();
    const exp = nowSec() + 60;
    const res = await getSessionJson(
      mod,
      "http://localhost:3000",
      await cookieFor({ strapiJwt: fakeStrapiJwt(exp), strapiUserId: 7, strapiJwtExp: exp }),
    );
    expect(await res.json()).toMatchObject({ user: { id: 7 } });
  });

  it("the jwt callback refuses a sign-in whose Strapi JWT is already expired", async () => {
    const mod = await load();
    const expired = fakeStrapiJwt(nowSec() - 5);
    const result = await mod.callbacks.jwt({
      token: { sub: "7" },
      user: { id: "7", strapiJwt: expired, strapiUserId: 7 },
    });
    expect(result).toBeNull();
  });
});

describe("server-side auth() fails closed on an Auth.js configuration error", () => {
  // proxy.ts and the /uploads route gate on `if (!session)`. On a server
  // configuration error Auth.js answers the session read with a non-OK
  // response whose body is an error object; next-auth >= 5.0.0-beta.32
  // (GHSA-8fpg-xm3f-6cx3) maps that to null instead of returning the truthy
  // error object as the session.
  it("a missing AUTH_SECRET yields no session, even with a session cookie", async () => {
    const valid = await encode({
      token: { strapiJwt: stub.localJwt, strapiUserId: 7, strapiJwtExp: stub.localExp },
      secret: SECRET,
      salt: "authjs.session-token",
    });
    const mod = await load({ AUTH_SECRET: undefined });
    stub.headers = new Headers({
      cookie: `authjs.session-token=${valid}`,
      "x-forwarded-proto": "http",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await mod.auth()).toBeNull();
      expect(await mod.getStrapiToken()).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("getStrapiToken() reads the cookie Auth.js actually set", () => {
  const scenarios = [
    {
      name: "http AUTH_URL (local dev)",
      env: { AUTH_URL: "http://localhost:3000" },
      base: "http://localhost:3000",
      forwardedProto: "http",
      cookieName: "authjs.session-token",
    },
    {
      name: "https AUTH_URL (compose: AUTH_URL=WEB_PUBLIC_URL, TLS ends at the edge)",
      env: { AUTH_URL: "https://intranet.example.test" },
      base: "http://web:3000",
      forwardedProto: "http",
      cookieName: "__Secure-authjs.session-token",
    },
    {
      name: "no AUTH_URL, x-forwarded-proto https",
      env: {},
      base: "https://intranet.example.test",
      forwardedProto: "https",
      cookieName: "__Secure-authjs.session-token",
    },
    {
      name: "no AUTH_URL, x-forwarded-proto http",
      env: {},
      base: "http://localhost:3000",
      forwardedProto: "http",
      cookieName: "authjs.session-token",
    },
  ];

  it.each(scenarios)("$name", async ({ env, base, forwardedProto, cookieName }) => {
    const mod = await load(env);
    const { jar } = await signInLocal(mod, base);
    // The session cookie Auth.js set on sign-in has the expected name …
    expect(jar.names()).toContain(cookieName);
    stub.headers = new Headers({
      cookie: jar.header(),
      host: new URL(base).host,
      "x-forwarded-proto": forwardedProto,
    });
    // … the server-side session sees it, without the JWT …
    const session = await mod.auth();
    expect(session?.user?.id).toBe(7);
    expectNoStrapiSecrets(session, stub.localJwt);
    // … and the token reader decrypts the same cookie.
    expect(await mod.getStrapiToken()).toBe(stub.localJwt);
    expect(await mod.readStrapiJwt(stub.headers)).toBe(stub.localJwt);
  });

  it("the cookie name is also the decryption salt: a mismatched scheme reads nothing", async () => {
    const mod = await load({ AUTH_URL: "https://intranet.example.test" });
    const { jar } = await signInLocal(mod, "http://web:3000");
    const secure = jar.header().match(/__Secure-authjs\.session-token=([^;]+)/)?.[1] ?? "";
    const env = { AUTH_SECRET: SECRET, AUTH_URL: "http://intranet.example.test" };
    // Right value under the plain name: getToken finds it but the salt differs.
    const renamed = new Headers({ cookie: `authjs.session-token=${secure}` });
    expect(await mod.readStrapiJwt(renamed, env)).toBeNull();
    expect(await mod.readStrapiJwt(new Headers({ cookie: jar.header() }), env)).toBeNull();
  });

  it("reads nothing without a cookie, with a wrong secret, or from a Bearer JWE", async () => {
    const mod = await load();
    const { jar } = await signInLocal(mod, "http://localhost:3000");
    const value = jar.header().match(/authjs\.session-token=([^;]+)/)?.[1] ?? "";
    const env = { AUTH_SECRET: SECRET, AUTH_URL: "http://localhost:3000" };
    expect(await mod.readStrapiJwt(new Headers(), env)).toBeNull();
    expect(
      await mod.readStrapiJwt(new Headers({ cookie: jar.header() }), {
        ...env,
        AUTH_SECRET: "some-other-secret-0123456789-abcdefghij",
      }),
    ).toBeNull();
    expect(
      await mod.readStrapiJwt(new Headers({ cookie: jar.header() }), { AUTH_URL: env.AUTH_URL }),
    ).toBeNull();
    // getToken() alone would accept `Authorization: Bearer <session JWE>`;
    // the reader only ever looks at the Cookie header.
    expect(
      await mod.readStrapiJwt(new Headers({ authorization: `Bearer ${value}` }), env),
    ).toBeNull();
  });

  it("getStrapiToken() is null without a session", async () => {
    const mod = await load();
    stub.headers = new Headers({ "x-forwarded-proto": "http" });
    expect(await mod.getStrapiToken()).toBeNull();
  });

  it("usesSecureSessionCookie mirrors Auth.js' URL resolution", async () => {
    const { usesSecureSessionCookie } = await load();
    const h = (proto?: string) => new Headers(proto ? { "x-forwarded-proto": proto } : {});
    expect(usesSecureSessionCookie({ AUTH_URL: "https://a.test" }, h("http"))).toBe(true);
    expect(usesSecureSessionCookie({ AUTH_URL: "http://a.test" }, h("https"))).toBe(false);
    expect(usesSecureSessionCookie({ NEXTAUTH_URL: "https://a.test" }, h("http"))).toBe(true);
    expect(usesSecureSessionCookie({}, h("https"))).toBe(true);
    expect(usesSecureSessionCookie({}, h("http"))).toBe(false);
    // Auth.js defaults to https when neither AUTH_URL nor the header is set.
    expect(usesSecureSessionCookie({}, h())).toBe(true);
    expect(usesSecureSessionCookie({ AUTH_URL: "" }, h("http"))).toBe(false);
  });
});

describe("Strapi's auth throttle (FX11)", () => {
  it("a 429 from /api/auth/local is a distinct rate_limited sign-in error, not a failure count", async () => {
    const mod = await load();
    const { loginRateLimiter } = await import("@/lib/login-rate-limit");
    stub.localStatus = 429;
    // More attempts than the web limiter's per-IP and per-identifier budget.
    for (let i = 0; i < 12; i++) {
      const { res } = await signInLocal(mod, "http://localhost:3000");
      const location = new URL(res.headers.get("location") ?? "", "http://localhost:3000");
      expect(location.pathname).toBe("/sign-in");
      expect(location.searchParams.get("error")).toBe("CredentialsSignin");
      expect(location.searchParams.get("code")).toBe("rate_limited");
    }
    expect(loginRateLimiter.isBlocked("unknown", "ada@example.test")).toBe(false);
  });

  it("a wrong password stays the generic credentials error", async () => {
    const mod = await load();
    stub.localStatus = 400;
    const { res } = await signInLocal(mod, "http://localhost:3000");
    const location = new URL(res.headers.get("location") ?? "", "http://localhost:3000");
    expect(location.searchParams.get("code")).toBe("credentials");
  });
});
