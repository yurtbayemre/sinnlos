/**
 * The (tenant, object id) identity of Entra users is backed by a real
 * database constraint (D-ENTRA-01 spec F): two concurrent first sign-ins of
 * one person race to create the row, and this index lets exactly one win
 * (entra/provision.ts re-reads and continues with the winner's row).
 *
 *   CREATE UNIQUE INDEX IF NOT EXISTS up_users_entra_identity_uq
 *     ON up_users (entra_tenant_id, microsoft_oid) WHERE microsoft_oid IS NOT NULL
 *
 * A schema `unique: true` would not do: Strapi checks it in the entity
 * validator only, never in the database, and never for db.query writes.
 * Ensured on EVERY boot, with Entra on or off, on Postgres and SQLite:
 *   - NULL tenants are distinct, so legacy rows with a microsoftOid but no
 *     tenant never collide (and are never matched by the exchange);
 *   - Strapi's schema sync never drops an index it did not create (it only
 *     removes indexes its stored schema had, @strapi/database 5.55.1
 *     schema/diff.js diffTableIndexes), and a SQLite table rebuild that lost
 *     it gets it back on the same boot, because bootstrap runs after sync.
 * Table and column names come from Strapi's metadata (up_users,
 * entra_tenant_id, microsoft_oid today).
 *
 * A failure is logged; with Entra enabled it also fails the boot, because
 * the exchange relies on the constraint.
 */

export const ENTRA_IDENTITY_INDEX = "up_users_entra_identity_uq";

const USER_UID = "plugin::users-permissions.user";

/** The slice of the Strapi instance the index needs. */
export interface IdentityIndexHost {
  db: {
    connection: { raw(sql: string): PromiseLike<unknown> };
    dialect: { client: string };
    getSchemaName(): string | undefined | null;
    metadata: {
      get(uid: string): {
        tableName: string;
        attributes: Record<string, { columnName?: string } | undefined>;
      };
    };
  };
  log: { info(message: string): void; error(message: string): void };
}

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

export interface IdentityIndexTarget {
  client: string;
  /** Postgres schema (DATABASE_SCHEMA); ignored on SQLite. */
  schema: string;
  table: string;
  tenantColumn: string;
  oidColumn: string;
}

/** The DDL for one database; throws for a client other than Postgres or SQLite. */
export function identityIndexSql(target: IdentityIndexTarget): string {
  const columns = `(${quote(target.tenantColumn)}, ${quote(target.oidColumn)})`;
  const where = `WHERE ${quote(target.oidColumn)} IS NOT NULL`;
  if (target.client === "postgres") {
    return `CREATE UNIQUE INDEX IF NOT EXISTS ${quote(ENTRA_IDENTITY_INDEX)} ON ${quote(target.schema)}.${quote(target.table)} ${columns} ${where}`;
  }
  if (target.client === "sqlite") {
    return `CREATE UNIQUE INDEX IF NOT EXISTS ${quote(ENTRA_IDENTITY_INDEX)} ON ${quote(target.table)} ${columns} ${where}`;
  }
  throw new Error(`database client ${target.client} is not supported (Postgres or SQLite)`);
}

function targetOf(strapi: IdentityIndexHost): IdentityIndexTarget {
  const meta = strapi.db.metadata.get(USER_UID);
  const column = (attribute: string, fallback: string) =>
    meta.attributes[attribute]?.columnName ?? fallback;
  return {
    client: strapi.db.dialect.client,
    schema: strapi.db.getSchemaName() || "public",
    table: meta.tableName,
    tenantColumn: column("entraTenantId", "entra_tenant_id"),
    oidColumn: column("microsoftOid", "microsoft_oid"),
  };
}

/**
 * Creates the index when it is missing. Returns whether it exists now.
 * Throws only when `entraEnabled` and it could not be ensured.
 */
export async function ensureEntraIdentityIndex(
  strapi: IdentityIndexHost,
  { entraEnabled }: { entraEnabled: boolean },
): Promise<boolean> {
  try {
    await strapi.db.connection.raw(identityIndexSql(targetOf(strapi)));
    return true;
  } catch (err) {
    const message =
      `[entra] could not ensure the unique index ${ENTRA_IDENTITY_INDEX} on the users table: ` +
      `${(err as Error).message}. Concurrent first sign-ins could create duplicate accounts.`;
    strapi.log.error(message);
    if (entraEnabled) {
      throw new Error(`${message} Refusing to start with ENTRA_ENABLED=1.`);
    }
    return false;
  }
}
