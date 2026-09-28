import { describe, expect, it, vi, type Mock } from "vitest";
import { parseEntraConfig, type EntraConfig } from "./config";
import type { EntraIdClaims } from "./id-token";
import {
  DEPARTMENT_UID,
  ROLE_UID,
  USER_UID,
  runEntraExchange,
  type ExchangeDeps,
  type ExchangeHost,
  type ExchangeOutcome,
} from "./provision";

/**
 * runEntraExchange against an in-memory host: the interleavings and error
 * paths a real database only produces by timing (D-ENTRA-01 spec F, K, N).
 * The happy paths run end to end in integration/provision.integration.test.ts.
 * Fake GUIDs, secrets and addresses only.
 */

const TENANT = "11111111-2222-4333-8444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SECRET = "0123456789abcdef0123456789abcdef";
const OID = "00000001-0f0f-4000-8000-000000000001";
const ROLE_TYPES = [
  "admin_role",
  "editor",
  "department_head",
  "team_lead",
  "member",
  "guest",
] as const;
type RoleName = (typeof ROLE_TYPES)[number];
const roleId = (type: RoleName) => ROLE_TYPES.indexOf(type) + 1;

type Row = Record<string, unknown> & { id: number };
type Where = Record<string, unknown>;
type LogSpy = Mock<(message: string) => void>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (isRecord(condition)) {
      if ("$eqi" in condition) {
        return (
          typeof value === "string" &&
          value.toLowerCase() === String(condition.$eqi).toLowerCase()
        );
      }
      if ("$ne" in condition) return value !== condition.$ne;
      throw new Error(`fake db: unsupported condition on ${key}`);
    }
    return value === condition;
  });
}

interface FakeOptions {
  /** Identity lookups ({entraTenantId, microsoftOid: OID}) that miss before the row shows. */
  identityMisses?: number;
  /** Rejects users.update (after the role write) with this error. */
  failProfileUpdate?: Error;
  /** Rejects users.create with this error. */
  failCreate?: Error;
  /**
   * What identity lookups (outside a transaction) see instead of the row's
   * role fields: a concurrent exchange's half-written row.
   */
  torn?: Partial<Row>;
  /** strapi.db.dialect.client (default sqlite). */
  dialect?: string;
}

interface FakeHost extends ExchangeHost {
  log: { info: LogSpy; warn: LogSpy; error: LogSpy };
  users: Row[];
  calls: {
    create: number;
    /** Every users.update, and whether it ran inside a transaction. */
    update: { where: Where; data: Record<string, unknown>; inTransaction: boolean }[];
    /** users.create calls inside a transaction. */
    createInTransaction: number;
    transactions: number;
    /** Row ids locked FOR UPDATE. */
    locks: unknown[];
  };
}

