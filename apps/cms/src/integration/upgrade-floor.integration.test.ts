import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestDatabase,
  createTestStrapi,
  testEngines,
  type TestDatabase,
} from "./harness.test.helper";

/**
 * The upgrade floor guard (v0.29, utils/upgrade-floor.ts) on the real boot:
 * an up_users without oidc_subject (a database from before v0.25) is refused
 * in register(), with or without rows, before Strapi's schema sync could add
 * the column; with the table gone the same database boots fresh. On
 * Postgres the harness runs in its own DATABASE_SCHEMA, so the check reads
 * that schema, not public.
 */
const BOOT_BUDGET = 180_000;
const REFUSED = /\[upgrade\] This database predates v0\.25 \(up_users has no oidc_subject column\)/;

describe.each(testEngines())("the upgrade floor guard on %s", (engine) => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase(engine);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it(
    "refuses an old-shaped up_users, empty or with rows, and leaves it as it was",
    async () => {
      await database.sql("CREATE TABLE up_users (id integer PRIMARY KEY, username varchar(255))");
      await expect(createTestStrapi({ database, fixtures: false })).rejects.toThrow(REFUSED);

      await database.sql("INSERT INTO up_users (id, username) VALUES (1, 'before-v025')");
      await expect(createTestStrapi({ database, fixtures: false })).rejects.toThrow(REFUSED);

      // Refused before the schema sync: no column added, the row intact.
      await expect(database.sql("SELECT oidc_subject FROM up_users")).rejects.toThrow();
      expect(await database.sql("SELECT username FROM up_users")).toEqual([
        { username: "before-v025" },
      ]);
    },
    BOOT_BUDGET,
  );

  it(
    "boots the same database fresh once up_users is gone",
    async () => {
      await database.sql("DROP TABLE up_users");
      const t = await createTestStrapi({ database, fixtures: false });
      try {
        const columns = await database.sql("SELECT oidc_subject FROM up_users");
        expect(Array.isArray(columns)).toBe(true);
      } finally {
        await t.stop();
      }
    },
    BOOT_BUDGET,
  );
});
