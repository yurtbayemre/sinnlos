import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { parseOidcConfig, type OidcConfig } from "./config";
import {
  claimAt,
  departmentValue,
  discover,
  discoveryUrl,
  roleNames,
  sameIssuer,
  verifyOidcIdToken,
  type Discovery,
} from "./id-token";

/**
 * The OIDC ID-token check (v0.25.0, plan-oidc.md findings 3, 8, 10, Codex
 * S2, S4): a local key set stands in for the issuer's. Made-up URLs only.
 */
const ISSUER = "https://idp.example/realms/intranet";
const CLIENT = "sinnlos-web";
const ORG = "396173383835910147";
const DISCOVERY: Discovery = { issuer: ISSUER, jwksUri: `${ISSUER}/protocol/openid-connect/certs` };

function config(env: Record<string, string> = {}): OidcConfig {
  const settings = parseOidcConfig({
    OIDC_ENABLED: "1",
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: CLIENT,
    OIDC_EXCHANGE_SECRET: "0123456789abcdef0123456789abcdef",
    ...env,
  });
  if (!settings.enabled) throw new Error("expected enabled");
  return settings;
}

let rsa: Awaited<ReturnType<typeof generateKeyPair>>;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  rsa = await generateKeyPair("RS256");
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(rsa.publicKey)), kid: "k1", alg: "RS256", use: "sig" }],
  });
});

async function token(claims: JWTPayload = {}, drop: string[] = []): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    iss: ISSUER,
    aud: CLIENT,
    sub: "Ab12-CaseKept",
    iat: now - 5,
    exp: now + 300,
    email: "Pat@Example.TEST",
    email_verified: true,
    name: "Pat Example",
    roles: ["Intranet.Editor"],
    ...claims,
  };
  for (const key of drop) delete payload[key];
  return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "k1" }).sign(rsa.privateKey);
}

const verify = (idToken: string, settings = config()) =>
  verifyOidcIdToken(idToken, settings, { discovery: DISCOVERY, keys });

describe("verifyOidcIdToken", () => {
  it("returns the identity exactly, the e-mail lower-cased, the roles and no department by default", async () => {
    expect(await verify(await token())).toEqual({
      ok: true,
      claims: {
        issuer: ISSUER,
        subject: "Ab12-CaseKept",
        email: "pat@example.test",
        name: "Pat Example",
        roles: ["Intranet.Editor"],
        department: null,
      },
    });
  });

  it("refuses HS256 (the client secret as key) and every symmetric algorithm", async () => {
    const hs = await new SignJWT({ sub: "x", email: "x@example.test", email_verified: true })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("client-secret-client-secret-client-secret"));
    expect(await verify(hs)).toEqual({
      ok: false,
      reason: "invalid",
      detail: "ERR_JOSE_ALG_NOT_ALLOWED",
    });
  });

  it("compares iss exactly with the discovery document's issuer (no slash tolerance)", async () => {
    const slash = await verify(await token({ iss: `${ISSUER}/` }));
    expect(slash).toMatchObject({
      ok: false,
      reason: "invalid",
      detail: "ERR_JWT_CLAIM_VALIDATION_FAILED",
    });
  });

  it("requires exp, a string sub and the client as audience", async () => {
    for (const idToken of [
      await token({}, ["exp"]),
      await token({}, ["sub"]),
      await token({ aud: "another-client" }),
    ]) {
      expect(await verify(idToken)).toMatchObject({ ok: false, reason: "invalid" });
    }
    expect(await verify(await token({ sub: "" }))).toMatchObject({ ok: false, reason: "invalid" });
    expect(await verify(await token({ sub: 12345 as unknown as string }))).toMatchObject({
      ok: false,
      detail: "sub",
    });
    expect(await verify(await token({ sub: "x".repeat(256) }))).toMatchObject({
      ok: false,
      detail: "sub",
    });
  });

  it("checks azp: required with several audiences, refused when it names another client", async () => {
    expect(await verify(await token({ aud: [CLIENT, "other"] }))).toMatchObject({
      ok: false,
      detail: "azp",
    });
    expect(await verify(await token({ aud: [CLIENT, "other"], azp: CLIENT }))).toMatchObject({
      ok: true,
    });
    expect(await verify(await token({ azp: "other" }))).toMatchObject({ ok: false, detail: "azp" });
    expect(await verify(await token({ azp: CLIENT }))).toMatchObject({ ok: true });
  });

  it("needs an e-mail address with email_verified exactly true", async () => {
    for (const claims of [
      { email_verified: false },
      { email_verified: "true" },
      { email_verified: undefined },
      { email: undefined },
      { email: "  " },
    ]) {
      expect(await verify(await token(claims as JWTPayload))).toEqual({
        ok: false,
        reason: "email_unverified",
        detail: "email_verified",
      });
    }
  });

  it("Zitadel: refuses another organisation and counts only roles granted by its own", async () => {
    const zitadel = config({
      OIDC_ROLES_CLAIM: "urn:zitadel:iam:org:project:roles",
      OIDC_ZITADEL_ORG_ID: ORG,
    });
    const roles = {
      "Intranet.Admin": { "999": "fremd.example" },
      "Intranet.Member": { [ORG]: "spike.example" },
    };
    const own = await token({
      "urn:zitadel:iam:org:project:roles": roles,
      "urn:zitadel:iam:user:resourceowner:id": ORG,
    });
    expect(await verify(own, zitadel)).toMatchObject({
      ok: true,
      claims: { roles: ["Intranet.Member"] },
    });
    const foreign = await token({
      "urn:zitadel:iam:org:project:roles": { "Intranet.Admin": { "999": "fremd.example" } },
      "urn:zitadel:iam:user:resourceowner:id": "999",
    });
    expect(await verify(foreign, zitadel)).toEqual({
      ok: false,
      reason: "foreign_org",
      detail: "resourceowner",
    });
    expect(await verify(await token({}), zitadel)).toMatchObject({ reason: "foreign_org" });
  });

  it("reads the department claim, base64url-decoded under Zitadel's metadata", async () => {
    const plain = config({ OIDC_DEPARTMENT_CLAIM: "department" });
    expect(await verify(await token({ department: "Finance" }), plain)).toMatchObject({
      claims: { department: "Finance" },
    });
    const metadata = config({ OIDC_DEPARTMENT_CLAIM: "urn:zitadel:iam:user:metadata.department" });
    const encoded = await token({
      "urn:zitadel:iam:user:metadata": { department: "RmluYW5jZQ" },
    });
    expect(await verify(encoded, metadata)).toMatchObject({ claims: { department: "Finance" } });
  });
});

