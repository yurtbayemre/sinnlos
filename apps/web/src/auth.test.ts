import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decode, encode, type JWT } from "next-auth/jwt";

/**
 * Auth.js regression suite: D-SESSION-01 and the Entra sign-in of
 * D-ENTRA-01 (deep-dive decisions/01-microsoft-signin.md spec C/M,
 * investigations.md #1/#2). Runs the REAL apps/web/src/auth.ts through the
 * REAL Auth.js route handlers (GET/POST /api/auth/*) and the real
 * server-side auth(); only the network (global fetch: Strapi, and a mock
 * Microsoft identity platform) and `next/headers` (the request headers
 * auth() and the token reader see) are stubbed. Pins:
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
 *   5. The Microsoft sign-in end to end through @auth/core 0.41.3 with a
 *      mock tenant: the authorize request (tenant endpoint, scope without
 *      offline_access), the claims-only profile (no Graph photo request),
 *      the GUID issuer (a token of another tenant fails Auth.js' own iss
 *      check), the signIn callback (tenant check, POST exchange, entra_*
 *      redirects) and the WeakMap hand-off to the jwt callback.
 * Fake GUIDs and secrets only.
 */
const SECRET = "vitest-auth-secret-0123456789-abcdefghijklmnop";
const STRAPI = "http://strapi.test";
const DAY = 24 * 60 * 60;
const nowSec = () => Math.floor(Date.now() / 1000);

const TENANT = "11111111-2222-4333-8444-555555555555";
const OTHER_TENANT = "99999999-8888-4777-8666-555555555555";
const CLIENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OID = "0f0f0f0f-1e1e-4d2d-8c3c-4b4b4b4b4b4b";
const EXCHANGE_SECRET = "web-exchange-secret-0123456789abcdef";
const LOGIN = "https://login.microsoftonline.com";
const EXCHANGE_URL = `${STRAPI}/api/auth/entra/exchange`;

/** A Strapi-shaped JWT (unsigned for the web: only `exp` is ever decoded). */
function fakeStrapiJwt(exp: number, id = 7): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ id, iat: exp - 7 * DAY, exp })}.sig-${id}-${exp}`;
}

/** An RS256-shaped ID token (Auth.js checks its claims; the cms checks the signature). */
function fakeIdToken(claims: Record<string, unknown>): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", kid: "mock-key", typ: "JWT" })}.${b64(claims)}.bW9jay1zaWduYXR1cmU`;
}

type ExchangeAnswer = { status: number; body: unknown } | "network-error";

