import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { backfillPollAudience, type PollAudienceBackfillHost } from "./poll-audience-backfill";

/**
 * The boot backfill against Strapi's real query engine (@strapi/database
 * 5.55.1 on better-sqlite3, the local-dev database; a temp file, because the
 * engine's SQLite dialect resolves the filename to a path, so no :memory:)
 * with more NULL poll rows than SQLite binds in one statement (32766). The
 * department populate of a manyToMany relation binds the ids of every row a
 * read returned as ONE IN list; a single read of all NULL rows therefore
 * threw 'too many SQL variables', the transaction rolled back and every
 * boot failed the same way (Codex review, P2). The backfill reads in pages.
 */

const POLL = "api::poll.poll";
const DOCUMENTS = 16_500; // 33,000 NULL rows (draft + published)

interface EngineKnex {
  raw(sql: string, bindings?: readonly unknown[]): Promise<unknown>;
  batchInsert(
    table: string,
    rows: readonly Record<string, unknown>[],
    chunkSize: number,
  ): Promise<unknown>;
}

interface QueryEngine {
  connection: EngineKnex;
  init(options: { models: unknown[] }): Promise<unknown>;
  schema: { create(): Promise<void> };
  query(uid: string): { findMany(params: Record<string, unknown>): Promise<unknown[]> };
  destroy(): Promise<void>;
}

/** The poll and department models as Strapi's schema sync sees them (the relevant attributes). */
const MODELS = [
  {
    uid: "api::department.department",
    singularName: "department",
    tableName: "departments",
    attributes: {
      id: { type: "increments" },
      documentId: { type: "string" },
      name: { type: "string" },
    },
  },
  {
    uid: POLL,
    singularName: "poll",
    tableName: "polls",
    attributes: {
      id: { type: "increments" },
      documentId: { type: "string" },
      audience: { type: "enumeration", enum: ["all", "departments"] },
      departments: {
        type: "relation",
        relation: "manyToMany",
        target: "api::department.department",
      },
    },
  },
];

const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function loadDatabase(): new (config: Record<string, unknown>) => QueryEngine {
  const requireFromCms = createRequire(join(__dirname, "..", "..", "package.json"));
  const requireFromStrapi = createRequire(requireFromCms.resolve("@strapi/strapi/package.json"));
  return (
    requireFromStrapi("@strapi/database") as {
      Database: new (config: Record<string, unknown>) => QueryEngine;
    }
  ).Database;
}

let db: QueryEngine | undefined;
let tempDir: string;

function engine(): QueryEngine {
  if (!db) throw new Error("no query engine");
  return db;
}

async function rows<T>(sql: string): Promise<T[]> {
  return (await engine().connection.raw(sql)) as T[];
}

beforeEach(async () => {
  const Database = loadDatabase();
  tempDir = mkdtempSync(join(tmpdir(), "sinnlos-poll-backfill-"));
  db = new Database({
    connection: {
      client: "sqlite",
      connection: { filename: join(tempDir, "cms.db") },
      useNullAsDefault: true,
    },
    // The engine creates its user-migration dir; none runs here.
    settings: { migrations: { dir: join(tempDir, "migrations") }, forceMigration: false },
    logger: quiet,
  });
  await db.init({ models: MODELS });
  await db.schema.create();
  await db.connection.raw("insert into departments (document_id, name) values ('dept-a', 'A')");
});

afterEach(async () => {
  await db?.destroy();
  db = undefined;
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Ids 1-2: the draft rows of two special documents; 3-33,002: 16,500
 * documents (every 1000th linked on both rows); 33,003-33,004: the
 * published rows of the special documents, in the last page.
 *  - p-split (first-boot case): linked draft, unlinked published row.
 *  - p-sibling: draft flagged 'departments' before the run (a republish on
 *    a previous cms), published row NULL without links.
 */
async function seed(): Promise<void> {
  const polls: Record<string, unknown>[] = [
    { document_id: "p-split", audience: null },
    { document_id: "p-sibling", audience: "departments" },
  ];
  for (let i = 0; i < DOCUMENTS; i += 1) {
    polls.push({ document_id: `d${i}`, audience: null }, { document_id: `d${i}`, audience: null });
  }
  polls.push(
    { document_id: "p-split", audience: null },
    { document_id: "p-sibling", audience: null },
  );
  await engine().connection.batchInsert("polls", polls, 500);

  const linked = await rows<{ id: number }>(
    "select id from polls where document_id = 'p-split' and id = 1 " +
      "union all select id from polls where document_id in " +
      `(${Array.from({ length: Math.ceil(DOCUMENTS / 1000) }, (_, k) => `'d${k * 1000}'`).join(", ")})`,
  );
  await engine().connection.batchInsert(
    "polls_departments_lnk",
    linked.map(({ id }) => ({ poll_id: id, department_id: 1, department_ord: 1 })),
    500,
  );
}

describe("backfillPollAudience on Strapi's query engine (SQLite, 33,003 NULL rows)", () => {
  it("one unpaged read of every NULL row with its departments exceeds SQLite's bind limit", async () => {
    await seed();
    // The precondition: the read the backfill did before its paging.
    await expect(
      engine()
        .query(POLL)
        .findMany({
          where: { audience: { $null: true } },
          select: ["id", "documentId"],
          populate: { departments: { select: ["id"] } },
        }),
    ).rejects.toThrow(/too many SQL variables/);
  }, 60_000);

  it("flags every row, classified exactly like one read, and logs one line", async () => {
    await seed();
    const info: string[] = [];
    const host = {
      db: engine(),
      log: { info: (message: string) => info.push(message) },
    } as unknown as PollAudienceBackfillHost;
    await backfillPollAudience(host);

    expect(
      await rows<{ audience: string | null; n: number }>(
        "select audience, count(*) as n from polls group by audience order by audience",
      ),
    ).toEqual([
      { audience: "all", n: 32_967 },
      { audience: "departments", n: 37 },
    ]);
    // p-split: the linked draft is restricted, its published row (flagged
    // in the same run, pages apart) is not pulled along; p-sibling's
    // published row follows its draft flagged before the run.
    expect(
      await rows<{ id: number; audience: string }>(
        "select id, audience from polls where document_id in ('p-split', 'p-sibling') order by id",
      ),
    ).toEqual([
      { id: 1, audience: "departments" },
      { id: 2, audience: "departments" },
      { id: 33_003, audience: "all" },
      { id: 33_004, audience: "departments" },
    ]);
    expect(info).toEqual([
      "[poll-audience] set the audience of 33003 existing poll row(s): 35 to 'departments' (they link a department), " +
        "1 to 'departments' (the other row of their poll is restricted), 32967 to 'all'",
    ]);

    // Steady state: the next boot finds nothing to do.
    await backfillPollAudience(host);
    expect(info).toHaveLength(1);
  }, 60_000);
});
