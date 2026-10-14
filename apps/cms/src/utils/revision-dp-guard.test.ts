/**
 * Boot guard for the wiki-revision draft & publish switch (batch 16, lane
 * 16D). The fake mirrors the three calls the guard makes on
 * @strapi/database, as in org-dp-guard.test.ts: getSchemaConnection()
 * .hasTable(), getConnection(table).whereNull().count(). No raw
 * `connection`, so a guard that bypassed DATABASE_SCHEMA would crash here.
 */
import { describe, expect, it } from "vitest";

import {
  REVISION_DP_UID,
  assertNoRevisionDrafts,
  revisionDraftRowsMessage,
  type RevisionDpGuardHost,
} from "./revision-dp-guard";

interface Options {
  flag?: boolean;
  missingModel?: boolean;
  collectionName?: string;
  exists?: boolean;
  /** What the driver returns for count(*): pg a string, SQLite a number. */
  drafts?: number | string;
}

function fakeStrapi(options: Options = {}) {
  const calls = { getModel: [] as string[], hasTable: [] as string[], whereNull: [] as string[] };
  const strapi: RevisionDpGuardHost = {
    getModel: (uid) => {
      calls.getModel.push(uid);
      if (options.missingModel) return undefined;
      return {
        collectionName: "collectionName" in options ? options.collectionName : "wiki_revisions",
        options: { draftAndPublish: "flag" in options ? options.flag : false },
      };
    },
    db: {
      getSchemaConnection: () => ({
        hasTable: async (table) => {
          calls.hasTable.push(table);
          return options.exists ?? true;
        },
      }),
      getConnection: () => ({
        whereNull: (column) => {
          calls.whereNull.push(column);
          return { count: async () => [{ n: options.drafts ?? 0 }] };
        },
      }),
    },
  };
  return { strapi, calls };
}

describe("assertNoRevisionDrafts", () => {
  it("guards wiki-revision", async () => {
    const { strapi, calls } = fakeStrapi();
    await assertNoRevisionDrafts(strapi);
    expect(calls.getModel).toEqual([REVISION_DP_UID]);
    expect(REVISION_DP_UID).toBe("api::wiki-revision.wiki-revision");
  });

  it("makes no database call while the model still has draft & publish on, or none", async () => {
    for (const options of [{ flag: true }, { flag: undefined }, { missingModel: true }]) {
      const { strapi, calls } = fakeStrapi({ ...options, drafts: 5 });
      await expect(assertNoRevisionDrafts(strapi)).resolves.toBeUndefined();
      expect(calls.hasTable).toEqual([]);
    }
  });

  it("resolves on a fresh install (no table) without counting", async () => {
    const { strapi, calls } = fakeStrapi({ exists: false, drafts: 5 });
    await expect(assertNoRevisionDrafts(strapi)).resolves.toBeUndefined();
    expect(calls.hasTable).toEqual(["wiki_revisions"]);
    expect(calls.whereNull).toEqual([]);
  });

  it("resolves when no row has published_at IS NULL", async () => {
    for (const drafts of [0, "0"]) {
      const { strapi, calls } = fakeStrapi({ drafts });
      await expect(assertNoRevisionDrafts(strapi)).resolves.toBeUndefined();
      expect(calls.whereNull).toEqual(["published_at"]);
    }
  });

  it("rejects with the count, the migration and the runbook (pg string, SQLite number)", async () => {
    for (const [drafts, n] of [
      ["3", 3],
      [2, 2],
    ] as const) {
      const { strapi } = fakeStrapi({ drafts });
      const result = assertNoRevisionDrafts(strapi);
      await expect(result).rejects.toThrow(revisionDraftRowsMessage("wiki_revisions", n));
    }
    expect(revisionDraftRowsMessage("wiki_revisions", 4)).toBe(
      "[revision-dp] wiki_revisions still holds 4 draft row(s). Booting would let Strapi delete " +
        "them (draftAndPublish true -> false). Run infra/migrations/wiki-revision-dp/migrate.sql " +
        'first, see docs/DEPLOYMENT.md "One-time: wiki revisions draft/publish off". Local SQLite: ' +
        "delete apps/cms/.tmp/data.db and reseed.",
    );
  });

  it("refuses a model without a table name", async () => {
    const { strapi } = fakeStrapi({ collectionName: undefined });
    await expect(assertNoRevisionDrafts(strapi)).rejects.toThrow(
      "[revision-dp] api::wiki-revision.wiki-revision has no collectionName",
    );
  });
});