const stub = vi.hoisted(() => ({
  /** Headers the server-side auth()/getStrapiJwt() read via next/headers. */
  headers: new Headers(),
  /** HTTP status of Strapi's POST /api/auth/local (429 = its throttle). */
  localStatus: 200,
  localExp: 0,
  localJwt: "",
  /** The mock tenant: the next ID token's claims (nonce added from the authorize request). */
  idClaims: {} as Record<string, unknown>,
  nonce: undefined as string | undefined,
  idToken: "",
  accessToken: "graph-access-token-VALUE",
  /** Answers of POST /api/auth/entra/exchange, in order (the last one repeats). */
  exchangeAnswers: [] as ({ status: number; body: unknown } | "network-error")[],
  exchangeCalls: [] as { headers: Headers; body: string }[],
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

const discovery = (tenant: string) => ({
  issuer: `${LOGIN}/${tenant}/v2.0`,
  authorization_endpoint: `${LOGIN}/${tenant}/oauth2/v2.0/authorize`,
  token_endpoint: `${LOGIN}/${tenant}/oauth2/v2.0/token`,
  jwks_uri: `${LOGIN}/${tenant}/discovery/v2.0/keys`,
  end_session_endpoint: `${LOGIN}/${tenant}/oauth2/v2.0/logout`,
  // Auth.js requires one in the metadata; an OIDC sign-in never calls it
  // (the profile comes from the ID token).
  userinfo_endpoint: "https://graph.microsoft.com/oidc/userinfo",
  response_types_supported: ["code", "id_token", "code id_token"],
  subject_types_supported: ["pairwise"],
  id_token_signing_alg_values_supported: ["RS256"],
  scopes_supported: ["openid", "profile", "email", "offline_access"],
});

// Strapi answers WITH role and department everywhere, so the assertions
// below prove the web drops them rather than never receiving them.
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = request.url;
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
  if (url === `${LOGIN}/${TENANT}/v2.0/.well-known/openid-configuration`) {
    return json(discovery(TENANT));
  }
  if (url === `${LOGIN}/${TENANT}/oauth2/v2.0/token` && request.method === "POST") {
    stub.idToken = fakeIdToken({ ...stub.idClaims, ...(stub.nonce ? { nonce: stub.nonce } : {}) });
    return json({
      token_type: "Bearer",
      scope: "openid profile email User.Read",
      expires_in: 3600,
      access_token: stub.accessToken,
      id_token: stub.idToken,
    });
  }
  if (url === EXCHANGE_URL && request.method === "POST") {
    stub.exchangeCalls.push({ headers: request.headers, body: await request.text() });
    const answer =
      stub.exchangeAnswers.length > 1 ? stub.exchangeAnswers.shift()! : stub.exchangeAnswers[0];
    if (!answer || answer === "network-error") throw new TypeError("fetch failed");
    return json(answer.body, answer.status);
  }
  throw new Error(`unexpected fetch ${request.method} ${url}`);
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
  ENTRA_ENABLED: undefined,
  ENTRA_EXCHANGE_SECRET: undefined,
  ENTRA_SYNC_MANAGER: undefined,
  AUTH_MICROSOFT_ENTRA_ID_ID: undefined,
  AUTH_MICROSOFT_ENTRA_ID_SECRET: undefined,
  AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: undefined,
  AUTH_MICROSOFT_ENTRA_ID_ISSUER: undefined,
  NEXT_PHASE: undefined,
  DEMO_MODE: undefined,
  NODE_ENV: "test",
};

/** Microsoft sign-in switched on (next to local sign-in). */
const ENTRA_ENV: Env = {
  ENTRA_ENABLED: "1",
  AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: TENANT.toUpperCase(),
  AUTH_MICROSOFT_ENTRA_ID_ID: CLIENT,
  AUTH_MICROSOFT_ENTRA_ID_SECRET: "web-client-secret-value",
  ENTRA_EXCHANGE_SECRET: EXCHANGE_SECRET,
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

/**
 * The browser side of a Microsoft sign-in: csrf → POST signin (Auth.js
 * redirects to the tenant's authorize endpoint) → the IdP "redirects back"
 * with a code → GET callback (Auth.js redeems the code at the mock token
 * endpoint and runs the callbacks).
 */
async function signInMicrosoft(mod: Loaded, base = "http://localhost:3000") {
  const jar = cookieJar();
  const csrfRes = await mod.handlers.GET(new NextRequest(`${base}/api/auth/csrf`));
  jar.absorb(csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const start = await mod.handlers.POST(
    new NextRequest(`${base}/api/auth/signin/microsoft-entra-id`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
      body: new URLSearchParams({ csrfToken, callbackUrl: `${base}/wiki` }),
    }),
  );
  jar.absorb(start);
  const authorize = new URL(start.headers.get("location") ?? "about:blank");
  stub.nonce = authorize.searchParams.get("nonce") ?? undefined;
  const params = new URLSearchParams({ code: "mock-authorization-code" });
  const state = authorize.searchParams.get("state");
  if (state) params.set("state", state);
  const callback = await mod.handlers.GET(
    new NextRequest(`${base}/api/auth/callback/microsoft-entra-id?${params}`, {
      headers: { cookie: jar.header() },
    }),
  );
  jar.absorb(callback);
  return { jar, start, authorize, callback };
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

const idClaims = (overrides: Record<string, unknown> = {}) => {
  const iat = nowSec() - 5;
  return {
    iss: `${LOGIN}/${TENANT}/v2.0`,
    aud: CLIENT,
    sub: "pairwise-subject-of-grace",
    oid: OID,
    tid: TENANT,
    iat,
    nbf: iat,
    exp: iat + 3600,
    name: "Grace Entra",
    preferred_username: "Grace@Example.test",
    ...overrides,
  };
};

let exchangeExp = 0;
let exchangeJwt = "";
const exchangeOk = () => ({
  status: 200,
  body: {
    jwt: exchangeJwt,
    expiresAt: exchangeExp,
    user: { id: 42, displayName: "Grace", email: "grace@example.test" },
  },
});

const graphCalls = () =>
  fetchMock.mock.calls.filter(([input]) =>
    String(input instanceof Request ? input.url : input).includes("graph.microsoft.com"),
  );

beforeEach(() => {
  stub.headers = new Headers();
  stub.localStatus = 200;
  stub.localExp = nowSec() + 7 * DAY;
  stub.localJwt = fakeStrapiJwt(stub.localExp);
  stub.idClaims = idClaims();
  stub.nonce = undefined;
  stub.idToken = "";
  exchangeExp = nowSec() + 12 * 60 * 60;
  exchangeJwt = fakeStrapiJwt(exchangeExp, 42);
  stub.exchangeAnswers = [exchangeOk()];
  stub.exchangeCalls = [];
  fetchMock.mockClear();
});

// The first import of @/auth transforms next-auth and @auth/core (inlined,
// see vitest.config.ts). Under a full parallel run that cold import alone
// took 3–4.6 s of the first test's 5 s budget and sometimes all of it; pay
// it once here, under the hook timeout. load() then re-evaluates cheaply.
beforeAll(async () => {
  await load();
}, 30_000);

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

  it("Microsoft sign-in: only id, provider and the display fields reach the browser", async () => {
    const mod = await load(ENTRA_ENV);
    const { jar, callback } = await signInMicrosoft(mod);
    expect(callback.status).toBe(302);
    expect(jar.names()).toContain("authjs.session-token");
    const sRes = await getSessionJson(mod, "http://localhost:3000", jar.header());
    const body = (await sRes.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      provider: "microsoft-entra-id",
      user: { id: 42, name: "Grace", email: "grace@example.test" },
    });
    expect(Object.keys(body).sort()).toEqual(["expires", "provider", "user"]);
    expect(JSON.stringify(body)).not.toContain('"image"');
    expectNoStrapiSecrets(body, exchangeJwt);
    expect(JSON.stringify(body)).not.toContain(stub.accessToken);
    expect(JSON.stringify(body)).not.toContain(stub.idToken.split(".")[1]!);
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

describe("Microsoft sign-in (D-ENTRA-01) through @auth/core", () => {
  it("asks the tenant's authorize endpoint for openid profile email User.Read, never offline_access", async () => {
    const mod = await load(ENTRA_ENV);
    const { authorize } = await signInMicrosoft(mod);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      `${LOGIN}/${TENANT}/oauth2/v2.0/authorize`,
    );
    expect(authorize.searchParams.get("client_id")).toBe(CLIENT);
    expect(authorize.searchParams.get("scope")).toBe("openid profile email User.Read");
    expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/callback/microsoft-entra-id",
    );
  });

  it("adds User.Read.All with ENTRA_SYNC_MANAGER=1 (the cms reads /me/manager)", async () => {
    const mod = await load({ ...ENTRA_ENV, ENTRA_SYNC_MANAGER: "1" });
    const { authorize } = await signInMicrosoft(mod);
    expect(authorize.searchParams.get("scope")).toBe(
      "openid profile email User.Read User.Read.All",
    );
  });

  it("exchanges the tokens by POST, hands the result to the jwt callback, and never fetches a photo", async () => {
    const mod = await load(ENTRA_ENV);
    const { jar, callback } = await signInMicrosoft(mod);
    expect(callback.headers.get("location")).toBe("http://localhost:3000/wiki");

    expect(stub.exchangeCalls).toHaveLength(1);
    const [call] = stub.exchangeCalls;
    expect(call.headers.get("x-entra-exchange-secret")).toBe(EXCHANGE_SECRET);
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(call.body)).toEqual({ idToken: stub.idToken, accessToken: stub.accessToken });
    // The tokens travel in the body only: no query string anywhere.
    const exchangeUrls = fetchMock.mock.calls
      .map(([input]) => String(input instanceof Request ? input.url : input))
      .filter((url) => url.startsWith(`${STRAPI}/`));
    expect(exchangeUrls).toEqual([EXCHANGE_URL]);
    // The claims-only profile(): no Graph request at all from the web.
    expect(graphCalls()).toEqual([]);

    const cookie = jar.header().match(/authjs\.session-token=([^;]+)/)?.[1];
    const token = await decode({ token: cookie, secret: SECRET, salt: "authjs.session-token" });
    expect(token).toMatchObject({
      strapiJwt: exchangeJwt,
      strapiUserId: 42,
      strapiJwtExp: exchangeExp,
      name: "Grace",
      email: "grace@example.test",
      provider: "microsoft-entra-id",
    });
    expect(token).not.toHaveProperty("picture");
    expect(JSON.stringify(token)).not.toContain(stub.accessToken);
  });

  it("with a GUID issuer, a token of another tenant fails Auth.js' own iss check (no exchange)", async () => {
    const mod = await load(ENTRA_ENV);
    stub.idClaims = idClaims({ iss: `${LOGIN}/${OTHER_TENANT}/v2.0`, tid: OTHER_TENANT });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { jar, callback } = await signInMicrosoft(mod);
      const location = new URL(callback.headers.get("location") ?? "about:blank");
      expect(location.pathname).toBe("/sign-in");
      expect(location.searchParams.get("error")).toBeTruthy();
      expect(location.searchParams.get("error")).not.toMatch(/^entra_/);
      expect(jar.names()).not.toContain("authjs.session-token");
    } finally {
      consoleError.mockRestore();
    }
    expect(stub.exchangeCalls).toHaveLength(0);
    // The provider's tenant rewrite never fetched the other tenant's metadata.
    const urls = fetchMock.mock.calls.map(([input]) =>
      String(input instanceof Request ? input.url : input),
    );
    expect(urls.some((url) => url.includes(OTHER_TENANT))).toBe(false);
  });

  it("redirects a tid of another tenant to /sign-in?error=entra_tenant (signIn callback)", async () => {
    const mod = await load(ENTRA_ENV);
    stub.idClaims = idClaims({ tid: OTHER_TENANT });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { jar, callback } = await signInMicrosoft(mod);
      expect(callback.headers.get("location")).toBe(
        "http://localhost:3000/sign-in?error=entra_tenant",
      );
      expect(jar.names()).not.toContain("authjs.session-token");
    } finally {
      consoleWarn.mockRestore();
    }
    expect(stub.exchangeCalls).toHaveLength(0);
  });

  const refusals: [string, string, ExchangeAnswer[], number][] = [
    [
      "409 account_exists",
      "entra_account_exists",
      [{ status: 409, body: { error: "account_exists" } }],
      1,
    ],
    [
      "403 not_assigned",
      "entra_not_assigned",
      [{ status: 403, body: { error: "not_assigned" } }],
      1,
    ],
    ["403 blocked", "entra_blocked", [{ status: 403, body: { error: "blocked" } }], 1],
    ["401 invalid", "entra_invalid", [{ status: 401, body: { error: "invalid" } }], 1],
    [
      "401 unauthorized (secret mismatch)",
      "entra_unavailable",
      [{ status: 401, body: { error: "unauthorized" } }],
      1,
    ],
    [
      "404 (Entra off in the cms)",
      "entra_unavailable",
      [{ status: 404, body: { data: null, error: { status: 404 } } }],
      1,
    ],
    ["500, not retried", "entra_unavailable", [{ status: 500, body: {} }], 1],
    ["503 twice", "entra_unavailable", [{ status: 503, body: { error: "unavailable" } }], 2],
    ["a network error twice", "entra_unavailable", ["network-error"], 2],
  ];

  it.each(refusals)(
    "maps %s to /sign-in?error=%s without a session",
    async (_name, code, answers, calls) => {
      const mod = await load(ENTRA_ENV);
      stub.exchangeAnswers = answers;
      const quiet = [vi.spyOn(console, "error"), vi.spyOn(console, "warn")].map((spy) =>
        spy.mockImplementation(() => {}),
      );
      try {
        const { jar, callback } = await signInMicrosoft(mod);
        expect(callback.headers.get("location")).toBe(
          `http://localhost:3000/sign-in?error=${code}`,
        );
        expect(jar.names()).not.toContain("authjs.session-token");
        // No log line carries a token.
        const logged = JSON.stringify(quiet.map((spy) => spy.mock.calls));
        expect(logged).not.toContain(stub.accessToken);
        expect(logged).not.toContain(stub.idToken.split(".")[1]!);
      } finally {
        for (const spy of quiet) spy.mockRestore();
      }
      expect(stub.exchangeCalls).toHaveLength(calls);
    },
    15_000,
  );

  it("retries once after a 503 and signs in when the second attempt succeeds", async () => {
    const mod = await load(ENTRA_ENV);
    stub.exchangeAnswers = [{ status: 503, body: { error: "unavailable" } }, exchangeOk()];
    const { jar, callback } = await signInMicrosoft(mod);
    expect(callback.headers.get("location")).toBe("http://localhost:3000/wiki");
    expect(stub.exchangeCalls).toHaveLength(2);
    expect(jar.names()).toContain("authjs.session-token");
  });

  it("the jwt callback refuses a Microsoft account the signIn callback did not exchange", async () => {
    const mod = await load(ENTRA_ENV);
    await expect(
      mod.callbacks.jwt({
        token: { sub: "x" },
        user: { id: "x" },
        account: { provider: "microsoft-entra-id", type: "oidc", providerAccountId: OID },
      }),
    ).rejects.toThrow(/without an exchange result/);
  });

  it("profile() keeps the claims only: no request, no image, lower-cased e-mail", async () => {
    const mod = await load(ENTRA_ENV);
    fetchMock.mockClear();
    const profile = mod.entraProfile({
      ...idClaims({ email: "Grace.Entra@Example.test" }),
    } as unknown as Parameters<typeof mod.entraProfile>[0]);
    expect(profile).toEqual({
      id: OID,
      name: "Grace Entra",
      email: "grace.entra@example.test",
      image: null,
    });
    expect(
      mod.entraProfile({ ...idClaims({ name: undefined }) } as unknown as Parameters<
        typeof mod.entraProfile
      >[0]),
    ).toEqual({ id: OID, name: "Grace@Example.test", email: "grace@example.test", image: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers no Microsoft provider while ENTRA_ENABLED is not 1, whatever AUTH_MICROSOFT_* holds", async () => {
    for (const flag of [undefined, "0", "true"]) {
      const mod = await load({ ...ENTRA_ENV, ENTRA_ENABLED: flag });
      const res = await mod.handlers.GET(
        new NextRequest("http://localhost:3000/api/auth/providers"),
      );
      expect(Object.keys((await res.json()) as object)).toEqual(["local"]);
    }
    const entraOnly = await load({ ...ENTRA_ENV, AUTH_LOCAL_ENABLED: undefined });
    const res = await entraOnly.handlers.GET(
      new NextRequest("http://localhost:3000/api/auth/providers"),
    );
    expect(Object.keys((await res.json()) as object)).toEqual(["microsoft-entra-id"]);
  });

  it("refuses to load with ENTRA_ENABLED=1 and an invalid configuration, except during next build", async () => {
    await expect(
      load({ ...ENTRA_ENV, AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: "common" }),
    ).rejects.toThrow(/AUTH_MICROSOFT_ENTRA_ID_TENANT_ID/);
    await expect(load({ ...ENTRA_ENV, ENTRA_EXCHANGE_SECRET: "short" })).rejects.toThrow(
      /ENTRA_EXCHANGE_SECRET/,
    );
    const build = await load({
      ...ENTRA_ENV,
      AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: "common",
      NEXT_PHASE: "phase-production-build",
    });
    expect(build.handlers).toBeDefined();
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

  it("a Microsoft session ends at the exchange's expiresAt (ENTRA_SESSION_TTL)", async () => {
    const mod = await load(ENTRA_ENV);
    exchangeExp = nowSec() - 1;
    exchangeJwt = fakeStrapiJwt(exchangeExp, 42);
    stub.exchangeAnswers = [exchangeOk()];
    const { jar } = await signInMicrosoft(mod);
    // The jwt callback refused the already-expired session at sign-in.
    expect(jar.names()).not.toContain("authjs.session-token");
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

describe("DEMO_MODE never runs in production (WD08/WD09)", () => {
  it("refuses to load with DEMO_MODE=1 and NODE_ENV=production, except during next build", async () => {
    await expect(load({ DEMO_MODE: "1", NODE_ENV: "production" })).rejects.toThrow(
      /DEMO_MODE=1 must not be enabled in production/,
    );
    const build = await load({
      DEMO_MODE: "1",
      NODE_ENV: "production",
      NEXT_PHASE: "phase-production-build",
    });
    expect(build.handlers).toBeDefined();
    const dev = await load({ DEMO_MODE: "1", NODE_ENV: "development" });
    expect(dev.handlers).toBeDefined();
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
