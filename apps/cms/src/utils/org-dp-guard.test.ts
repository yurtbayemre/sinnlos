/**
 * Boot guard for the department/team draft & publish switch (decision 05).
 * The fake mirrors the three calls the guard makes on @strapi/database:
 * getSchemaConnection().hasTable(), getConnection(table).whereNull().count().
 * It has no raw `connection`, so a guard that bypassed DATABASE_SCHEMA by
 * using knex directly would crash here.
 */
import { describe, expect, it } from "vitest";

import {
  ORG_DP_UIDS,
  assertNoOrgDrafts,
  orgDraftRowsMessage,
  type OrgDpGuardHost,
} from "./org-dp-guard";

const DEPARTMENT = "api::department.department";
const TEAM = "api::team.team";

interface FakeTable {
  exists?: boolean;
  /** What the driver returns for count(*): pg a string, SQLite a number. */
  drafts?: number | string;
}

interface Options {
  flags?: Partial<Record<string, boolean | undefined>>;
  collections?: Partial<Record<string, string>>;
  tables?: Record<string, FakeTable>;
  missingModels?: string[];
}

function fakeStrapi(options: Options = {}) {
  const calls = {
    hasTable: [] as string[],
    getConnection: [] as string[],
    whereNull: [] as string[],
    count: [] as { n: string }[],
  };
  const collections: Record<string, string> = {
    [DEPARTMENT]: "departments",
    [TEAM]: "teams",
    ...options.collections,
  };
  const flags = { [DEPARTMENT]: false, [TEAM]: false, ...options.flags };
  const tables = options.tables ?? {};

  const strapi: OrgDpGuardHost = {
    getModel: (uid) =>
      options.missingModels?.includes(uid)
        ? undefined
        : { collectionName: collections[uid], options: { draftAndPublish: flags[uid] } },
    db: {
      getSchemaConnection: () => ({
        hasTable: async (table) => {
          calls.hasTable.push(table);
          return tables[table]?.exists ?? true;
        },
      }),
      getConnection: (table) => {
        calls.getConnection.push(table);
        return {
          whereNull: (column) => {
            calls.whereNull.push(column);
            return {
              count: async (spec) => {
                calls.count.push(spec);
                return [{ n: tables[table]?.drafts ?? 0 }];
              },
            };
          },
        };
      },
    },
  };
  return { strapi, calls };
}

describe("assertNoOrgDrafts", () => {
  it("guards exactly department and team", () => {
    expect([...ORG_DP_UIDS]).toEqual([DEPARTMENT, TEAM]);
  });

  it("makes no database call while both types still have draftAndPublish on", async () => {
    const { strapi, calls } = fakeStrapi({
      flags: { [DEPARTMENT]: true, [TEAM]: true },
      tables: { departments: { drafts: 5 }, teams: { drafts: 5 } },
    });
    await expect(assertNoOrgDrafts(strapi)).resolves.toBeUndefined();
    expect(calls.hasTable).toEqual([]);
    expect(calls.getConnection).toEqual([]);
  });

  it("treats a missing flag like draftAndPublish on (only an explicit false is guarded)", async () => {
    const { strapi, calls } = fakeStrapi({
      flags: { [DEPARTMENT]: undefined, [TEAM]: undefined },
    });
    await assertNoOrgDrafts(strapi);
    expect(calls.hasTable).toEqual([]);
  });

  it("skips a type whose model is not registered", async () => {
    const { strapi, calls } = fakeStrapi({ missingModels: [DEPARTMENT, TEAM] });
    await assertNoOrgDrafts(strapi);
    expect(calls.hasTable).toEqual([]);
  });

  it("resolves on a fresh install (tables missing) without counting", async () => {
    const { strapi, calls } = fakeStrapi({
      tables: { departments: { exists: false }, teams: { exists: false } },
    });
    await expect(assertNoOrgDrafts(strapi)).resolves.toBeUndefined();
    expect(calls.hasTable).toEqual(["departments", "teams"]);
    expect(calls.getConnection).toEqual([]);
  });

  it("resolves when no row has published_at IS NULL", async () => {
    const { strapi, calls } = fakeStrapi({
      tables: { departments: { drafts: "0" }, teams: { drafts: 0 } },
    });
    await expect(assertNoOrgDrafts(strapi)).resolves.toBeUndefined();
    expect(calls.getConnection).toEqual(["departments", "teams"]);
    expect(calls.whereNull).toEqual(["published_at", "published_at"]);
    expect(calls.count).toEqual([{ n: "*" }, { n: "*" }]);
  });

  it("rejects when departments holds draft rows (Postgres count as string)", async () => {
    const { strapi } = fakeStrapi({ tables: { departments: { drafts: "3" } } });
    const result = assertNoOrgDrafts(strapi);
    await expect(result).rejects.toThrow(/^\[org-dp\] departments still holds 3 draft row\(s\)/);
    await expect(result).rejects.toThrow("infra/migrations/org-dp/migrate.sql");
    await expect(result).rejects.toThrow('"One-time: org draft/publish off"');
  });

  it("rejects when teams holds draft rows (SQLite count as number)", async () => {
    const { strapi } = fakeStrapi({ tables: { teams: { drafts: 2 } } });
    const result = assertNoOrgDrafts(strapi);
    await expect(result).rejects.toThrow(/^\[org-dp\] teams still holds 2 draft row\(s\)/);
    await expect(result).rejects.toThrow("infra/migrations/org-dp/migrate.sql");
  });

  it("checks both types even when the first one passes", async () => {
    const { strapi, calls } = fakeStrapi({
      tables: { departments: { drafts: 0 }, teams: { drafts: 1 } },
    });
    await expect(assertNoOrgDrafts(strapi)).rejects.toThrow("teams still holds 1 draft row(s)");
    expect(calls.getConnection).toEqual(["departments", "teams"]);
  });

  it("names every blocking table in one error", async () => {
    const { strapi } = fakeStrapi({
      tables: { departments: { drafts: 4 }, teams: { drafts: "7" } },
    });
    await expect(assertNoOrgDrafts(strapi)).rejects.toThrow(
      `${orgDraftRowsMessage("departments", 4)}\n${orgDraftRowsMessage("teams", 7)}`,
    );
  });

  it("still guards the other type when one keeps draftAndPublish on", async () => {
    const { strapi, calls } = fakeStrapi({
      flags: { [DEPARTMENT]: true },
      tables: { departments: { drafts: 9 }, teams: { drafts: 1 } },
    });
    await expect(assertNoOrgDrafts(strapi)).rejects.toThrow(/^\[org-dp\] teams /);
    expect(calls.hasTable).toEqual(["teams"]);
  });

  it("reads the table name from the model (collectionName)", async () => {
    const { strapi, calls } = fakeStrapi({
      collections: { [DEPARTMENT]: "org_departments" },
      tables: { org_departments: { drafts: 1 } },
    });
    await expect(assertNoOrgDrafts(strapi)).rejects.toThrow("org_departments still holds 1");
    expect(calls.hasTable[0]).toBe("org_departments");
  });
});
