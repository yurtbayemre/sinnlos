import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, inject, it, onTestFinished, vi } from "vitest";

import {
  createTestDatabase,
  createTestStrapi,
  testEngines,
  type TestDatabase,
} from "./harness.test.helper";

/**
 * The harness contract later suites rely on (the Entra provisioning suite,
 * FX40): a hermetic network with a stub seam, a hermetic env that no dotenv
 * file refills, restored process state, and databases that are gone once
 * dropped.
 */

/**
 * The contract test boots in its body (it asserts on the process before
 * and after the boot, so the boot cannot move to beforeAll). It is the
 * file's first boot: a cold @strapi/* require in a fresh fork, schema
 * creation and the first permission sync on a new database. It gets the
 * hook budget of vitest.integration.config.ts, not the 60 s test budget:
 * a timed-out body keeps running (vitest does not abort it) and leaks its
 * env and the running boot into the next case.
 */
const BOOT_BUDGET = 300_000;

describe.each(testEngines())("integration harness on %s", (engine) => {
  const databaseExists = async (database: TestDatabase) => {
    if (engine === "sqlite") {
      return existsSync(join(inject("sinnlosCmsBuild"), database.env.DATABASE_FILENAME));
    }
    const probe = await createTestDatabase("postgres");
    try {
      const rows = await probe.sql(
        "SELECT 1 FROM information_schema.schemata WHERE schema_name = ?",
        [database.env.DATABASE_SCHEMA],
      );
      return rows.length > 0;
    } finally {
      await probe.drop();
    }
  };

  it("refuses outbound requests, serves them through `outbound`, ignores dotenv files, and restores the process", async () => {
    // A dotenv file the boot must not read: a shell ENV_PATH (or a
    // <cwd>/.env) would refill keys the hermetic base deletes. @strapi/core
    // loads it once per fork, when the first boot requires @strapi/strapi:
    // this case on the first engine (later boots find the module cached).
    const dotenvFile = join(inject("sinnlosCmsBuild"), `shell-${engine}-${process.pid}.env`);
    writeFileSync(dotenvFile, "SMTP_HOST=smtp.dotenv.invalid\n");
    vi.stubEnv("ENV_PATH", dotenvFile);
    onTestFinished(() => {
      vi.unstubAllEnvs();
      rmSync(dotenvFile, { force: true });
    });
    const envBefore = process.env.DATABASE_CLIENT;
    const fetchBefore = globalThis.fetch;
    const listenersBefore = process
      .eventNames()
      .map((event) => [event, process.listenerCount(event)]);
    const database = await createTestDatabase(engine);

    const t = await createTestStrapi({
      database,
      fixtures: false,
      outbound: (request) =>
        new URL(request.url).hostname === "graph.stub.invalid"
          ? new Response(JSON.stringify({ served: true }), {
              headers: { "content-type": "application/json" },
            })
          : undefined,
    });
    expect(process.env.DATABASE_CLIENT).toBe(engine === "sqlite" ? "sqlite" : "postgres");
    expect(process.env.SMTP_HOST).toBeUndefined();
    await expect(createTestStrapi({ engine })).rejects.toThrow("already running");

    const served = await fetch("https://graph.stub.invalid/v1.0/me");
    expect(await served.json()).toEqual({ served: true });
    await expect(fetch("https://registry.npmjs.org/")).rejects.toThrow("outbound request refused");
    expect((await t.api(null, "/_health")).status).toBe(204);

    await expect(t.stop()).rejects.toThrow(
      "tried to reach the network: GET https://registry.npmjs.org/",
    );
    expect(process.env.DATABASE_CLIENT).toBe(envBefore);
    expect(process.env.ENV_PATH).toBe(dotenvFile);
    expect(globalThis.fetch).toBe(fetchBefore);
    expect(process.eventNames().map((event) => [event, process.listenerCount(event)])).toEqual(
      listenersBefore,
    );

    // A database passed in outlives the boot; drop() removes it.
    const [roles] = await database.sql<{ n: number | string }>(
      "SELECT count(*) AS n FROM up_roles",
    );
    expect(Number(roles.n)).toBe(8);
    expect(await databaseExists(database)).toBe(true);
    await database.drop();
    expect(await databaseExists(database)).toBe(false);
  }, BOOT_BUDGET);
});