/** The slice of Strapi the exchange uses, over an array of user rows. */
function fakeHost(seed: Row[] = [], options: FakeOptions = {}): FakeHost {
  const users = seed.map((row) => ({ ...row }));
  const calls: FakeHost["calls"] = {
    create: 0,
    update: [],
    createInTransaction: 0,
    transactions: 0,
    locks: [],
  };
  let identityMisses = options.identityMisses ?? 0;
  let nextId = 100;
  let depth = 0;

  const shape = (row: Row, params: Record<string, unknown>): Row => {
    const out: Row = { ...row };
    const populate = isRecord(params.populate) ? params.populate : {};
    if ("role" in populate) {
      const id = row.role;
      out.role =
        typeof id === "number" ? { id, type: ROLE_TYPES[id - 1] ?? "authenticated" } : null;
    }
    return out;
  };
  const userQuery = {
    async findOne(params: Record<string, unknown>) {
      const where = (params.where ?? {}) as Where;
      if (where.microsoftOid === OID && identityMisses > 0) {
        identityMisses -= 1;
        return null;
      }
      const row = users.find((candidate) => matches(candidate, where));
      if (!row) return null;
      const torn = "microsoftOid" in where && depth === 0 ? options.torn : undefined;
      return shape(torn ? { ...row, ...torn } : row, params);
    },
    async findMany(params: Record<string, unknown>) {
      const where = (params.where ?? {}) as Where;
      return users.filter((row) => matches(row, where)).map((row) => shape(row, params));
    },
    async create({ data }: { data: Record<string, unknown> }) {
      calls.create += 1;
      if (depth > 0) calls.createInTransaction += 1;
      if (options.failCreate) throw options.failCreate;
      const clash = users.find(
        (row) => row.entraTenantId === data.entraTenantId && row.microsoftOid === data.microsoftOid,
      );
      if (clash) throw Object.assign(new Error("UNIQUE constraint failed"), { code: "23505" });
      const row: Row = { ...data, id: nextId++, documentId: `doc-${nextId}` };
      users.push(row);
      return row;
    },
    async update({ where, data }: { where: Where; data: Record<string, unknown> }) {
      calls.update.push({ where, data, inTransaction: depth > 0 });
      const roleWrite = "role" in data || "roleSource" in data || "entraAppliedRole" in data;
      if (options.failProfileUpdate && !roleWrite) throw options.failProfileUpdate;
      const row = users.find((candidate) => matches(candidate, where));
      if (!row) return null;
      Object.assign(row, data);
      return row;
    },
  };
  const roleQuery = {
    async findOne(params: Record<string, unknown>) {
      const type = (params.where as Where).type as RoleName;
      return ROLE_TYPES.includes(type) ? { id: roleId(type) } : null;
    },
    findMany: () => Promise.reject(new Error("fake db: roles.findMany")),
    create: () => Promise.reject(new Error("fake db: roles.create")),
    update: () => Promise.reject(new Error("fake db: roles.update")),
  };

  return {
    users,
    calls,
    db: {
      query(uid: string) {
        if (uid === USER_UID) return userQuery;
        if (uid === ROLE_UID) return roleQuery;
        throw new Error(`fake db: no model ${uid}`);
      },
      async transaction<T>(callback: () => Promise<T>): Promise<T> {
        calls.transactions += 1;
        depth += 1;
        try {
          return await callback();
        } finally {
          depth -= 1;
        }
      },
      queryBuilder(uid: string) {
        if (uid !== USER_UID) throw new Error(`fake queryBuilder: ${uid}`);
        let id: unknown;
        let lock = false;
        const builder = {
          select: () => builder,
          where: (where: Where) => {
            id = where.id;
            return builder;
          },
          forUpdate: () => {
            lock = true;
            return builder;
          },
          execute: async () => {
            if (depth === 0) throw new Error("fake queryBuilder: a lock outside a transaction");
            if (lock) calls.locks.push(id);
            return [];
          },
        };
        return builder;
      },
      dialect: { client: options.dialect ?? "sqlite" },
    },
    documents(uid: string) {
      if (uid !== DEPARTMENT_UID && uid !== USER_UID) throw new Error(`fake documents: ${uid}`);
      return {
        findMany: async () => [],
        update: async () => ({}),
      };
    },
    plugin(name: string) {
      if (name !== "users-permissions") throw new Error(`fake plugin: ${name}`);
      return {
        service: () => ({
          issue: (payload: { id: number }) =>
            `h.${Buffer.from(JSON.stringify({ id: payload.id, iat: 1, exp: 7201 })).toString("base64url")}.s`,
        }),
      };
    },
    log: {
      info: vi.fn<(message: string) => void>(),
      warn: vi.fn<(message: string) => void>(),
      error: vi.fn<(message: string) => void>(),
    },
  };
}

