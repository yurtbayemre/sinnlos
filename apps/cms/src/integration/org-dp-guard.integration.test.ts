import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestDatabase,
  createTestStrapi,
  testEngines,
  type TestDatabase,
  type TestFixtures,
} from "./harness.test.helper";

/**
 * Restarts on one database:
 *   1. a second boot of the real bootstrap is idempotent: no new role, no
 *      new permission row, the accounts of the first boot still sign in
 *      (the add-only permission sync, the role seed, syncAdvancedSettings);
 *   2. the org-dp boot guard (decision 05, utils/org-dp-guard.ts) refuses to
 *      start while `departments` holds a draft row, BEFORE Strapi's
 *      draft & publish disable hook could delete it: the row is still there
 *      after the refused boot, and the next boot starts once it is gone
 *      (the runbook path).
 */

/**
 * Both tests boot in their body: warm restarts on the schema of the first
 * boot (1.5-2.5 s measured), but a Strapi boot all the same, so they carry
 * an explicit budget above the 60 s test default (docs/architecture.md
 * §5.40 "Last-Timeouts", §5.58).
 */
const RESTART_BUDGET = 120_000;

describe.each(testEngines())("restarts and the org-dp boot guard on %s", (engine) => {
  let database: TestDatabase;
  let fixtures: TestFixtures;
  let firstBoot: { roles: number; permissions: number };

  const counts = async () => {
    const [roles] = await database.sql<{ n: number | string }>(
      "SELECT count(*) AS n FROM up_roles",
    );
    const [permissions] = await database.sql<{ n: number | string }>(
      "SELECT count(*) AS n FROM up_permissions",
    );
    return { roles: Number(roles.n), permissions: Number(permissions.n) };
  };
  const draftDepartments = async () => {
    const [row] = await database.sql<{ n: number | string }>(
      "SELECT count(*) AS n FROM departments WHERE published_at IS NULL",
    );
    return Number(row.n);
  };

  beforeAll(async () => {
    database = await createTestDatabase(engine);
    const t = await createTestStrapi({ database });
    fixtures = t.fixtures;
    await t.stop();
    firstBoot = await counts();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it(
    "a second boot adds no role and no permission, and the accounts still sign in",
    async () => {
      expect(firstBoot.roles).toBe(8); // six intranet roles + authenticated + public
      expect(firstBoot.permissions).toBeGreaterThan(400);

      const t = await createTestStrapi({ database, fixtures: false });
      try {
        const member = fixtures.users.member;
        const jwt = await t.login(member.username, member.password);
        const me = await t.api<{ username?: string }>({ jwt }, "/api/users/me");
        expect(me.status).toBe(200);
        expect(me.body.username).toBe(member.username);
      } finally {
        await t.stop();
      }
      expect(await counts()).toEqual(firstBoot);
    },
    RESTART_BUDGET,
  );

  it(
    "refuses to boot while a department draft row exists, and boots once it is gone",
    async () => {
      // A draft row as a pre-decision-05 database (or a restored old backup)
      // has it, written while the cms is down.
      await database.sql(
        "INSERT INTO departments (document_id, name, slug, published_at) VALUES (?, ?, ?, NULL)",
        ["itdraftdepartment000000a", "IT Draft", "it-draft"],
      );
      expect(await draftDepartments()).toBe(1);

      await expect(createTestStrapi({ database, fixtures: false })).rejects.toThrow(
        /\[org-dp\] departments still holds 1 draft row\(s\)/,
      );
      // Refused before Strapi's beforeSync hook could delete the draft.
      expect(await draftDepartments()).toBe(1);

      await database.sql("DELETE FROM departments WHERE published_at IS NULL");
      const t = await createTestStrapi({ database, fixtures: false });
      try {
        const departments = await t.strapi.db
          .query("api::department.department")
          .findMany({ select: ["name"] });
        expect(departments.map((row) => row.name).sort()).toEqual(["IT Engineering", "IT Sales"]);
      } finally {
        await t.stop();
      }
    },
    RESTART_BUDGET,
  );
});
