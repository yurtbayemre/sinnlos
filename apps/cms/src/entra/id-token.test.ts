import {
  SignJWT,
  UnsecuredJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
} from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { entraIssuer, entraJwksUrl } from "./config";
import { verifyIdToken } from "./id-token";

/**
 * D-ENTRA-01 spec E: the cms verifies the Microsoft ID token itself. A
 * local RSA key pair stands in for the tenant's signing key; fake GUIDs
 * only.
 */
const TENANT = "11111111-2222-4333-8444-555555555555";
const OTHER_TENANT = "99999999-8888-4777-8666-555555555555";
const CLIENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OID = "0f0f0f0f-1e1e-4d2d-8c3c-4b4b4b4b4b4b";
const KID = "test-key-1";

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let signing: KeyPair;
let stranger: KeyPair;
let jwks: { keys: JWK[] };

beforeAll(async () => {
  signing = await generateKeyPair("RS256");
  stranger = await generateKeyPair("RS256");
  jwks = {
    keys: [{ ...(await exportJWK(signing.publicKey)), kid: KID, alg: "RS256", use: "sig" }],
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const nowSec = () => Math.floor(Date.now() / 1000);

function claims(overrides: JWTPayload = {}): JWTPayload {
  const iat = nowSec() - 30;
  return {
    iss: entraIssuer(TENANT),
    aud: CLIENT,
    tid: TENANT,
    oid: OID.toUpperCase(),
    iat,
    nbf: iat,
    exp: iat + 3600,
    name: "Ada Lovelace",
    email: "Ada@Example.test",
    preferred_username: "ada@example.test",
    roles: ["Intranet.Editor", 42, "Intranet.Member"],
    ...overrides,
  };
}

async function sign(
  payload: JWTPayload,
  key: KeyPair["privateKey"] = signing.privateKey,
  kid = KID,
) {
  return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid, typ: "JWT" }).sign(key);
}

const config = { tenantId: TENANT, clientId: CLIENT };
const keys = () => createLocalJWKSet(jwks);

describe("verifyIdToken", () => {
  it("accepts a valid token and returns the normalised claims", async () => {
    const result = await verifyIdToken(await sign(claims()), config, { keys: keys() });
    expect(result).toEqual({
      ok: true,
      claims: {
        tid: TENANT,
        oid: OID,
        name: "Ada Lovelace",
        email: "Ada@Example.test",
        preferredUsername: "ada@example.test",
        roles: ["Intranet.Editor", "Intranet.Member"],
      },
    });
  });

  it("accepts a token without roles, name or e-mail", async () => {
    const token = await sign(claims({ roles: undefined, name: undefined, email: undefined }));
    const result = await verifyIdToken(token, config, { keys: keys() });
    expect(result).toMatchObject({ ok: true, claims: { roles: [], name: null, email: null } });
  });

  const invalid: [string, () => Promise<string>][] = [
    ["a wrong audience", () => sign(claims({ aud: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }))],
    ["a wrong issuer", () => sign(claims({ iss: entraIssuer(OTHER_TENANT) }))],
    [
      "the multi-tenant issuer",
      () => sign(claims({ iss: "https://login.microsoftonline.com/common/v2.0" })),
    ],
    ["a tid of another tenant", () => sign(claims({ tid: OTHER_TENANT }))],
    [
      "an expired token",
      () => sign(claims({ iat: nowSec() - 7200, nbf: nowSec() - 7200, exp: nowSec() - 3600 })),
    ],
    [
      "an iat older than 10 minutes",
      () => sign(claims({ iat: nowSec() - 16 * 60, nbf: nowSec() - 16 * 60 })),
    ],
    ["a missing oid", () => sign(claims({ oid: undefined }))],
    ["a missing tid", () => sign(claims({ tid: undefined }))],
    ["a missing iat", () => sign(claims({ iat: undefined }))],
    ["an oid that is not a GUID", () => sign(claims({ oid: "not-a-guid" }))],
    ["alg none", async () => new UnsecuredJWT(claims()).encode()],
    [
      "HS256",
      () =>
        new SignJWT(claims())
          .setProtectedHeader({ alg: "HS256", kid: KID })
          .sign(new TextEncoder().encode("0123456789abcdef0123456789abcdef")),
    ],
    ["a bad signature", () => sign(claims(), stranger.privateKey)],
    [
      "a tampered payload",
      async () => {
        const [header, , signature] = (await sign(claims())).split(".");
        const payload = Buffer.from(
          JSON.stringify(claims({ oid: OID.replace("0f", "1f") })),
        ).toString("base64url");
        return `${header}.${payload}.${signature}`;
      },
    ],
    ["an unknown key id", () => sign(claims(), stranger.privateKey, "rotated-away")],
    ["garbage", async () => "not.a.jwt"],
  ];

  it.each(invalid)("refuses %s as invalid", async (_name, token) => {
    const result = await verifyIdToken(await token(), config, { keys: keys() });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("allows five minutes of clock skew", async () => {
    const future = nowSec() + 4 * 60;
    const token = await sign(claims({ iat: future, nbf: future, exp: future + 3600 }));
    expect(await verifyIdToken(token, config, { keys: keys() })).toMatchObject({ ok: true });
  });

  it("maps a key lookup failure to unavailable, not invalid", async () => {
    const failing = async () => {
      throw new TypeError("fetch failed");
    };
    const result = await verifyIdToken(await sign(claims()), config, { keys: failing });
    expect(result).toEqual({ ok: false, reason: "unavailable", detail: "jwks TypeError" });
  });

  it("never puts the token into the result", async () => {
    const token = await sign(claims({ aud: "someone-else" }));
    const result = await verifyIdToken(token, config, { keys: keys() });
    expect(JSON.stringify(result)).not.toContain(token.split(".")[2]);
  });
});

describe("verifyIdToken against the tenant's key set", () => {
  // One tenant per case: the remote key set is cached per process and tenant.
  const tenant = (n: number) => `11111111-2222-4333-8444-${String(n).padStart(12, "0")}`;

  it("fetches the keys from the tenant's discovery URL", async () => {
    const t = tenant(1);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input instanceof Request ? input.url : input)).toBe(entraJwksUrl(t));
      return Response.json(jwks);
    });
    vi.stubGlobal("fetch", fetchMock);
    const token = await sign(claims({ iss: entraIssuer(t), tid: t }));
    expect(await verifyIdToken(token, { tenantId: t, clientId: CLIENT })).toMatchObject({
      ok: true,
    });
    expect(await verifyIdToken(token, { tenantId: t, clientId: CLIENT })).toMatchObject({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a network error", async () => Promise.reject(new TypeError("fetch failed"))],
    ["a 500", async () => new Response("down", { status: 500 })],
    ["a non-JSON body", async () => new Response("<html>", { status: 200 })],
    ["a body without keys", async () => Response.json({ nope: true })],
  ])("answers unavailable on %s", async (_name, answer) => {
    const t = tenant(2 + Math.floor(Math.random() * 1_000_000));
    vi.stubGlobal("fetch", vi.fn(answer));
    const token = await sign(claims({ iss: entraIssuer(t), tid: t }));
    expect(await verifyIdToken(token, { tenantId: t, clientId: CLIENT })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
  });
});
