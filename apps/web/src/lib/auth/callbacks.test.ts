import type { Account, Profile } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EntraWebConfig } from "@/lib/auth-config";
import type { EntraExchangeResult, exchangeEntraSignIn } from "@/lib/entra-exchange";
import {
  applyStrapiJwtUpdate,
  createAuthCallbacks,
  ENTRA_PROVIDER_ID,
  signInError,
} from "./callbacks";

/**
 * The Auth.js callbacks without Auth.js (WD09); auth.test.ts drives the same
 * code through the real handlers. Pins:
 *   - signIn: local sign-ins pass; a Microsoft sign-in needs Entra on, the
 *     configured tenant and both tokens, then the cms exchange; each refusal
 *     is an entra_* redirect (batch 9);
 *   - the WeakMap hand-off: jwt gets exactly the exchange result of the same
 *     `account`, once, and refuses an account signIn did not exchange;
 *   - the session ends with the Strapi JWT (batch 10): an expired or
 *     missing JWT makes jwt answer null;
 *   - the session update after a password change (FX40): a local session
 *     takes a current JWT of its own user, nothing else;
 *   - session copies only id and provider.
 */
const TENANT = "11111111-2222-4333-8444-555555555555";
const nowSec = () => Math.floor(Date.now() / 1000);

const ENTRA: EntraWebConfig = {
  tenantId: TENANT,
  clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  clientSecret: "client-secret",
  exchangeSecret: "exchange-secret-0123456789abcdef0123",
  syncManager: false,
  issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  scope: "openid profile email User.Read",
};

