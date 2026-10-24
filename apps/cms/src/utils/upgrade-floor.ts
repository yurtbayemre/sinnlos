/**
 * Boot guard for the upgrade floor (v0.29): this release upgrades only from
 * v0.25.x or later (owner decision 2026-10-22). The one-time repairs and
 * rollback probes for older databases are gone with v0.29; a database that
 * predates v0.25 is upgraded through v0.28.x first (docs/UPGRADE.md).
 *
 * The signal is the shape of up_users: v0.25.0 added oidc_subject (the OIDC
 * identity, users-permissions user schema). An existing up_users without it
 * is older, whatever its row count (an instance can hold content and no
 * users). A fresh database has no up_users table yet; Strapi creates it,
 * with the column, in the schema sync after register().
 *
 * Runs FIRST in register(), before the draft & publish guards and before
 * Strapi's beforeSync hook and schema sync would touch the old database (the
 * knex connection exists by then: the Database constructor; see
 * utils/org-dp-guard.ts for the lifecycle). getSchemaConnection() applies
 * DATABASE_SCHEMA; SQLite and Postgres answer hasTable/hasColumn alike.
 */
export const UPGRADE_FLOOR_MESSAGE =
  "[upgrade] This database predates v0.25 (up_users has no oidc_subject column). This release " +
  "upgrades only from v0.25.x or later: upgrade to v0.28.x first, then to this release " +
  "(docs/UPGRADE.md). Nothing was changed.";

/** The slice of the Strapi instance the guard reads. */
export interface UpgradeFloorHost {
  db: {
    getSchemaConnection(): {
      hasTable(table: string): PromiseLike<boolean>;
      hasColumn(table: string, column: string): PromiseLike<boolean>;
    };
  };
}

export async function assertUpgradeFloor(strapi: UpgradeFloorHost): Promise<void> {
  if (!(await strapi.db.getSchemaConnection().hasTable("up_users"))) return;
  if (await strapi.db.getSchemaConnection().hasColumn("up_users", "oidc_subject")) return;
  throw new Error(UPGRADE_FLOOR_MESSAGE);
}
