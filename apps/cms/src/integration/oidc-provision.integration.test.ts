import { randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, type JWK, type JWTPayload } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestDatabase,
  createTestStrapi,
  testEngines,
  type ApiResponse,
  type OutboundHandler,
  type Row,
  type TestDatabase,
  type TestStrapi,
} from "./harness.test.helper";

/**
 * The OIDC exchange end to end (v0.25.0, deep-dive plan-oidc.md, Codex V1):
 * the real cms on SQLite and (SINNLOS_TEST_PG_URL) Postgres 16, with a mock
 * identity provider behind the harness's `outbound` seam (its discovery
 * document and a local RSA key as its key set). Covers the identity, 409,
 * default deny, the admission gate over a hand-set role, the hand-back, the
 * profile and department sync, /api/me, the user administration's view and
 * an OIDC-only boot that refuses password sign-ins (Codex C1). Made-up
 * URLs, keys and addresses only.
 */

const USER = "plugin::users-permissions.user";
const ISSUER = "https://idp.integration.test/realms/sinnlos";
const JWKS_URL = `${ISSUER}/protocol/openid-connect/certs`;
const CLIENT = "sinnlos-web";
const SECRET = "it-oidc-exchange-secret-0123456789abcdef";
const KID = "it-oidc-key";
const EXCHANGE = "/api/auth/oidc/exchange";
const TTL_SECONDS = 2 * 60 * 60;
const RESTART_BUDGET = 180_000;

interface Person {
  sub: string;
  name?: string;
  email?: string;
  roles?: string[];
  department?: string;
  claims?: JWTPayload;
}

interface ExchangeBody {
  jwt?: string;
  expiresAt?: number;
  user?: { id: number; displayName: string; email: string };
  error?: string;
}

let signingKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let jwks: { keys: JWK[] };
const secretsSeen: string[] = [];
const outboundCalls: string[] = [];

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" }] };
});

const idp: OutboundHandler = async (request) => {
  const url = new URL(request.url);
  outboundCalls.push(`${request.method} ${url.origin}${url.pathname}`);
  if (url.href === `${ISSUER}/.well-known/openid-configuration`) {
    return Response.json({ issuer: ISSUER, jwks_uri: JWKS_URL });
  }
  if (url.href === JWKS_URL) return Response.json(jwks);
  return undefined;
};

