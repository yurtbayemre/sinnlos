import { NextRequest } from "next/server";
import { decode } from "next-auth/jwt";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { strapiJwtUpdate } from "./callbacks";

/**
 * The session update after a password change (FX40) through the REAL
 * apps/web/src/auth.ts and Auth.js (@auth/core 0.41.3, next-auth
 * 5.0.0-beta.32): unstable_update() in a Server Action and the browser's
 * own POST /api/auth/session both reach the jwt callback with trigger
 * "update" (lib/auth/callbacks.ts applyStrapiJwtUpdate). Pinned:
 *   1. unstable_update({ strapiJwt }) re-issues the session cookie with the
 *      new Strapi JWT and its exp, through the request's cookie jar;
 *   2. in the same request (Next's re-render after a Server Action that set
 *      a cookie: cookies() updated, headers() as it arrived),
 *      getStrapiToken() already reads the new JWT (lib/strapi-token.ts
 *      withJarCookies), never the revoked one of the Cookie header;
 *   3. a JWT of another user is refused on both paths, so no session can be
 *      made to carry someone else's token;
 *   4. the browser's POST cannot store a JWT it made up for its own user,
 *      whatever its exp: only the server's update carries the proof
 *      (strapiJwtUpdate, an HMAC under AUTH_SECRET);
 *   5. an ended session (its Strapi JWT expired) is not revived by an
 *      update, not even by the server's.
 * Only the network (Strapi's /api/auth/local) and next/headers are stubbed:
 * `headers()` is the incoming request, `cookies()` a jar that starts with
 * its cookies and takes the action's writes, as in Next.
 */
const SECRET = "vitest-auth-secret-0123456789-abcdefghijklmnop";
const STRAPI = "http://strapi.test";
const BASE = "http://localhost:3000";
const COOKIE = "authjs.session-token";
const DAY = 24 * 60 * 60;
const nowSec = () => Math.floor(Date.now() / 1000);

