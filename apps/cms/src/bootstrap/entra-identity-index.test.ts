import { afterEach, describe, expect, it, vi } from "vitest";
import { openSqliteEngine, type SqliteEngine } from "../test/sqlite-engine.test.helper";
import {
  ENTRA_IDENTITY_INDEX,
  ensureEntraIdentityIndex,
  identityIndexSql,
  type IdentityIndexHost,
} from "./entra-identity-index";

/**
 * D-ENTRA-01 spec F: the (tenant, object id) unique index. The SQL per
 * database, and its behaviour on @strapi/database 5.55.1 with SQLite
 * (Postgres: integration/provision.integration.test.ts, which boots the
 * real cms on both).
 */
const USER = "plugin::users-permissions.user";
const TENANT = "11111111-2222-4333-8444-555555555555";
const OID = "0f0f0f0f-1e1e-4d2d-8c3c-4b4b4b4b4b4b";

describe("identityIndexSql", () => {
  const target = {
    schema: "public",
    table: "up_users",
    tenantColumn: "entra_tenant_id",
    oidColumn: "microsoft_oid",
  };

  it("builds the partial unique index for Postgres, schema-qualified", () => {
    expect(identityIndexSql({ ...target, client: "postgres", schema: "tenant_a" })).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "up_users_entra_identity_uq" ON "tenant_a"."up_users" ("entra_tenant_id", "microsoft_oid") WHERE "microsoft_oid" IS NOT NULL',
    );
  });

  it("builds the same index for SQLite, without a schema", () => {
    expect(identityIndexSql({ ...target, client: "sqlite" })).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "up_users_entra_identity_uq" ON "up_users" ("entra_tenant_id", "microsoft_oid") WHERE "microsoft_oid" IS NOT NULL',
    );
  });

  it("refuses other databases", () => {
    expect(() => identityIndexSql({ ...target, client: "mysql" })).toThrow(/not supported/);
  });
});

/** The user table reduced to the identity columns (+ one to add later). */
function userModel(extra: Record<string, { type: string }> = {}) {
  return {
    uid: USER,
    singularName: "user",
    tableName: "up_users",
    attributes: {
      id: { type: "increments" },
      documentId: { type: "string" },
      username: { type: "string" },
      microsoftOid: { type: "string" },
      entraTenantId: { type: "string" },
      ...extra,
    },
  };
}

function hostFor(engine: SqliteEngine) {
  const log = { info: vi.fn(), error: vi.fn() };
  const host: IdentityIndexHost = {
    db: {
      connection: engine.db.connection,
      dialect: { client: "sqlite" },
      getSchemaName: () => null,
      metadata: engine.db.metadata as unknown as IdentityIndexHost["db"]["metadata"],
    },
    log,
  };
  return { host, log };
}

async function indexNames(db: SqliteEngine["db"]): Promise<string[]> {
  const rows = (await db.connection.raw(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'up_users'",
  )) as { name: string }[];
  return rows.map((row) => row.name);
}

describe("ensureEntraIdentityIndex on SQLite (@strapi/database 5.55.1)", () => {
  let engine: SqliteEngine | undefined;

  afterEach(async () => {
    await engine?.close();
    engine = undefined;
  });

  it("creates the index once, and a second run is a no-op", async () => {
    engine = await openSqliteEngine([userModel()], { schema: "sync" });
    const { host, log } = hostFor(engine);
    expect(await ensureEntraIdentityIndex(host, { entraEnabled: false })).toBe(true);
    expect(await ensureEntraIdentityIndex(host, { entraEnabled: true })).toBe(true);
    expect(await indexNames(engine.db)).toContain(ENTRA_IDENTITY_INDEX);
    expect(log.error).not.toHaveBeenCalled();
  }, 30_000);

  it("rejects a duplicate (tenant, oid), allows NULL tenants and NULL oids", async () => {
    engine = await openSqliteEngine([userModel()], { schema: "sync" });
    await ensureEntraIdentityIndex(hostFor(engine).host, { entraEnabled: true });
    const users = engine.db.query(USER);
    await users.create({
      data: { username: "a", documentId: "d1", entraTenantId: TENANT, microsoftOid: OID },
    });
    await expect(
      users.create({
        data: { username: "b", documentId: "d2", entraTenantId: TENANT, microsoftOid: OID },
      }),
    ).rejects.toThrow(/UNIQUE/i);
    // Legacy rows (an oid, no tenant) never collide, and neither do local rows.
    await users.create({
      data: { username: "c", documentId: "d3", entraTenantId: null, microsoftOid: OID },
    });
    await users.create({
      data: { username: "d", documentId: "d4", entraTenantId: null, microsoftOid: OID },
    });
    await users.create({ data: { username: "e", documentId: "d5" } });
    await users.create({ data: { username: "f", documentId: "d6", entraTenantId: TENANT } });
    await users.create({ data: { username: "g", documentId: "d7", entraTenantId: TENANT } });
    // Another tenant with the same oid is another identity.
    await users.create({
      data: {
        username: "h",
        documentId: "d8",
        entraTenantId: "99999999-8888-4777-8666-555555555555",
        microsoftOid: OID,
      },
    });
    expect(await users.count()).toBe(7);
  }, 30_000);

  it("survives a schema sync that adds a column (Strapi never drops an index it did not create)", async () => {
    engine = await openSqliteEngine([userModel()], { schema: "sync" });
    await ensureEntraIdentityIndex(hostFor(engine).host, { entraEnabled: true });
    const db = await engine.reopen([userModel({ entraManagerOid: { type: "string" } })]);
    expect(await db.schema.sync()).toBe("CHANGED");
    expect(await indexNames(db)).toContain(ENTRA_IDENTITY_INDEX);
  }, 30_000);

  it("logs a failure, and fails the boot only with Entra on", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const broken: IdentityIndexHost = {
      db: {
        connection: {
          raw: async () => Promise.reject(new Error("permission denied for table up_users")),
        },
        dialect: { client: "postgres" },
        getSchemaName: () => "public",
        metadata: { get: () => ({ tableName: "up_users", attributes: {} }) },
      },
      log,
    };
    expect(await ensureEntraIdentityIndex(broken, { entraEnabled: false })).toBe(false);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining(ENTRA_IDENTITY_INDEX));
    await expect(ensureEntraIdentityIndex(broken, { entraEnabled: true })).rejects.toThrow(
      /Refusing to start with ENTRA_ENABLED=1/,
    );
  });

  it("reads the table and column names from Strapi's metadata", async () => {
    const statements: string[] = [];
    const host: IdentityIndexHost = {
      db: {
        connection: {
          raw: async (sql: string) => {
            statements.push(sql);
          },
        },
        dialect: { client: "postgres" },
        getSchemaName: () => null,
        metadata: {
          get: () => ({
            tableName: "users_x",
            attributes: {
              entraTenantId: { columnName: "tid_x" },
              microsoftOid: { columnName: "oid_x" },
            },
          }),
        },
      },
      log: { info: vi.fn(), error: vi.fn() },
    };
    await ensureEntraIdentityIndex(host, { entraEnabled: false });
    expect(statements).toEqual([
      'CREATE UNIQUE INDEX IF NOT EXISTS "up_users_entra_identity_uq" ON "public"."users_x" ("tid_x", "oid_x") WHERE "oid_x" IS NOT NULL',
    ]);
  });
});
