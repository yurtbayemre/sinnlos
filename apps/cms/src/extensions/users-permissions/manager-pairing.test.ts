import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteEngine, type SqliteEngine } from "../../test/sqlite-engine.test.helper";

/**
 * FX23: `user.manager` names `inversedBy: "directReports"`. Before, the
 * inverse side `directReports` (mappedBy "manager") had no join metadata:
 * populating it returned nothing, and the Direct reports card on
 * /people/[id] never rendered.
 *
 * Pinned against @strapi/database 5.55.1 on SQLite (the same sync ran on
 * Postgres 16 in the lane rehearsal, docs/architecture.md Nachtrag
 * 2026-09-28f):
 *   1. the schema pairs the two sides (infra/contracts.test.ts checks every
 *      pair),
 *   2. the upgrade is additive: the existing link table only gains the
 *      nullable order column `user_ord` (plus its index), every existing
 *      manager link survives and populates as directReports right away,
 *   3. a rollback to the unpaired schema leaves the table as it is (no
 *      DDL, forceMigration false) and keeps the links; a roll-forward is a
 *      no-op.
 */

const USER = "plugin::users-permissions.user";

const schemaFile = join(__dirname, "content-types", "user", "schema.json");

interface RelationAttribute {
  type: string;
  relation?: string;
  target?: string;
  inversedBy?: string;
  mappedBy?: string;
}

const userAttributes = () =>
  (
    JSON.parse(readFileSync(schemaFile, "utf8")) as {
      attributes: Record<string, RelationAttribute>;
    }
  ).attributes;

/** The owning side as it was before FX23 (no inversedBy key at all). */
function unpaired(attribute: RelationAttribute): RelationAttribute {
  const copy = { ...attribute };
  delete copy.inversedBy;
  return copy;
}

/** The user table as the engine sees it, reduced to the self relation. */
function userModel(paired: boolean) {
  const { manager, directReports } = userAttributes();
  return {
    uid: USER,
    singularName: "user",
    tableName: "up_users",
    attributes: {
      id: { type: "increments" },
      documentId: { type: "string" },
      username: { type: "string" },
      manager: paired ? manager : unpaired(manager),
      directReports,
    },
  };
}

interface LinkRow {
  user_id: number;
  inv_user_id: number;
  user_ord?: number | null;
}

describe("user.manager / directReports pairing (FX23)", () => {
  let engine: SqliteEngine | undefined;

  afterEach(async () => {
    await engine?.close();
    engine = undefined;
  });

  it("the schema pairs manager with directReports", () => {
    const { manager, directReports } = userAttributes();
    expect(manager).toEqual({
      type: "relation",
      relation: "manyToOne",
      target: USER,
      inversedBy: "directReports",
    });
    expect(directReports).toEqual({
      type: "relation",
      relation: "oneToMany",
      target: USER,
      mappedBy: "manager",
    });
  });

  it("upgrades additively: existing links survive and populate as directReports", async () => {
    engine = await openSqliteEngine([userModel(false)], { schema: "sync" });
    const old = engine.db.query(USER);
    const boss = await old.create({ data: { username: "boss", documentId: "d1" } });
    const ada = await old.create({ data: { username: "ada", documentId: "d2", manager: boss.id } });
    const linus = await old.create({
      data: { username: "linus", documentId: "d3", manager: boss.id },
    });
    const unpaired = (await old.findOne({
      where: { id: boss.id },
      populate: ["directReports"],
    })) as {
      directReports?: unknown;
    };
    expect(unpaired.directReports).toBeUndefined(); // the bug

    const db = await engine.reopen([userModel(true)]);
    const ddl: string[] = [];
    db.connection.on("query", (event: { sql: string }) => ddl.push(event.sql));
    expect(await db.schema.sync()).toBe("CHANGED");
    expect(ddl.filter((sql) => /^\s*(alter|create|drop)\b/i.test(sql))).toEqual([
      "alter table `up_users_manager_lnk` add column `user_ord` float null",
      "create index `up_users_manager_lnk_oifk` on `up_users_manager_lnk` (`user_ord`)",
    ]);

    const rows = (await db.connection.raw(
      "select user_id, inv_user_id, user_ord from up_users_manager_lnk order by id",
    )) as LinkRow[];
    expect(rows).toEqual([
      { user_id: ada.id, inv_user_id: boss.id, user_ord: null },
      { user_id: linus.id, inv_user_id: boss.id, user_ord: null },
    ]);
    const paired = (await db.query(USER).findOne({
      where: { id: boss.id },
      populate: ["directReports"],
    })) as { directReports: Array<{ username: string }> };
    expect(paired.directReports.map((u) => u.username).sort()).toEqual(["ada", "linus"]);
    const report = (await db
      .query(USER)
      .findOne({ where: { id: ada.id }, populate: ["manager"] })) as {
      manager: { username: string };
    };
    expect(report.manager.username).toBe("boss");
  }, 30_000);

  it("a rollback keeps the table and the links; the roll-forward is a no-op", async () => {
    engine = await openSqliteEngine([userModel(true)], { schema: "sync" });
    const q = engine.db.query(USER);
    const boss = await q.create({ data: { username: "boss", documentId: "d1" } });
    const grace = await q.create({
      data: { username: "grace", documentId: "d2", manager: boss.id },
    });

    const back = await engine.reopen([userModel(false)]);
    const ddl: string[] = [];
    back.connection.on("query", (event: { sql: string }) => ddl.push(event.sql));
    await back.schema.sync();
    expect(ddl.filter((sql) => /^\s*(alter|create|drop)\b/i.test(sql))).toEqual([]);
    const rolledBack = (await back
      .query(USER)
      .findOne({ where: { id: grace.id }, populate: ["manager"] })) as {
      manager: { username: string };
    };
    expect(rolledBack.manager.username).toBe("boss");

    const forward = await engine.reopen([userModel(true)]);
    expect(await forward.schema.sync()).toBe("UNCHANGED");
    const again = (await forward.query(USER).findOne({
      where: { id: boss.id },
      populate: ["directReports"],
    })) as { directReports: Array<{ username: string }> };
    expect(again.directReports.map((u) => u.username)).toEqual(["grace"]);
  }, 30_000);
});