function settings(env: Record<string, string> = {}): EntraConfig {
  const parsed = parseEntraConfig({
    ENTRA_ENABLED: "1",
    MS_TENANT_ID: TENANT,
    MS_CLIENT_ID: CLIENT,
    ENTRA_EXCHANGE_SECRET: SECRET,
    ENTRA_SYNC_MODE: "on",
    ...env,
  });
  if (!parsed.enabled) throw new Error("expected an enabled configuration");
  return parsed;
}

interface Person {
  name: string;
  mail: string;
  jobTitle?: string | null;
  roles?: string[];
  /** Graph's answer to checkMemberGroups: the group ids, or a failure status. */
  groups?: string[] | number;
}

const PERSON: Person = { name: "Pat Example", mail: "pat@entra.unit.test" };

/** Graph for one person; records every request as "METHOD path". */
function graphFor(who: Person) {
  const requests: { call: string; body: unknown }[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({ call: `${init?.method ?? "GET"} ${url.pathname}`, body });
    if (url.pathname === "/v1.0/me") {
      return Response.json({
        id: OID,
        displayName: who.name,
        mail: who.mail,
        userPrincipalName: who.mail,
        jobTitle: who.jobTitle ?? null,
        department: null,
        officeLocation: null,
        businessPhones: [],
        userType: "Member",
      });
    }
    if (url.pathname === "/v1.0/me/checkMemberGroups") {
      if (typeof who.groups === "number") return Response.json({}, { status: who.groups });
      return Response.json({ value: who.groups ?? [] });
    }
    return Response.json({}, { status: 404 });
  };
  return { requests, fetch: fetchImpl as typeof fetch };
}

function run(
  host: FakeHost,
  who: Person = PERSON,
  config: EntraConfig = settings(),
): Promise<ExchangeOutcome> & { graph: ReturnType<typeof graphFor> } {
  const graph = graphFor(who);
  const claims: EntraIdClaims = {
    tid: TENANT,
    oid: OID,
    name: who.name,
    email: who.mail,
    preferredUsername: who.mail,
    roles: who.roles ?? [],
  };
  const deps: ExchangeDeps = {
    verify: async () => ({ ok: true, claims }),
    graph: { fetch: graph.fetch },
  };
  const outcome = runEntraExchange(
    host,
    config,
    { secret: SECRET, body: { idToken: "unit-id-token", accessToken: "unit-access-token" } },
    deps,
  );
  return Object.assign(outcome, { graph });
}

/** The one audit line of the last exchange. */
function auditLine(host: FakeHost): string {
  const lines = host.log.info.mock.calls
    .map(([message]) => message)
    .filter((message) => message.startsWith("[entra] user="));
  expect(lines.length).toBeGreaterThan(0);
  return lines[lines.length - 1];
}

/** The row a first sign-in of OID created (as the concurrent winner). */
const entraRow = (overrides: Partial<Row> = {}): Row => ({
  id: 7,
  documentId: "doc-7",
  username: `entra-${OID}`,
  email: PERSON.mail,
  provider: "microsoft",
  blocked: false,
  displayName: PERSON.name,
  role: roleId("member"),
  roleSource: "entra",
  entraAppliedRole: "member",
  entraTenantId: TENANT,
  microsoftOid: OID,
  entraManagerOid: null,
  ...overrides,
});

