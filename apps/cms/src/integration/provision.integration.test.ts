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
 * The Entra exchange end to end (D-ENTRA-01 spec D-N, the "Tests" section's
 * provision.integration.test): the real cms, booted in process on SQLite
 * and (SINNLOS_TEST_PG_URL) Postgres 16, with a mock Microsoft behind the
 * harness's `outbound` seam: a local RSA key published as the tenant's
 * key set, and a stubbed Graph whose answers depend on the access token
 * ("personas"). Nothing reaches the network; the harness refuses it.
 *
 * Fake GUIDs, generated keys and made-up addresses only.
 */

const USER = "plugin::users-permissions.user";
const TENANT = "11111111-2222-4333-8444-555555555555";
const OTHER_TENANT = "99999999-8888-4777-8666-555555555555";
const CLIENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SECRET = "it-exchange-secret-0123456789abcdef";
const KID = "it-signing-key";
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const JWKS_URL = `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`;
const EXCHANGE = "/api/auth/entra/exchange";
const TTL_SECONDS = 2 * 60 * 60;

/** A restart plus a boot: above the 60 s test default. */
const RESTART_BUDGET = 180_000;

/** A fake object id; the audit line shows its first 8 characters. */
const oid = (n: number) =>
  `${String(n).padStart(8, "0")}-0f0f-4000-8000-${String(n).padStart(12, "0")}`;

/** One person in the mock tenant: what Graph and the ID token say. */
interface Persona {
  oid: string;
  name: string;
  mail: string | null;
  upn: string;
  userType?: "Member" | "Guest";
  jobTitle?: string | null;
  department?: string | null;
  officeLocation?: string | null;
  phones?: string[];
  /** App roles in the ID token. */
  roles?: string[];
  /** A non-200 answer for /me. */
  meStatus?: number;
  /** /me's id when it must differ from the token's oid. */
  meId?: string;
  /** The manager's oid, null for 404, or a failure status. */
  manager?: string | null | number;
  /** Awaited before /me answers (lineUp: concurrent exchanges start together). */
  holdMe?: () => Promise<void>;
}

const persona = (n: number, overrides: Partial<Persona> = {}): Persona => ({
  oid: oid(n),
  name: `Entra Person ${n}`,
  mail: `person${n}@entra.integration.test`,
  upn: `person${n}.upn@entra.integration.test`,
  userType: "Member",
  jobTitle: `Title ${n}`,
  department: null,
  officeLocation: `Office ${n}`,
  phones: [`+49 30 555 ${n}`],
  roles: [],
  ...overrides,
});

/**
 * Holds Graph /me until `size` requests arrived, so that many concurrent
 * exchanges leave Graph together and race on the identity lookup, the
 * e-mail check and the insert (the rehearsal held /me for 800 ms). Released
 * after 2 s at the latest, below Graph's 3 s timeout.
 */
function lineUp(size: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fallback = setTimeout(() => release(), 2_000);
  return async () => {
    arrived += 1;
    if (arrived >= size) {
      clearTimeout(fallback);
      release();
    }
    await released;
  };
}

interface ExchangeBody {
  jwt?: string;
  expiresAt?: number;
  user?: { id: number; displayName: string; email: string };
  error?: string;
}

// ---------------------------------------------------------------------------
// The mock Microsoft.

let signingKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let jwks: { keys: JWK[] };
/** Access token → the persona Graph answers for. */
const graphPersonas = new Map<string, Persona>();
/** Every token and JWT this file handed around: none may reach a log line. */
const secretsSeen: string[] = [];
const outboundCalls: string[] = [];

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" }] };
});