function fakeStrapiJwt(exp: number, id = 42): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ id, exp })}.sig`;
}

const account = (overrides: Partial<Account> = {}): Account => ({
  provider: ENTRA_PROVIDER_ID,
  type: "oidc",
  providerAccountId: "oid",
  id_token: "id-token",
  access_token: "access-token",
  ...overrides,
});

const exchangeOk = (exp = nowSec() + 3600): EntraExchangeResult => ({
  ok: true,
  data: {
    jwt: fakeStrapiJwt(exp),
    expiresAt: exp,
    user: { id: 42, displayName: "Grace", email: "grace@example.test" },
  },
});

let exchange: ReturnType<typeof vi.fn<typeof exchangeEntraSignIn>>;

const callbacksWith = (entra: EntraWebConfig | null = ENTRA) =>
  createAuthCallbacks({ entra, strapiUrl: "http://strapi.test", exchange });

type SignInArgs = Parameters<ReturnType<typeof createAuthCallbacks>["signIn"]>[0];
type JwtArgs = Parameters<ReturnType<typeof createAuthCallbacks>["jwt"]>[0];
type SessionArgs = Parameters<ReturnType<typeof createAuthCallbacks>["session"]>[0];

const signInArgs = (acc: Account | null, profile?: Profile) =>
  ({ account: acc, profile, user: { id: "x" } }) as unknown as SignInArgs;
const jwtArgs = (token: JWT, extra: Partial<JwtArgs> = {}) => ({ token, ...extra }) as JwtArgs;

beforeEach(() => {
  exchange = vi.fn<typeof exchangeEntraSignIn>(async () => exchangeOk());
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signIn", () => {
  it("passes a local sign-in without an exchange", async () => {
    const callbacks = callbacksWith();
    await expect(callbacks.signIn(signInArgs(account({ provider: "local" })))).resolves.toBe(true);
    expect(exchange).not.toHaveBeenCalled();
  });

  it("exchanges a Microsoft sign-in of the configured tenant (case-insensitive tid)", async () => {
    const callbacks = callbacksWith();
    await expect(
      callbacks.signIn(signInArgs(account(), { tid: TENANT.toUpperCase() })),
    ).resolves.toBe(true);
    expect(exchange).toHaveBeenCalledWith(
      { idToken: "id-token", accessToken: "access-token" },
      { strapiUrl: "http://strapi.test", secret: ENTRA.exchangeSecret },
    );
  });

  it.each([
    ["Entra switched off", null, account(), { tid: TENANT }, "entra_unavailable"],
    [
      "another tenant",
      ENTRA,
      account(),
      { tid: "99999999-8888-4777-8666-555555555555" },
      "entra_tenant",
    ],
    ["no tid", ENTRA, account(), {}, "entra_tenant"],
    ["no ID token", ENTRA, account({ id_token: undefined }), { tid: TENANT }, "entra_unavailable"],
    [
      "no access token",
      ENTRA,
      account({ access_token: undefined }),
      { tid: TENANT },
      "entra_unavailable",
    ],
  ] as const)("refuses %s with a redirect", async (_label, entra, acc, profile, code) => {
    const callbacks = callbacksWith(entra);
    await expect(callbacks.signIn(signInArgs(acc, profile as Profile))).resolves.toBe(
      signInError(code),
    );
    expect(exchange).not.toHaveBeenCalled();
  });

  it("turns an exchange refusal into its entra_* redirect", async () => {
    exchange.mockResolvedValue({ ok: false, code: "not_assigned" });
    const callbacks = callbacksWith();
    await expect(callbacks.signIn(signInArgs(account(), { tid: TENANT }))).resolves.toBe(
      "/sign-in?error=entra_not_assigned",
    );
  });
});

describe("jwt", () => {
  it("takes the exchange result of the same account, once (WeakMap hand-off)", async () => {
    const callbacks = callbacksWith();
    const acc = account();
    await callbacks.signIn(signInArgs(acc, { tid: TENANT }));
    const token = await callbacks.jwt(
      jwtArgs({ sub: "x", picture: "https://graph/photo" }, { account: acc }),
    );
    expect(token).toMatchObject({
      strapiUserId: 42,
      name: "Grace",
      email: "grace@example.test",
      provider: ENTRA_PROVIDER_ID,
    });
    expect(token).not.toHaveProperty("picture");
    // The entry is gone after the first read.
    await expect(callbacks.jwt(jwtArgs({ sub: "x" }, { account: acc }))).rejects.toThrow(
      /without an exchange result/,
    );
  });

  it("refuses a Microsoft account signIn did not exchange, also from another instance", async () => {
    const acc = account();
    await callbacksWith().signIn(signInArgs(acc, { tid: TENANT }));
    await expect(callbacksWith().jwt(jwtArgs({ sub: "x" }, { account: acc }))).rejects.toThrow(
      /without an exchange result/,
    );
  });

  it("stores the local sign-in's JWT and its exp", async () => {
    const exp = nowSec() + 7 * 24 * 3600;
    const jwt = fakeStrapiJwt(exp);
    const token = await callbacksWith().jwt(
      jwtArgs({ sub: "7" }, { user: { id: "7", strapiJwt: jwt, strapiUserId: 7 } }),
    );
    expect(token).toMatchObject({
      strapiJwt: jwt,
      strapiUserId: 7,
      strapiJwtExp: exp,
      provider: "local",
    });
  });

  it("ends the session with the Strapi JWT: expired or missing answers null", async () => {
    const callbacks = callbacksWith();
    const expired = fakeStrapiJwt(nowSec() - 5);
    await expect(
      callbacks.jwt(jwtArgs({ sub: "7" }, { user: { id: "7", strapiJwt: expired } })),
    ).resolves.toBeNull();
    await expect(
      callbacks.jwt(jwtArgs({ strapiJwt: expired, strapiJwtExp: nowSec() - 5 })),
    ).resolves.toBeNull();
    await expect(callbacks.jwt(jwtArgs({ name: "no jwt" }))).resolves.toBeNull();
    const live = fakeStrapiJwt(nowSec() + 60);
    await expect(
      callbacks.jwt(jwtArgs({ strapiJwt: live, strapiJwtExp: nowSec() + 60 })),
    ).resolves.toMatchObject({ strapiJwt: live });
  });

  it("refuses a Microsoft sign-in whose exchanged JWT is already expired", async () => {
    exchange.mockResolvedValue(exchangeOk(nowSec() - 1));
    const callbacks = callbacksWith();
    const acc = account();
    await callbacks.signIn(signInArgs(acc, { tid: TENANT }));
    await expect(callbacks.jwt(jwtArgs({ sub: "x" }, { account: acc }))).resolves.toBeNull();
  });
});

describe("jwt: the session update after a password change (FX40)", () => {
  const oldExp = nowSec() + 3600;
  const localToken = (): JWT => ({
    sub: "7",
    strapiJwt: fakeStrapiJwt(oldExp, 7),
    strapiJwtExp: oldExp,
    strapiUserId: 7,
    provider: "local",
  });
  const update = (token: JWT, session: unknown) =>
    callbacksWith().jwt(jwtArgs(token, { trigger: "update", session }));

  it("takes a current JWT of the session's own user, with its exp", async () => {
    const exp = nowSec() + 7 * 24 * 3600;
    const fresh = fakeStrapiJwt(exp, 7);
    await expect(update(localToken(), { strapiJwt: fresh })).resolves.toMatchObject({
      strapiJwt: fresh,
      strapiJwtExp: exp,
      strapiUserId: 7,
      provider: "local",
    });
  });

  it("keeps the token as it was for anything else", async () => {
    const before = localToken();
    for (const session of [
      { strapiJwt: fakeStrapiJwt(nowSec() + 3600, 8) }, // another user
      { strapiJwt: fakeStrapiJwt(nowSec() - 1, 7) }, // expired
      { strapiJwt: "not-a-jwt" },
      { strapiJwt: "" },
      { strapiJwt: 7 },
    ]) {
      await expect(update(localToken(), session), JSON.stringify(session)).resolves.toEqual(before);
    }
    // An update that names no JWT (e.g. a client's session refresh) is no update at all.
    await expect(update(localToken(), { user: { name: "x" } })).resolves.toEqual(before);
    await expect(update(localToken(), undefined)).resolves.toEqual(before);
    expect(console.warn).toHaveBeenCalledWith(
      "[auth] session update refused: not a current Strapi JWT of this local session",
    );
  });

  it("never gives a Microsoft session the local JWT: it keeps ENTRA_SESSION_TTL", async () => {
    const entra: JWT = { ...localToken(), provider: ENTRA_PROVIDER_ID };
    const fresh = fakeStrapiJwt(nowSec() + 7 * 24 * 3600, 7);
    await expect(update({ ...entra }, { strapiJwt: fresh })).resolves.toEqual(entra);
  });

  it("applyStrapiJwtUpdate says whether it took the JWT", () => {
    const token = localToken();
    const fresh = fakeStrapiJwt(nowSec() + 60, 7);
    expect(applyStrapiJwtUpdate(token, { strapiJwt: fresh })).toBe(true);
    expect(token.strapiJwt).toBe(fresh);
    expect(applyStrapiJwtUpdate(token, { strapiJwt: fakeStrapiJwt(nowSec() + 60, 9) })).toBe(false);
    expect(token.strapiJwt).toBe(fresh);
  });
});

describe("session", () => {
  it("copies only id and provider onto the public session", async () => {
    const session = await callbacksWith().session({
      session: { user: { name: "Ada", email: "ada@example.test" }, expires: "2026-10-01" },
      token: {
        strapiJwt: "secret.jwt.value",
        strapiUserId: 7,
        strapiJwtExp: 123,
        provider: "local",
      },
    } as unknown as SessionArgs);
    expect(session).toEqual({
      user: { name: "Ada", email: "ada@example.test", id: 7 },
      expires: "2026-10-01",
      provider: "local",
    });
    expect(JSON.stringify(session)).not.toContain("secret.jwt.value");
  });
});
