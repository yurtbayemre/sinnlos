import { expect } from "vitest";

import type { TestStrapi } from "./harness.test.helper";

/**
 * Postgres lock probes for the integration suites: a concurrent writer as a
 * second transaction that the test holds open, outside Strapi's
 * transaction context, and a wait until a statement of this boot's schema
 * waits for a lock. With both, a suite can put a write exactly into the
 * window between a hook's read and its delete, deterministically, and pin
 * what the lock of the code under test makes of it.
 *
 * Named *.test.helper.ts like harness.test.helper.ts: not a suite, not part
 * of the cms build.
 */

/** A raw knex transaction on Strapi's own pool. */
export interface HeldTransaction {
  raw(sql: string, bindings?: readonly unknown[]): Promise<unknown>;
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
}

interface KnexLike {
  transaction(): Promise<HeldTransaction>;
}

/** The Postgres schema of this boot; throws on SQLite. */
export function testSchema(t: TestStrapi): string {
  const schema = t.database.env.DATABASE_SCHEMA;
  if (t.engine !== "postgres" || !schema) {
    throw new Error("[integration] a Postgres lock probe needs a Postgres boot");
  }
  return schema;
}

/** `"<schema>"."<table>"` for raw SQL. */
export const qualified = (t: TestStrapi, table: string): string => `"${testSchema(t)}"."${table}"`;

/**
 * Opens a transaction on Strapi's knex pool (@strapi/database keeps the
 * knex instance as `db.connection`) that the test commits or rolls back.
 */
export async function holdTransaction(t: TestStrapi): Promise<HeldTransaction> {
  testSchema(t);
  const knex = (t.strapi.db as unknown as { connection: KnexLike }).connection;
  return knex.transaction();
}

/**
 * Resolves once some statement on this boot's schema waits for a lock
 * (pg_stat_activity; the schema name is in every statement Strapi sends).
 */
export async function waitForLockWait(t: TestStrapi, timeout = 10_000): Promise<void> {
  const schema = testSchema(t);
  await expect
    .poll(
      async () => {
        const [row] = await t.database.sql<{ n: number | string }>(
          "SELECT count(*) AS n FROM pg_stat_activity " +
            "WHERE wait_event_type = 'Lock' AND position(? in query) > 0",
          [schema],
        );
        return Number(row?.n ?? 0);
      },
      { timeout, interval: 50 },
    )
    .toBeGreaterThan(0);
}

/** How a promise ended. */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** A promise's outcome, without an unhandled rejection while the test waits. */
export function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value): Settled<T> => ({ ok: true, value }),
    (error: unknown): Settled<T> => ({ ok: false, error }),
  );
}