const microsoft: OutboundHandler = async (request) => {
  const url = new URL(request.url);
  outboundCalls.push(`${request.method} ${url.origin}${url.pathname}`);
  if (url.href === JWKS_URL) return Response.json(jwks);
  if (url.hostname !== "graph.microsoft.com") return undefined;
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const who = graphPersonas.get(token);
  if (!who)
    return Response.json({ error: { code: "InvalidAuthenticationToken" } }, { status: 401 });
  if (url.pathname === "/v1.0/me") {
    await who.holdMe?.();
    if (who.meStatus) return Response.json({ error: {} }, { status: who.meStatus });
    return Response.json({
      id: (who.meId ?? who.oid).toUpperCase(),
      displayName: who.name,
      mail: who.mail,
      userPrincipalName: who.upn,
      jobTitle: who.jobTitle ?? null,
      department: who.department ?? null,
      officeLocation: who.officeLocation ?? null,
      businessPhones: who.phones ?? [],
      userType: who.userType ?? "Member",
    });
  }
  if (url.pathname === "/v1.0/me/manager") {
    if (who.manager === undefined || who.manager === null) {
      return Response.json({ error: { code: "Request_ResourceNotFound" } }, { status: 404 });
    }
    if (typeof who.manager === "number")
      return Response.json({ error: {} }, { status: who.manager });
    return Response.json({ id: who.manager });
  }
  if (url.pathname === "/v1.0/me/checkMemberGroups") return Response.json({ value: [] });
  return Response.json({ error: {} }, { status: 404 });
};

