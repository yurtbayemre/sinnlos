import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestStrapi, testEngines, type TestStrapi } from "./harness.test.helper";

/**
 * v0.29 S8: the cron status in the real core store, on SQLite and Postgres
 * (a non-default schema there). It reads the rows with the filter
 * infra/ops-check.sh uses: key `plugin_sinnlos_cron:<task>`, type
 * `object`, environment and tag NULL; on Postgres schema-qualified.
 */

interface Registry {
  guardedTask(spec: {
    name: string;
    rule: string;
    tz: string;
    fn: (strapi: unknown) => Promise<void>;
  }): (context: { strapi: unknown }) => Promise<void>;
}
interface RunContext {
  reportRunFailure(err: unknown, detail?: string): void;
}

describe.each(testEngines())("cron status on %s", (engine) => {
  let t: TestStrapi;

  beforeAll(async () => {
    t = await createTestStrapi({ engine, fixtures: false });
  });

  afterAll(async () => {
    await t?.stop();
  });

  /** The ops-check query, as the script runs it. */
  async function statusRows(): Promise<Map<string, Record<string, unknown>>> {
    const schema = t.database.env.DATABASE_SCHEMA;
    const table =
      engine === "postgres"
        ? `"${schema!.replace(/"/g, '""')}".strapi_core_store_settings`
        : "strapi_core_store_settings";
    const rows = await t.database.sql<{ key: string; value: string }>(
      `select key, value from ${table} where key like 'plugin_sinnlos_cron:%' ` +
        "and type = 'object' and environment is null and tag is null",
    );
    return new Map(rows.map((row) => [row.key, JSON.parse(row.value) as Record<string, unknown>]));
  }

  it("writes the expected task set at boot", async () => {
    const expected = (await statusRows()).get("plugin_sinnlos_cron:expected");
    expect(expected).toMatchObject({ cronEnabled: true });
    const names = (expected!.tasks as { name: string; everyMinutes: number }[]).map((x) => x.name);
    expect(names).toContain("scheduled-publisher");
    expect(names).toContain("digest-mailer");
  });

  it("records concurrent runs under their own keys, failures included", async () => {
    // Per-engine names: the built module's write throttle is per process,
    // and both engines boot in this one.
    const clean = `it-clean-${engine}`;
    const rolled = `it-rolled-back-${engine}`;
    const { guardedTask } = t.requireBuilt<Registry>("src/cron/registry");
    const { reportRunFailure } = t.requireBuilt<RunContext>("src/cron/run-context");
    const db = (
      t.strapi as unknown as { db: { transaction(fn: () => Promise<void>): Promise<void> } }
    ).db;
    const cleanTask = guardedTask({
      name: clean,
      rule: "20 3 * * *",
      tz: "UTC",
      fn: async () => {},
    });
    // A failure reported inside a transaction that then rolls back is still
    // recorded: the outcome is written after the run, outside it.
    const rolledBack = guardedTask({
      name: rolled,
      rule: "20 3 * * *",
      tz: "UTC",
      fn: async () => {
        await db
          .transaction(async () => {
            reportRunFailure(new Error("one row failed"));
            throw new Error("rollback");
          })
          .catch(() => undefined);
      },
    });
    await Promise.all([cleanTask({ strapi: t.strapi }), rolledBack({ strapi: t.strapi })]);
    const rows = await statusRows();
    expect(rows.get(`plugin_sinnlos_cron:${clean}`)).toMatchObject({
      lastOutcome: "ok",
      lastFailedAt: null,
      everyMinutes: 1440,
    });
    expect(rows.get(`plugin_sinnlos_cron:${rolled}`)).toMatchObject({
      lastOutcome: "failed",
      everyMinutes: 1440,
    });
  });
});