describe("runEntraExchange: concurrent first sign-ins (spec F)", () => {
  it("continues as the existing user when the e-mail check already sees the winner's row", async () => {
    // The identity lookup ran before the concurrent exchange committed its
    // row; the e-mail check runs after it and finds that very row.
    const host = fakeHost([entraRow()], { identityMisses: 1 });
    const outcome = await run(host);
    expect(outcome.status).toBe(200);
    expect(outcome.status === 200 && outcome.body.user).toEqual({
      id: 7,
      displayName: PERSON.name,
      email: PERSON.mail,
    });
    expect(host.calls.create).toBe(0);
    expect(auditLine(host)).toMatch(/^\[entra\] user=7 oid=00000001 result=existing role=keep /);
    expect(host.users).toHaveLength(1);
  });

  it("still answers 409 when the address belongs to another row", async () => {
    const local = { id: 3, email: PERSON.mail.toUpperCase(), provider: "local", role: 5 };
    const host = fakeHost([local]);
    const outcome = await run(host);
    expect([outcome.status, outcome.body]).toEqual([409, { error: "account_exists" }]);
    expect(host.calls.create).toBe(0);
    expect(auditLine(host)).toMatch(/result=conflict/);
  });

  it("continues as the existing user when the create lost the unique index", async () => {
    // Both lookups missed; the insert then hit up_users_entra_identity_uq.
    const host = fakeHost([entraRow({ email: "other@entra.unit.test" })], { identityMisses: 1 });
    const outcome = await run(host, { ...PERSON, mail: "fresh@entra.unit.test" });
    expect(outcome.status).toBe(200);
    expect(host.calls.create).toBe(1);
    expect(host.users).toHaveLength(1);
    expect(auditLine(host)).toMatch(/user=7 .*result=existing/);
  });
});

describe("runEntraExchange: role writes are atomic (spec I)", () => {
  it("creates a new identity inside one transaction (row and role link commit together)", async () => {
    const host = fakeHost();
    const outcome = await run(host);
    expect(outcome.status).toBe(200);
    expect([host.calls.create, host.calls.createInTransaction]).toEqual([1, 1]);
    expect(host.users[0]).toMatchObject({
      role: roleId("member"),
      roleSource: "entra",
      entraAppliedRole: "member",
    });
  });

  it("decides on a fresh read inside the transaction, not on a half-written row", async () => {
    // A concurrent promotion committed entraAppliedRole but not yet the role
    // link when this exchange first read the row. Decided on that read, the
    // user would have flipped to manual for good.
    const host = fakeHost(
      [entraRow({ role: roleId("admin_role"), entraAppliedRole: "admin_role" })],
      { torn: { role: roleId("member") } },
    );
    const outcome = await run(host, { ...PERSON, roles: ["Intranet.Admin"] });
    expect(outcome.status).toBe(200);
    expect(auditLine(host)).toMatch(/result=existing role=keep /);
    expect(host.users[0]).toMatchObject({
      role: roleId("admin_role"),
      roleSource: "entra",
      entraAppliedRole: "admin_role",
    });
    expect(host.calls.update.filter((call) => "roleSource" in call.data)).toEqual([]);
  });

  it("writes a role change inside the transaction, with the row locked on Postgres only", async () => {
    for (const dialect of ["postgres", "sqlite"]) {
      const host = fakeHost([entraRow()], { dialect });
      const outcome = await run(host, { ...PERSON, roles: ["Intranet.Editor"] });
      expect(outcome.status, dialect).toBe(200);
      const roleWrites = host.calls.update.filter((call) => "role" in call.data);
      expect(roleWrites, dialect).toEqual([
        {
          where: { id: 7 },
          data: { role: roleId("editor"), entraAppliedRole: "editor" },
          inTransaction: true,
        },
      ]);
      expect(host.calls.locks, dialect).toEqual(dialect === "postgres" ? [7] : []);
      // The profile sync stays outside (no aborted-transaction trap).
      expect(host.calls.update.filter((call) => !call.inTransaction).length).toBeGreaterThan(0);
    }
  });

  it("still flips a real admin change to manual, inside the transaction", async () => {
    const host = fakeHost([entraRow({ role: roleId("guest") })]);
    const outcome = await run(host, { ...PERSON, roles: ["Intranet.Admin"] });
    expect(outcome.status).toBe(200);
    expect(auditLine(host)).toMatch(/role=manual-override/);
    expect(host.users[0]).toMatchObject({
      role: roleId("guest"),
      roleSource: "manual",
      entraAppliedRole: null,
    });
    expect(host.calls.update.find((call) => "roleSource" in call.data)?.inTransaction).toBe(true);
  });
});