async function idTokenFor(who: Persona, claims: JWTPayload = {}): Promise<string> {
  const iat = Math.floor(Date.now() / 1000) - 5;
  const token = await new SignJWT({
    iss: ISSUER,
    aud: CLIENT,
    tid: TENANT,
    oid: who.oid,
    iat,
    nbf: iat,
    exp: iat + 3600,
    name: who.name,
    preferred_username: who.upn,
    ...(who.mail ? { email: who.mail } : {}),
    roles: who.roles ?? [],
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
    .sign(signingKey);
  secretsSeen.push(token);
  return token;
}

async function signIn(
  t: TestStrapi,
  who: Persona,
  options: { secret?: string; claims?: JWTPayload; path?: string } = {},
): Promise<ApiResponse<ExchangeBody>> {
  const accessToken = `it-graph-token-${randomBytes(12).toString("hex")}`;
  graphPersonas.set(accessToken, who);
  secretsSeen.push(accessToken);
  const idToken = await idTokenFor(who, options.claims);
  const res = await t.api<ExchangeBody>(null, options.path ?? EXCHANGE, {
    json: { idToken, accessToken },
    headers: { "x-entra-exchange-secret": options.secret ?? SECRET },
  });
  if (typeof res.body?.jwt === "string") secretsSeen.push(res.body.jwt);
  return res;
}

/** Records the cms log lines of a running boot (the harness logs at error). */
function captureLogs(t: TestStrapi): string[] {
  const lines: string[] = [];
  const log = t.strapi.log as unknown as Record<
    "info" | "warn" | "error",
    (message: unknown) => unknown
  >;
  for (const level of ["info", "warn", "error"] as const) {
    const original = log[level].bind(log);
    log[level] = (message: unknown) => {
      lines.push(`${level} ${String(message)}`);
      return original(message);
    };
  }
  return lines;
}

const ENTRA_ENV = {
  ENTRA_ENABLED: "1",
  MS_TENANT_ID: TENANT,
  MS_CLIENT_ID: CLIENT,
  ENTRA_EXCHANGE_SECRET: SECRET,
  ENTRA_SYNC_MODE: "on",
  ENTRA_DEFAULT_ROLE: "member",
  ENTRA_GROUP_ROLES: undefined,
  ENTRA_SYNC_DEPARTMENT: "1",
  ENTRA_SYNC_MANAGER: "1",
  ENTRA_SESSION_TTL: "2h",
  // The fixtures sign in with e-mail and password (break-glass on).
  AUTH_LOCAL_ENABLED: "1",
};

async function userRow(t: TestStrapi, where: Record<string, unknown>): Promise<Row | null> {
  return t.strapi.db.query(USER).findOne({
    where,
    populate: {
      role: { select: ["type"] },
      department: { select: ["documentId"] },
      manager: { select: ["id"] },
    },
  });
}

const relation = (value: unknown, key: "type" | "documentId" | "id") =>
  value && typeof value === "object" ? ((value as Record<string, unknown>)[key] ?? null) : null;

async function roleIdOf(t: TestStrapi, type: string): Promise<number> {
  const role = await t.strapi.db
    .query("plugin::users-permissions.role")
    .findOne({ where: { type } });
  if (!role) throw new Error(`role ${type} missing`);
  return role.id;
}

function decodeJwt(jwt: string): { id?: number; iat?: number; exp?: number } {
  return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as {
    id?: number;
    iat?: number;
    exp?: number;
  };
}

async function identityIndexExists(database: TestDatabase): Promise<boolean> {
  const rows =
    database.engine === "sqlite"
      ? await database.sql("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", [
          "up_users_entra_identity_uq",
        ])
      : await database.sql(
          "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ?",
          ["up_users_entra_identity_uq"],
        );
  return rows.length === 1;
}

// ---------------------------------------------------------------------------

describe.each(testEngines())("Entra exchange (ENTRA_ENABLED=1, mode on) on %s", (engine) => {
  let database: TestDatabase;
  let t: TestStrapi;
  let logs: string[];

  beforeAll(async () => {
    database = await createTestDatabase(engine);
    t = await createTestStrapi({ database, env: ENTRA_ENV, outbound: microsoft });
    logs = captureLogs(t);
  });

  afterAll(async () => {
    await t?.stop();
    await database?.drop();
  });

  it("ensures the (tenant, oid) unique index", async () => {
    expect(await identityIndexExists(database)).toBe(true);
  });

  it("refuses a wrong or missing secret (401) before any Microsoft traffic", async () => {
    const before = outboundCalls.length;
    const wrong = await signIn(t, persona(1), { secret: `${SECRET}-wrong` });
    expect([wrong.status, wrong.body]).toEqual([401, { error: "unauthorized" }]);
    const none = await t.api<ExchangeBody>(null, EXCHANGE, {
      json: { idToken: "a", accessToken: "b" },
    });
    expect([none.status, none.body]).toEqual([401, { error: "unauthorized" }]);
    expect(outboundCalls.length).toBe(before);
  });

  it("answers a case variant of the path with 404 (D-EDGE-01), secret or not", async () => {
    for (const path of [
      "/api/Auth/entra/exchange",
      "/api/AUTH/entra/exchange",
      "/api/auth/../Auth/entra/exchange",
    ]) {
      const res = await signIn(t, persona(1), { path });
      expect(res.status, path).toBe(404);
    }
  });

  it("refuses an ID token of another tenant, app or age (401 invalid) and creates nothing", async () => {
    const cases: JWTPayload[] = [
      { tid: OTHER_TENANT },
      { iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0`, tid: OTHER_TENANT },
      { aud: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { iat: Math.floor(Date.now() / 1000) - 30 * 60 },
    ];
    for (const claims of cases) {
      const res = await signIn(t, persona(2), { claims });
      expect([res.status, res.body], JSON.stringify(claims)).toEqual([401, { error: "invalid" }]);
    }
    expect(await userRow(t, { microsoftOid: oid(2) })).toBeNull();
  });

  it("refuses a Graph /me of another user than the token's (401 invalid)", async () => {
    const res = await signIn(t, persona(3, { meId: oid(4) }));
    expect([res.status, res.body]).toEqual([401, { error: "invalid" }]);
    expect(await userRow(t, { microsoftOid: oid(3) })).toBeNull();
  });

  it("creates the user on the first sign-in, with an explicit response and a TTL-bound JWT", async () => {
    const ada = persona(10, {
      name: "Ada Entra",
      mail: "Ada.Entra@Entra.Integration.test",
      roles: ["Intranet.Editor"],
      department: "it engineering",
    });
    const res = await signIn(t, ada);
    expect(res.status).toBe(200);
    const body = res.body;
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "jwt", "user"]);
    expect(Object.keys(body.user ?? {}).sort()).toEqual(["displayName", "email", "id"]);
    expect(body.user).toMatchObject({
      displayName: "Ada Entra",
      email: "ada.entra@entra.integration.test",
    });
    expect(res.text).not.toMatch(
      /password|resetPasswordToken|confirmationToken|microsoftOid|entraTenantId/,
    );

    const claims = decodeJwt(body.jwt ?? "");
    expect(claims.id).toBe(body.user?.id);
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(TTL_SECONDS);
    expect(body.expiresAt).toBe(claims.exp);

    const row = await userRow(t, { id: body.user?.id });
    expect(row).toMatchObject({
      username: `entra-${ada.oid}`,
      email: "ada.entra@entra.integration.test",
      provider: "microsoft",
      confirmed: true,
      blocked: false,
      roleSource: "entra",
      entraAppliedRole: "editor",
      entraTenantId: TENANT,
      microsoftOid: ada.oid,
      displayName: "Ada Entra",
      jobTitle: "Title 10",
      officeLocation: "Office 10",
      phone: "+49 30 555 10",
    });
    expect(row?.password ?? null).toBeNull();
    expect(typeof row?.documentId).toBe("string");
    expect(relation(row?.role, "type")).toBe("editor");
    // Department by a case-insensitive match on a published name.
    const engineering = await t.strapi.db
      .query("api::department.department")
      .findOne({ where: { name: "IT Engineering" } });
    expect(relation(row?.department, "documentId")).toBe(engineering?.documentId);

    // The JWT is a working Strapi session.
    const me = await t.api<{ id?: number }>({ jwt: body.jwt ?? "" }, "/api/users/me");
    expect([me.status, me.body.id]).toEqual([200, body.user?.id]);
  });

  it("returns the same user on the next sign-in and mirrors the Entra profile", async () => {
    const first = await signIn(t, persona(11, { department: "IT Sales" }));
    expect(first.status).toBe(200);
    const again = await signIn(
      t,
      persona(11, {
        name: "   ",
        jobTitle: null,
        officeLocation: null,
        phones: [],
        department: "No Such Department",
      }),
    );
    expect(again.status).toBe(200);
    expect(again.body.user?.id).toBe(first.body.user?.id);
    const row = await userRow(t, { id: first.body.user?.id });
    expect(row).toMatchObject({
      displayName: "Entra Person 11",
      jobTitle: null,
      officeLocation: null,
      phone: null,
    });
    // A department that matches nothing is cleared (access does not survive a move).
    expect(row?.department ?? null).toBeNull();
    expect(await t.strapi.db.query(USER).count({ where: { microsoftOid: oid(11) } })).toBe(1);
  });

  it("creates exactly one row for concurrent first sign-ins, and none of them answers 409", async () => {
    const who = persona(12, { holdMe: lineUp(4) });
    const results = await Promise.all([
      signIn(t, who),
      signIn(t, who),
      signIn(t, who),
      signIn(t, who),
    ]);
    // Spec F: a sign-in that loses the race continues as the existing user,
    // also when its e-mail check already sees the winner's row.
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const ids = new Set(results.map((r) => r.body.user?.id));
    expect(ids.size).toBe(1);
    expect(
      await t.strapi.db
        .query(USER)
        .count({ where: { entraTenantId: TENANT, microsoftOid: who.oid } }),
    ).toBe(1);
  });

  it("refuses a new identity whose e-mail a local account uses (409), then signs in as the admin-bound row", async () => {
    const member = t.fixtures.users.member;
    const who = persona(13, { mail: member.email.toUpperCase() });
    const res = await signIn(t, who);
    expect([res.status, res.body]).toEqual([409, { error: "account_exists" }]);
    expect(await userRow(t, { microsoftOid: who.oid })).toBeNull();

    // The admin binding: tenant and object id on the existing row.
    await t.strapi.db.query(USER).update({
      where: { id: member.id },
      data: { entraTenantId: TENANT, microsoftOid: who.oid },
    });
    const bound = await signIn(t, { ...who, roles: ["Intranet.Admin"], name: "Bound Member" });
    expect(bound.status).toBe(200);
    expect(bound.body.user?.id).toBe(member.id);
    const row = await userRow(t, { id: member.id });
    // Provider, e-mail and (manual) role stay; the profile is Entra's now.
    expect(row).toMatchObject({
      provider: "local",
      email: member.email,
      roleSource: null,
      displayName: "Bound Member",
    });
    expect(relation(row?.role, "type")).toBe("member");
  });

  it("never matches a row with a microsoftOid but no tenant (legacy or self-registered)", async () => {
    const who = persona(14);
    const legacy = await t.strapi.db.query(USER).create({
      data: {
        username: "legacy-microsoft-row",
        email: "legacy.row@entra.integration.test",
        provider: "microsoft",
        confirmed: true,
        microsoftOid: who.oid,
        role: await roleIdOf(t, "admin_role"),
      },
    });
    const res = await signIn(t, who);
    expect(res.status).toBe(200);
    expect(res.body.user?.id).not.toBe(legacy.id);
    const created = await userRow(t, { id: res.body.user?.id });
    expect(relation(created?.role, "type")).toBe("member");
    expect(await userRow(t, { id: legacy.id })).toMatchObject({
      entraTenantId: null,
      microsoftOid: who.oid,
    });
  });

  it("refuses a blocked user (403 blocked)", async () => {
    const who = persona(15);
    const first = await signIn(t, who);
    await t.strapi.db
      .query(USER)
      .update({ where: { id: first.body.user?.id }, data: { blocked: true } });
    const res = await signIn(t, who);
    expect([res.status, res.body]).toEqual([403, { error: "blocked" }]);
  });

  it("denies an unassigned B2B guest (403 not_assigned) and admits one with Intranet.Guest", async () => {
    const denied = await signIn(t, persona(16, { userType: "Guest" }));
    expect([denied.status, denied.body]).toEqual([403, { error: "not_assigned" }]);
    expect(await userRow(t, { microsoftOid: oid(16) })).toBeNull();
    const admitted = await signIn(t, persona(17, { userType: "Guest", roles: ["Intranet.Guest"] }));
    expect(admitted.status).toBe(200);
    expect(relation((await userRow(t, { id: admitted.body.user?.id }))?.role, "type")).toBe(
      "guest",
    );
  });

  it("answers 503 for a new user without /me, and never changes an existing user's role on a Graph failure", async () => {
    const fresh = await signIn(t, persona(18, { meStatus: 503 }));
    expect([fresh.status, fresh.body]).toEqual([503, { error: "unavailable" }]);
    expect(await userRow(t, { microsoftOid: oid(18) })).toBeNull();

    const who = persona(19, { roles: ["Intranet.TeamLead"] });
    const first = await signIn(t, who);
    expect(first.status).toBe(200);
    const failing = await signIn(t, { ...who, roles: [], meStatus: 429, jobTitle: "ignored" });
    expect(failing.status).toBe(200);
    const row = await userRow(t, { id: first.body.user?.id });
    expect(relation(row?.role, "type")).toBe("team_lead");
    expect(row?.jobTitle).toBe("Title 19");
  });

  it("applies Entra's role changes, keeps an admin's override (manual) and takes a hand-back", async () => {
    const who = persona(20, { roles: ["Intranet.Member"] });
    const first = await signIn(t, who);
    const id = first.body.user?.id;
    expect((await signIn(t, { ...who, roles: ["Intranet.DepartmentHead"] })).status).toBe(200);
    expect(await userRow(t, { id })).toMatchObject({
      roleSource: "entra",
      entraAppliedRole: "department_head",
    });

    // An admin re-roles the user: the next sign-in flips it to manual and keeps it.
    await t.strapi.db
      .query(USER)
      .update({ where: { id }, data: { role: await roleIdOf(t, "guest") } });
    await signIn(t, { ...who, roles: ["Intranet.Admin"] });
    let row = await userRow(t, { id });
    expect(row).toMatchObject({ roleSource: "manual", entraAppliedRole: null });
    expect(relation(row?.role, "type")).toBe("guest");
    // Sticky: neither a higher app role nor a deny changes it.
    await signIn(t, { ...who, roles: ["Intranet.Admin"] });
    expect((await signIn(t, { ...who, roles: [], userType: "Guest" })).status).toBe(200);
    expect(relation((await userRow(t, { id }))?.role, "type")).toBe("guest");

    // Hand-back: roleSource entra, no applied role.
    await t.strapi.db
      .query(USER)
      .update({ where: { id }, data: { roleSource: "entra", entraAppliedRole: null } });
    await signIn(t, { ...who, roles: ["Intranet.Editor"] });
    row = await userRow(t, { id });
    expect(row).toMatchObject({ roleSource: "entra", entraAppliedRole: "editor" });
    expect(relation(row?.role, "type")).toBe("editor");
  });

  it("keeps an unknown manager pending, back-fills it, clears on 404 and keeps it on 403", async () => {
    const boss = persona(30);
    const report = persona(31, { manager: boss.oid });
    const reportRes = await signIn(t, report);
    const reportId = reportRes.body.user?.id;
    expect(await userRow(t, { id: reportId })).toMatchObject({
      entraManagerOid: boss.oid,
      manager: null,
    });

    const bossRes = await signIn(t, boss);
    expect(relation((await userRow(t, { id: reportId }))?.manager, "id")).toBe(
      bossRes.body.user?.id,
    );

    await signIn(t, { ...report, manager: 403 });
    expect(relation((await userRow(t, { id: reportId }))?.manager, "id")).toBe(
      bossRes.body.user?.id,
    );
    // Without a successful /me nothing profile-like is applied, not even a 404 manager.
    await signIn(t, { ...report, manager: null, meStatus: 503 });
    expect(relation((await userRow(t, { id: reportId }))?.manager, "id")).toBe(
      bossRes.body.user?.id,
    );
    await signIn(t, { ...report, manager: null });
    expect(await userRow(t, { id: reportId })).toMatchObject({
      entraManagerOid: null,
      manager: null,
    });
  });

  it("locks the Entra-owned profile fields: PUT /api/me drops them, GET lists them", async () => {
    const res = await signIn(t, persona(50, { name: "Locked Name" }));
    const jwt = res.body.jwt ?? "";
    type Me = { data?: Record<string, unknown> };
    const put = await t.api<Me>({ jwt }, "/api/me", {
      method: "PUT",
      json: {
        data: { displayName: "Self-chosen", jobTitle: "Self-promoted", phone: "0", locale: "de" },
      },
    });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({
      displayName: "Locked Name",
      jobTitle: "Title 50",
      phone: "+49 30 555 50",
      locale: "de",
      entraManagedFields: ["displayName", "jobTitle", "phone", "officeLocation"],
    });
    for (const key of [
      "microsoftOid",
      "entraTenantId",
      "roleSource",
      "entraAppliedRole",
      "entraManagerOid",
    ]) {
      expect(put.body.data, key).not.toHaveProperty(key);
    }
    // Only locked fields: nothing to write, still 200.
    const onlyLocked = await t.api<Me>({ jwt }, "/api/me", {
      method: "PUT",
      json: { data: { displayName: "x" } },
    });
    expect([onlyLocked.status, onlyLocked.body.data?.displayName]).toEqual([200, "Locked Name"]);
    // A local account edits everything, as before.
    const local = await t.api<Me>("editor", "/api/me", {
      method: "PUT",
      json: { data: { jobTitle: "Local Title" } },
    });
    expect(local.body.data).toMatchObject({ jobTitle: "Local Title", entraManagedFields: [] });
  });

  it("writes one audit line per exchange and never a token, JWT or secret", () => {
    const audit = logs.filter((line) => line.startsWith("info [entra] user="));
    expect(audit.length).toBeGreaterThan(10);
    expect(
      audit.some((line) =>
        /result=created role=new->editor via=approle:Intranet\.Editor mode=on graph=me:ok,groups:off,manager:ok/.test(
          line,
        ),
      ),
    ).toBe(true);
    expect(audit.some((line) => /result=conflict/.test(line))).toBe(true);
    expect(audit.some((line) => /result=denied/.test(line))).toBe(true);
    expect(audit.some((line) => /result=blocked/.test(line))).toBe(true);
    expect(audit.some((line) => /role=manual-override/.test(line))).toBe(true);
    const everything = logs.join("\n");
    expect(secretsSeen.length).toBeGreaterThan(20);
    for (const secret of [...secretsSeen, SECRET]) {
      expect(everything.includes(secret), "a token reached the log").toBe(false);
    }
  });
});

describe.each(testEngines())("Entra off (the owner instance) on %s", (engine) => {
  let t: TestStrapi;

  beforeAll(async () => {
    // No outbound handler: any JWKS or Graph request fails stop().
    t = await createTestStrapi({
      engine,
      env: {
        LOCAL_REGISTRATION: "1",
        // Stale placeholders from an old infra/.env are inert without ENTRA_ENABLED.
        MS_TENANT_ID: "common",
        MS_CLIENT_ID: "your-app-client-id",
        ENTRA_EXCHANGE_SECRET: "short",
      },
    });
  });

  afterAll(async () => {
    await t?.stop();
  });

  it("answers the exchange with 404, whatever it is sent", async () => {
    for (const headers of [{}, { "x-entra-exchange-secret": SECRET }]) {
      const res = await t.api(null, EXCHANGE, {
        json: { idToken: "x", accessToken: "y" },
        headers,
      });
      expect(res.status).toBe(404);
    }
  });

  it("keeps local sign-in on and Strapi's Microsoft provider off", async () => {
    const pluginStore = t.strapi as unknown as {
      store(key: { type: string; name: string; key: string }): {
        get(): Promise<Record<string, { enabled?: boolean; key?: string; secret?: string }>>;
      };
    };
    const grant = await pluginStore
      .store({ type: "plugin", name: "users-permissions", key: "grant" })
      .get();
    expect(grant.email?.enabled).toBe(true);
    expect(grant.microsoft).toMatchObject({ enabled: false, key: "", secret: "" });
    const connect = await t.api(null, "/api/connect/microsoft");
    expect(connect.status).toBeGreaterThanOrEqual(400);
    expect(connect.status).not.toBe(404);
    expect(
      await t.login(t.fixtures.users.member.username, t.fixtures.users.member.password),
    ).toMatch(/\./);
  });

  it("refuses the anonymous forgot/reset-password flow (403)", async () => {
    const forgot = await t.api(null, "/api/auth/forgot-password", {
      json: { email: t.fixtures.users.member.email },
    });
    expect(forgot.status).toBe(403);
    const reset = await t.api(null, "/api/auth/reset-password", {
      json: { code: "x", password: "Secret123!", passwordConfirmation: "Secret123!" },
    });
    expect(reset.status).toBe(403);
  });

  it("refuses microsoftOid (and jobTitle) on self-registration, takes displayName (FX14)", async () => {
    const register = (extra: Record<string, unknown>) =>
      t.api<{ user?: { id: number }; error?: { message?: string } }>(
        null,
        "/api/auth/local/register",
        {
          json: {
            username: "it-register-probe",
            email: "register.probe@integration.test",
            password: "Secret123!",
            displayName: "Probe",
            ...extra,
          },
        },
      );
    // users-permissions refuses every key outside register.allowedFields.
    const withOid = await register({ microsoftOid: oid(99) });
    expect(withOid.status).toBe(400);
    expect(withOid.body.error?.message).toMatch(/microsoftOid/);
    const withTitle = await register({ jobTitle: "Self-promoted" });
    expect(withTitle.status).toBe(400);
    expect(await t.strapi.db.query(USER).count({ where: { microsoftOid: oid(99) } })).toBe(0);

    const plain = await register({});
    expect(plain.status).toBe(200);
    expect(await userRow(t, { id: plain.body.user?.id })).toMatchObject({
      displayName: "Probe",
      microsoftOid: null,
      entraTenantId: null,
      roleSource: null,
    });
  });

  it("still ensures the identity index", async () => {
    expect(await identityIndexExists(t.database)).toBe(true);
  });
});

describe.each(testEngines())("dry-run, Entra-only and restarts on %s", (engine) => {
  let database: TestDatabase;
  let adminId: number;
  let guestId: number;

  beforeAll(async () => {
    database = await createTestDatabase(engine);
    const t = await createTestStrapi({ database, env: ENTRA_ENV, outbound: microsoft });
    try {
      adminId = (await signIn(t, persona(40, { roles: ["Intranet.Admin"] }))).body.user?.id ?? 0;
      guestId = (await signIn(t, persona(41, { roles: ["Intranet.Guest"] }))).body.user?.id ?? 0;
    } finally {
      await t.stop();
    }
    expect(adminId).toBeGreaterThan(0);
    // A schema change for the next boot: a column to add back, and a
    // stored schema that no longer matches (so Strapi runs the full diff).
    await database.sql("ALTER TABLE up_users DROP COLUMN entra_manager_oid");
    await database.sql("UPDATE strapi_database_schema SET hash = ?", ["forced-by-provision-test"]);
  }, RESTART_BUDGET);

  afterAll(async () => {
    await database?.drop();
  });

  it(
    "keeps the index across a restart with a schema change; dry-run caps and never changes existing roles",
    async () => {
      const t = await createTestStrapi({
        database,
        fixtures: false,
        outbound: microsoft,
        env: { ...ENTRA_ENV, ENTRA_SYNC_MODE: "dry-run", AUTH_LOCAL_ENABLED: undefined },
      });
      try {
        expect(await identityIndexExists(database)).toBe(true);
        const columns =
          engine === "sqlite"
            ? await database.sql<{ name: string }>("SELECT name FROM pragma_table_info('up_users')")
            : await database.sql<{ name: string }>(
                "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'up_users'",
              );
        expect(columns.map((c) => c.name)).toContain("entra_manager_oid");

        // Existing users: nothing is written in dry-run, not even a demotion.
        const admin = await signIn(
          t,
          persona(40, { roles: ["Intranet.Member"], jobTitle: "Changed" }),
        );
        expect([admin.status, admin.body.user?.id]).toEqual([200, adminId]);
        const adminRow = await userRow(t, { id: adminId });
        expect(relation(adminRow?.role, "type")).toBe("admin_role");
        expect(adminRow?.jobTitle).toBe("Title 40");

        // New users: capped at member; guest stays guest.
        const boss = await signIn(t, persona(42, { roles: ["Intranet.Admin"] }));
        expect(boss.status).toBe(200);
        expect(await userRow(t, { id: boss.body.user?.id })).toMatchObject({
          entraAppliedRole: "member",
          roleSource: "entra",
        });
        expect(relation((await userRow(t, { id: guestId }))?.role, "type")).toBe("guest");

        // Entra-only (AUTH_LOCAL_ENABLED unset): the cms refuses password sign-ins.
        const local = await t.api<{ error?: { message?: string } }>(null, "/api/auth/local", {
          json: { identifier: "nobody@integration.test", password: "whatever1" },
        });
        expect(local.status).toBe(400);
        expect(local.body.error?.message).toBe("This provider is disabled");
      } finally {
        await t.stop();
      }
    },
    RESTART_BUDGET,
  );
});