describe("claim helpers", () => {
  it("claimAt follows a dotted path", () => {
    const payload = { resource_access: { "sinnlos-web": { roles: ["Intranet.Admin"] } } };
    expect(claimAt(payload, ["resource_access", "sinnlos-web", "roles"])).toEqual([
      "Intranet.Admin",
    ]);
    expect(claimAt(payload, ["resource_access", "missing", "roles"])).toBeUndefined();
  });

  it("roleNames takes arrays of strings or object keys, filtered by the organisation", () => {
    expect(roleNames(["a", 1, "b"], null)).toEqual(["a", "b"]);
    expect(roleNames({ a: {}, b: { "1": "x" } }, null)).toEqual(["a", "b"]);
    expect(roleNames({ a: {}, b: { "1": "x" } }, "1")).toEqual(["b"]);
    expect(roleNames(["a"], "1")).toEqual([]);
    expect(roleNames("a", null)).toEqual([]);
  });

  it("departmentValue decodes base64 and base64url, and drops a value that is neither", () => {
    const at = (value: string) =>
      departmentValue({ "urn:zitadel:iam:user:metadata": { d: value } }, [
        "urn:zitadel:iam:user:metadata",
        "d",
      ]);
    expect(at("RmluYW5jZQ")).toBe("Finance");
    expect(at("RmluYW5jZQ==")).toBe("Finance");
    expect(at(Buffer.from("Büro/Ost?>").toString("base64"))).toBe("Büro/Ost?>");
    expect(at("not base64!")).toBeNull();
    expect(departmentValue({ d: 5 }, ["d"])).toBeNull();
    expect(departmentValue({ d: "x" }, null)).toBeNull();
  });
});

describe("discover", () => {
  const answer = (body: unknown, status = 200) =>
    (async () => Response.json(body, { status })) as unknown as typeof fetch;

  it("builds the URL like Auth.js and compares the issuer after URL normalisation", async () => {
    expect(discoveryUrl("https://a.example/application/o/x/")).toBe(
      "https://a.example/application/o/x/.well-known/openid-configuration",
    );
    expect(discoveryUrl("https://a.example")).toBe(
      "https://a.example/.well-known/openid-configuration",
    );
    expect(sameIssuer("https://z.example", "https://z.example/")).toBe(true);
    expect(sameIssuer("https://k.example/realms/x", "https://k.example/realms/x/")).toBe(false);

    const origin = { issuer: "https://zitadel-a.example/", allowHttp: false };
    expect(
      await discover(
        origin,
        answer({
          issuer: "https://zitadel-a.example",
          jwks_uri: "https://zitadel-a.example/oauth/v2/keys",
        }),
      ),
    ).toEqual({
      ok: true,
      discovery: {
        issuer: "https://zitadel-a.example",
        jwksUri: "https://zitadel-a.example/oauth/v2/keys",
      },
    });
  });

  it("names both values on a path mismatch, refuses http keys and answers network failures", async () => {
    const mismatch = await discover(
      { issuer: "https://keycloak-b.example/realms/x/", allowHttp: false },
      answer({
        issuer: "https://keycloak-b.example/realms/x",
        jwks_uri: "https://keycloak-b.example/certs",
      }),
    );
    expect(mismatch).toEqual({
      ok: false,
      detail:
        "the discovery document's issuer https://keycloak-b.example/realms/x is not OIDC_ISSUER https://keycloak-b.example/realms/x/",
    });
    expect(
      await discover(
        { issuer: "https://keycloak-c.example/realms/x", allowHttp: false },
        answer({
          issuer: "https://keycloak-c.example/realms/x",
          jwks_uri: "http://keycloak-c.example/certs",
        }),
      ),
    ).toMatchObject({ ok: false, detail: expect.stringContaining("jwks_uri") });
    expect(
      await discover({ issuer: "https://down.example", allowHttp: false }, answer({}, 503)),
    ).toEqual({ ok: false, detail: "discovery HTTP 503" });
    const throwing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await discover({ issuer: "https://gone.example", allowHttp: false }, throwing)).toEqual({
      ok: false,
      detail: "discovery TypeError",
    });
  });

  it("caches a good document for an hour", async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return Response.json({
        issuer: "https://cache.example",
        jwks_uri: "https://cache.example/keys",
      });
    }) as unknown as typeof fetch;
    const settings = { issuer: "https://cache.example", allowHttp: false };
    await discover(settings, counting, 1_000);
    await discover(settings, counting, 1_000 + 59 * 60 * 1000);
    expect(calls).toBe(1);
    await discover(settings, counting, 1_000 + 61 * 60 * 1000);
    expect(calls).toBe(2);
  });
});
