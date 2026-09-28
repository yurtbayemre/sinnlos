import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, inject, it } from "vitest";

import {
  createTestDatabase,
  createTestStrapi,
  testEngines,
  type TestDatabase,
} from "./harness.test.helper";

/**
 * The harness contract later suites rely on (the Entra provisioning suite,
 * FX40): a hermetic network with a stub seam, restored process state, and
 * databases that are gone once dropped.
 */
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

  it("refuses outbound requests, serves them through `outbound`, and restores the process", async () => {
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
    await expect(createTestStrapi({ engine })).rejects.toThrow("already running");

    const served = await fetch("https://graph.stub.invalid/v1.0/me");
    expect(await served.json()).toEqual({ served: true });
    await expect(fetch("https://registry.npmjs.org/")).rejects.toThrow("outbound request refused");
    expect((await t.api(null, "/_health")).status).toBe(204);

    await expect(t.stop()).rejects.toThrow(
      "tried to reach the network: GET https://registry.npmjs.org/",
    );
    expect(process.env.DATABASE_CLIENT).toBe(envBefore);
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
  });
});
