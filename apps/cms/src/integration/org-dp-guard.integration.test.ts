import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthoringScope } from "../utils/document-lock";
import { storedRevision } from "./authoring.test.helper";
import {
  createTestDatabase,
  createTestStrapi,
  testEngines,
  type TestDatabase,
  type TestFixtures,
  type TestStrapi,
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

describe.each(testEngines())("single-row org authoring prerequisite on %s", (engine) => {
  let t: TestStrapi;
  let lock: Pick<typeof import("../utils/document-lock"), "runInAuthoringScope">;

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    lock = t.requireBuilt("src/utils/document-lock");
  });

  afterAll(async () => {
    await t?.stop();
  });

  for (const type of ["department", "team"] as const) {
    it.each([null, "2026-01-01T00:00:00.000Z"])(
      `${type}: status-free save preserves one row and its relations with publishedAt=%s`,
      async (publishedAt) => {
        const uid = `api::${type}.${type}`;
        const target =
          type === "department" ? t.fixtures.departments.engineering : t.fixtures.teams.platform;
        const { documentId } = target;
        const relationFields =
          type === "department" ? ["head", "members", "teams"] : ["department", "lead", "members"];
        const readRows = () =>
          t.strapi.db.query(uid).findMany({
            where: { documentId },
            select: ["id", "documentId", "description", "publishedAt"],
            populate: Object.fromEntries(relationFields.map((key) => [key, { select: ["id"] }])),
          });
        const trail = () =>
          t.strapi.db.query("api::audit-event.audit-event").findMany({
            where: { targetUid: uid, targetDocumentId: documentId },
            orderBy: { id: "asc" },
          });

        // Inject after boot: the permanent org-dp guard still refuses NULL rows on restart.
        await t.strapi.db.query(uid).update({ where: { documentId }, data: { publishedAt } });
        const revision = await storedRevision(t, uid, documentId);
        const before = await readRows();
        const auditBefore = await trail();
        expect(before).toHaveLength(1);
        expect(before[0].publishedAt == null).toBe(publishedAt === null);
        expect((await t.strapi.documents(uid).findOne({ documentId }))?.id).toBe(target.id);
        const relations = Object.fromEntries(relationFields.map((key) => [key, before[0][key]]));
        const classify = async () => {
          const row = await t.strapi.db
            .query(uid)
            .findOne({ where: { documentId }, select: ["id"] });
          return row?.id === target.id ? "moderator" : null;
        };
        const scope: AuthoringScope = {
          uid,
          documentId,
          expectedRevision: revision,
          observedRevision: revision,
          classify,
          roleClass: "moderator",
          source: "system",
        };
        const description = `Saved ${type} with publishedAt=${String(publishedAt)}`;
        const saved = await lock.runInAuthoringScope(scope, () =>
          t.strapi.documents(uid).update({ documentId, data: { description } }),
        );
        expect(saved).toMatchObject({ id: target.id, documentId, description });
        const after = await readRows();
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({ id: target.id, documentId, description, ...relations });
        expect(after[0].publishedAt).not.toBeNull();
        expect(await storedRevision(t, uid, documentId)).toBe(revision + 1);
        expect(scope.committedRevision).toBe(revision + 1);
        const auditAfter = await trail();
        expect(auditAfter.slice(auditBefore.length)).toEqual([
          expect.objectContaining({
            action: "update",
            revision: revision + 1,
            keys: ["description"],
            actorKind: "system",
            actorClass: "moderator",
            source: "system",
          }),
        ]);

        // The successful lock advances scope tokens, so retry with the original stale token.
        const stale: AuthoringScope = {
          ...scope,
          expectedRevision: revision,
          observedRevision: revision,
        };
        await expect(
          lock.runInAuthoringScope(stale, () =>
            t.strapi
              .documents(uid)
              .update({ documentId, data: { description: "Stale overwrite" } }),
          ),
        ).rejects.toMatchObject({ status: 412, details: { current: revision + 1 } });
        expect(await readRows()).toEqual(after);
        expect(await storedRevision(t, uid, documentId)).toBe(revision + 1);
        expect(await trail()).toEqual(auditAfter);
      },
    );
  }
});