/** A Strapi-shaped JWT (unsigned for the web: only id and exp are decoded). */
function fakeStrapiJwt(id: number, exp: number, tv = 0): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ id, tv, iat: exp - 7 * DAY, exp })}.sig-${id}-${tv}`;
}

const stub = vi.hoisted(() => ({
  headers: new Headers(),
  jar: new Map<string, string>(),
  localJwt: "",
}));

vi.mock("next/headers", () => ({
  headers: async () => stub.headers,
  cookies: async () => ({
    get: (name: string) => (stub.jar.has(name) ? { name, value: stub.jar.get(name) } : undefined),
    getAll: () => [...stub.jar].map(([name, value]) => ({ name, value })),
    has: (name: string) => stub.jar.has(name),
    set: (name: string, value: string, options?: { maxAge?: number; expires?: Date }) => {
      const expired =
        value === "" ||
        options?.maxAge === 0 ||
        (options?.expires instanceof Date && options.expires.getTime() <= Date.now());
      if (expired) stub.jar.delete(name);
      else stub.jar.set(name, value);
    },
  }),
}));

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = (input instanceof Request ? input : new Request(input, init)).url;
    if (url === `${STRAPI}/api/auth/local`) {
      return Response.json({ jwt: stub.localJwt, user: { id: 7, username: "ada" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }),
);

async function load() {
  vi.resetModules();
  delete (globalThis as { __sinnlosLoginRateLimiter?: unknown }).__sinnlosLoginRateLimiter;
  const env: Record<string, string | undefined> = {
    AUTH_SECRET: SECRET,
    NEXTAUTH_SECRET: undefined,
    AUTH_URL: undefined,
    NEXTAUTH_URL: undefined,
    STRAPI_URL: STRAPI,
    AUTH_LOCAL_ENABLED: "1",
    ENTRA_ENABLED: undefined,
    DEMO_MODE: undefined,
    NEXT_PHASE: undefined,
    NODE_ENV: "test",
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return { ...(await import("@/auth")), ...(await import("@/lib/session")) };
}

type Loaded = Awaited<ReturnType<typeof load>>;

/** Set-Cookie pairs of a response, applied to `jar`. */
function absorb(jar: Map<string, string>, res: Response) {
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(";")[0] ?? "";
    const i = pair.indexOf("=");
    const [name, value] = [pair.slice(0, i), pair.slice(i + 1)];
    if (value === "") jar.delete(name);
    else jar.set(name, value);
  }
}

const cookieHeader = (jar: Map<string, string>) =>
  [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

/** Signs in through the credentials callback; returns the browser's cookie jar. */
async function signIn(mod: Loaded): Promise<Map<string, string>> {
  const jar = new Map<string, string>();
  const csrf = await mod.handlers.GET(new NextRequest(`${BASE}/api/auth/csrf`));
  absorb(jar, csrf);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const res = await mod.handlers.POST(
    new NextRequest(`${BASE}/api/auth/callback/local`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader(jar) },
      body: new URLSearchParams({ csrfToken, identifier: "ada@example.test", password: "pw" }),
    }),
  );
  absorb(jar, res);
  expect(jar.has(COOKIE)).toBe(true);
  return jar;
}

/** Makes `jar` the incoming request of a Server Action (headers() and cookies()). */
function asActionRequest(jar: Map<string, string>) {
  stub.headers = new Headers({
    cookie: cookieHeader(jar),
    host: new URL(BASE).host,
    "x-forwarded-proto": "http",
  });
  stub.jar = new Map(jar);
}

/** The token in the session cookie `value`. */
const sessionToken = async (value: string | undefined) =>
  decode({ token: value, secret: SECRET, salt: COOKIE });

/** unstable_update() as lib/profile-actions.ts calls it: the JWT with the server's proof. */
const serverUpdate = (mod: Loaded, jwt: string) =>
  mod.unstable_update(
    strapiJwtUpdate(jwt, SECRET) as unknown as Parameters<typeof mod.unstable_update>[0],
  );

// The first import of @/auth transforms next-auth and @auth/core (inlined,
// vitest.config.ts): seconds under a full parallel run. Paid once here,
// under the hook timeout, as in auth.test.ts; load() then re-evaluates.
beforeAll(async () => {
  await load();
}, 30_000);

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  stub.localJwt = fakeStrapiJwt(7, nowSec() + 7 * DAY);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("unstable_update after a password change (Server Action)", () => {
  it("re-issues the session cookie with the new JWT, and the same request reads it", async () => {
    const mod = await load();
    asActionRequest(await signIn(mod));
    expect(await mod.getStrapiToken()).toBe(stub.localJwt);

    const exp = nowSec() + 7 * DAY + 60;
    const fresh = fakeStrapiJwt(7, exp, 1);
    await serverUpdate(mod, fresh);

    const token = await sessionToken(stub.jar.get(COOKIE));
    expect(token).toMatchObject({ strapiJwt: fresh, strapiJwtExp: exp, strapiUserId: 7 });
    // The re-render of this request: the Cookie header still has the old
    // session, the jar the new one; the token comes from the jar.
    expect(stub.headers.get("cookie")).toContain(`${COOKIE}=`);
    expect(await mod.getStrapiToken()).toBe(fresh);
  });

  it("refuses a JWT of another user: the session keeps its own", async () => {
    const mod = await load();
    asActionRequest(await signIn(mod));
    await serverUpdate(mod, fakeStrapiJwt(8, nowSec() + DAY, 1));
    expect(await sessionToken(stub.jar.get(COOKIE))).toMatchObject({
      strapiJwt: stub.localJwt,
      strapiUserId: 7,
    });
    expect(await mod.getStrapiToken()).toBe(stub.localJwt);
  });

  it("does not revive an ended session: it stays signed out", async () => {
    stub.localJwt = fakeStrapiJwt(7, nowSec() + 60);
    const mod = await load();
    asActionRequest(await signIn(mod));
    expect(await mod.getStrapiToken()).toBe(stub.localJwt);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // The session's Strapi JWT has expired by now.
      vi.setSystemTime(Date.now() + 2 * 60_000);
      await serverUpdate(mod, fakeStrapiJwt(7, nowSec() + 7 * DAY, 1));
      expect(stub.jar.has(COOKIE)).toBe(false);
      expect(await mod.getStrapiToken()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("POST /api/auth/session from the browser (the same trigger)", () => {
  async function browserUpdate(mod: Loaded, jar: Map<string, string>, data: unknown) {
    const csrf = await mod.handlers.GET(
      new NextRequest(`${BASE}/api/auth/csrf`, { headers: { cookie: cookieHeader(jar) } }),
    );
    absorb(jar, csrf);
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    const res = await mod.handlers.POST(
      new NextRequest(`${BASE}/api/auth/session`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookieHeader(jar) },
        body: JSON.stringify({ csrfToken, data }),
      }),
    );
    absorb(jar, res);
    return res;
  }

  it("cannot put another user's JWT into the session", async () => {
    const mod = await load();
    const jar = await signIn(mod);
    const res = await browserUpdate(mod, jar, { strapiJwt: fakeStrapiJwt(8, nowSec() + DAY) });
    expect(res.status).toBe(200);
    expect(await sessionToken(jar.get(COOKIE))).toMatchObject({
      strapiJwt: stub.localJwt,
      strapiUserId: 7,
    });
    // Nor does the answer (the public session) ever carry a JWT.
    expect(JSON.stringify(await res.json())).not.toContain("sig-");
  });

  it("cannot put a JWT it made up for its own user into the session, whatever its exp", async () => {
    const mod = await load();
    const jar = await signIn(mod);
    const forged = fakeStrapiJwt(7, nowSec() + 365 * DAY, 99);
    for (const data of [
      { strapiJwt: forged },
      { strapiJwt: forged, proof: "A".repeat(43) },
      // A proof of another JWT (the browser never sees one, but still).
      { strapiJwt: forged, proof: strapiJwtUpdate(stub.localJwt, SECRET)?.proof },
    ]) {
      const res = await browserUpdate(mod, jar, data);
      expect(res.status).toBe(200);
      expect(await sessionToken(jar.get(COOKIE))).toMatchObject({
        strapiJwt: stub.localJwt,
        strapiUserId: 7,
      });
    }
    expect(console.warn).toHaveBeenCalledWith(
      "[auth] session update refused: not a server-signed current Strapi JWT of this local session",
    );
  });
});