async function idTokenFor(who: Person): Promise<string> {
  const iat = Math.floor(Date.now() / 1000) - 5;
  const token = await new SignJWT({
    iss: ISSUER,
    aud: CLIENT,
    sub: who.sub,
    iat,
    exp: iat + 300,
    name: who.name ?? `OIDC Person ${who.sub}`,
    email: who.email ?? `${who.sub.toLowerCase()}@oidc.integration.test`,
    email_verified: true,
    roles: who.roles ?? [],
    ...(who.department ? { department: who.department } : {}),
    ...who.claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
    .sign(signingKey);
  secretsSeen.push(token);
  return token;
}

async function signIn(
  t: TestStrapi,
  who: Person,
  options: { secret?: string; path?: string } = {},
): Promise<ApiResponse<ExchangeBody>> {
  const res = await t.api<ExchangeBody>(null, options.path ?? EXCHANGE, {
    json: { idToken: await idTokenFor(who) },
    headers: { "x-oidc-exchange-secret": options.secret ?? SECRET },
  });
  if (typeof res.body?.jwt === "string") secretsSeen.push(res.body.jwt);
  return res;
}

function captureLogs(t: TestStrapi): string[] {
  const lines: string[] = [];
  const log = t.strapi.log as unknown as Record<"info" | "warn" | "error", (m: unknown) => unknown>;
  for (const level of ["info", "warn", "error"] as const) {
    const original = log[level].bind(log);
    log[level] = (message: unknown) => {
      lines.push(`${level} ${String(message)}`);
      return original(message);
    };
  }
  return lines;
}

const OIDC_ENV = {
  OIDC_ENABLED: "1",
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: CLIENT,
  OIDC_EXCHANGE_SECRET: SECRET,
  OIDC_DEPARTMENT_CLAIM: "department",
  OIDC_SESSION_TTL: "2h",
  // The fixtures sign in with e-mail and password (break-glass on).
  AUTH_LOCAL_ENABLED: "1",
};

async function userRow(t: TestStrapi, where: Record<string, unknown>): Promise<Row | null> {
  return t.strapi.db.query(USER).findOne({
    where,
    populate: { role: { select: ["type"] }, department: { select: ["documentId"] } },
  });
}

const roleType = (row: Row | null) =>
  row?.role && typeof row.role === "object" ? (row.role as { type?: string }).type : null;

async function indexExists(database: TestDatabase): Promise<boolean> {
  const rows =
    database.engine === "sqlite"
      ? await database.sql("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", [
          "up_users_oidc_identity_uq",
        ])
      : await database.sql(
          "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ?",
          ["up_users_oidc_identity_uq"],
        );
  return rows.length === 1;
}

describe.each(testEngines())("OIDC exchange (OIDC_ENABLED=1) on %s", (engine) => {
  let database: TestDatabase;
  let t: TestStrapi;
  let logs: string[];

  beforeAll(async () => {
    database = await createTestDatabase(engine);
    t = await createTestStrapi({ database, env: OIDC_ENV, outbound: idp });
    logs = captureLogs(t);
  });

  afterAll(async () => {
    await t?.stop();
    await database?.drop();
  });

  it("ensures the (issuer, subject) unique index", async () => {
    expect(await indexExists(database)).toBe(true);
  });

  it("refuses a wrong secret before any traffic, and a case variant of the path", async () => {
    const before = outboundCalls.length;
    const wrong = await signIn(t, { sub: "s-1" }, { secret: `${SECRET}-wrong` });
    expect([wrong.status, wrong.body]).toEqual([401, { error: "unauthorized" }]);
    expect(outboundCalls.length).toBe(before);
    const variant = await signIn(t, { sub: "s-1" }, { path: "/api/Auth/oidc/exchange" });
    expect(variant.status).toBe(404);
  });

  it("creates a new identity with the claim's role, the department and the session TTL", async () => {
    const res = await signIn(t, {
      sub: "Case-Kept-1",
      name: "Olive Idp",
      email: "Olive@OIDC.integration.test",
      roles: ["Intranet.Editor", "unrelated"],
      department: "it engineering",
    });
    expect(res.status).toBe(200);
    const id = res.body.user?.id;
    const row = await userRow(t, { id });
    expect(row).toMatchObject({
      provider: "oidc",
      roleSource: "oidc",
      entraAppliedRole: "editor",
      oidcIssuer: ISSUER,
      oidcSubject: "Case-Kept-1",
      email: "olive@oidc.integration.test",
      displayName: "Olive Idp",
      confirmed: true,
      blocked: false,
    });
    expect(String(row?.username)).toMatch(/^oidc-[0-9a-f]{32}$/);
    expect(roleType(row)).toBe("editor");
    expect((row?.department as { documentId?: string } | null)?.documentId).toBe(
      t.fixtures.departments.engineering.documentId,
    );
    const payload = JSON.parse(Buffer.from(res.body.jwt!.split(".")[1], "base64url").toString());
    expect(payload.exp - payload.iat).toBe(TTL_SECONDS);
    expect(
      logs.some((line) =>
        /^info \[oidc\] user=\d+ sub=[0-9a-f]{8} result=created role=new->editor via=role:Intranet.Editor department=set$/.test(
          line,
        ),
      ),
    ).toBe(true);
  });

  it("syncs role, name, e-mail and department of an existing identity; clears an unknown department", async () => {
    const first = await signIn(t, {
      sub: "s-sync",
      roles: ["Intranet.Member"],
      department: "IT Sales",
    });
    const id = first.body.user?.id;
    const again = await signIn(t, {
      sub: "s-sync",
      name: "Renamed Person",
      email: "renamed@oidc.integration.test",
      roles: ["Intranet.Admin"],
      department: "Nowhere",
    });
    expect([again.status, again.body.user?.id]).toEqual([200, id]);
    const row = await userRow(t, { id });
    expect(row).toMatchObject({
      displayName: "Renamed Person",
      email: "renamed@oidc.integration.test",
    });
    expect(roleType(row)).toBe("admin_role");
    expect(row?.department ?? null).toBeNull();
  });

  it("refuses a new identity without an Intranet.* role (default deny) and an unverified e-mail", async () => {
    const before = await t.strapi.db.query(USER).count();
    const deny = await signIn(t, { sub: "s-deny" });
    expect([deny.status, deny.body]).toEqual([403, { error: "not_assigned" }]);
    const unverified = await signIn(t, {
      sub: "s-unverified",
      roles: ["Intranet.Member"],
      claims: { email_verified: false },
    });
    expect([unverified.status, unverified.body]).toEqual([403, { error: "email_unverified" }]);
    expect(await t.strapi.db.query(USER).count()).toBe(before);
  });

  it("answers 409 when another row already has the address, and 403 for a blocked row", async () => {
    const taken = await signIn(t, {
      sub: "s-conflict",
      email: t.fixtures.users.member.email,
      roles: ["Intranet.Member"],
    });
    expect([taken.status, taken.body]).toEqual([409, { error: "account_exists" }]);
    const first = await signIn(t, { sub: "s-blocked", roles: ["Intranet.Member"] });
    await t.strapi.db
      .query(USER)
      .update({ where: { id: first.body.user?.id }, data: { blocked: true } });
    const blocked = await signIn(t, { sub: "s-blocked", roles: ["Intranet.Member"] });
    expect([blocked.status, blocked.body]).toEqual([403, { error: "blocked" }]);
  });

  it("the provider's role admits: a hand-set role keeps its type but needs an Intranet.* role; the hand-back returns it", async () => {
    const first = await signIn(t, { sub: "s-manual", roles: ["Intranet.Member"] });
    const id = first.body.user!.id;
    const put = await t.api<{ data?: { roleSource?: string; idp?: string } }>(
      "admin_role",
      `/api/user-management/${id}`,
      { method: "PUT", json: { data: { role: "editor" } } },
    );
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ roleSource: "manual", idp: "oidc" });

    const without = await signIn(t, { sub: "s-manual" });
    expect([without.status, without.body]).toEqual([403, { error: "not_assigned" }]);
    const withRole = await signIn(t, { sub: "s-manual", roles: ["Intranet.Guest"] });
    expect(withRole.status).toBe(200);
    expect(roleType(await userRow(t, { id }))).toBe("editor");

    const back = await t.api<{ data?: { roleSource?: string } }>(
      "admin_role",
      `/api/user-management/${id}/role-to-entra`,
      { method: "POST" },
    );
    expect([back.status, back.body.data?.roleSource]).toEqual([200, "oidc"]);
    await signIn(t, { sub: "s-manual", roles: ["Intranet.Guest"] });
    expect(await userRow(t, { id })).toMatchObject({
      roleSource: "oidc",
      entraAppliedRole: "guest",
    });
    expect(roleType(await userRow(t, { id }))).toBe("guest");
  });

  it("an admin's change in the panel flips the account to manual at the next sign-in", async () => {
    const first = await signIn(t, { sub: "s-panel", roles: ["Intranet.Member"] });
    const id = first.body.user!.id;
    const guest = await t.strapi.db
      .query("plugin::users-permissions.role")
      .findOne({ where: { type: "guest" } });
    await t.strapi.db.query(USER).update({ where: { id }, data: { role: guest!.id } });
    await signIn(t, { sub: "s-panel", roles: ["Intranet.Admin"] });
    expect(await userRow(t, { id })).toMatchObject({
      roleSource: "manual",
      entraAppliedRole: null,
    });
    expect(roleType(await userRow(t, { id }))).toBe("guest");
  });

  it("concurrent first sign-ins of one person create one row", async () => {
    const who = { sub: "s-race", roles: ["Intranet.Member"] };
    const results = await Promise.all([1, 2, 3, 4].map(() => signIn(t, who)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(new Set(results.map((r) => r.body.user?.id)).size).toBe(1);
    expect(await t.strapi.db.query(USER).count({ where: { oidcSubject: "s-race" } })).toBe(1);
  });

  it("/api/me: the name is managed by OIDC, the phone stays editable; the identity never leaves", async () => {
    const res = await signIn(t, { sub: "s-me", name: "Me Person", roles: ["Intranet.Member"] });
    const caller = { jwt: res.body.jwt! };
    const me = await t.api<{ data: Record<string, unknown> }>(caller, "/api/me");
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ managedBy: "oidc", entraManagedFields: ["displayName"] });
    for (const key of ["oidcIssuer", "oidcSubject", "roleSource", "entraAppliedRole"]) {
      expect(me.body.data).not.toHaveProperty(key);
    }
    const put = await t.api<Record<string, unknown>>(caller, "/api/me", {
      method: "PUT",
      json: { data: { displayName: "Self Renamed", phone: "+49 30 1234" } },
    });
    expect(put.status).toBe(200);
    expect(await userRow(t, { id: res.body.user!.id })).toMatchObject({
      displayName: "Me Person",
      phone: "+49 30 1234",
    });
  });

  it("logged no token, JWT or full subject", () => {
    const joined = logs.join("\n");
    for (const secret of secretsSeen) expect(joined).not.toContain(secret);
    expect(joined).not.toContain("Case-Kept-1");
    expect(joined).not.toContain(SECRET);
  });
});

describe.each(testEngines())("OIDC-only boot (no AUTH_LOCAL_ENABLED) on %s", () => {
  it(
    "refuses password sign-ins in the cms and still signs OIDC users in",
    async () => {
      const t = await createTestStrapi({
        fixtures: false,
        outbound: idp,
        env: { ...OIDC_ENV, AUTH_LOCAL_ENABLED: undefined },
      });
      try {
        const local = await t.api<{ error?: { message?: string } }>(null, "/api/auth/local", {
          json: { identifier: "nobody@integration.test", password: "whatever1" },
        });
        expect(local.status).toBe(400);
        expect(local.body.error?.message).toBe("This provider is disabled");
        const res = await signIn(t, {
          sub: `s-only-${randomBytes(4).toString("hex")}`,
          roles: ["Intranet.Member"],
        });
        expect(res.status).toBe(200);
      } finally {
        await t.stop();
      }
    },
    RESTART_BUDGET,
  );
});
