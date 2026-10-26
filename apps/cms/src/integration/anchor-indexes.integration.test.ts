import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTestDatabase,
  createTestStrapi,
  testEngines,
  type TestDatabase,
  type TestStrapi,
} from "./harness.test.helper";

/**
 * v0.31 (#171): the boot ensures the notification, comment and reaction
 * anchor indexes (bootstrap/document-indexes.ts) on both engines; a boot on
 * a database that lacks one (the first boot of v0.31) creates it, and a
 * boot that finds them all creates none.
 */

const ANCHORS: Record<string, string[]> = {
  notifications_source_type_source_document_id_idx: ["source_type", "source_document_id"],
  comments_target_type_target_document_id_idx: ["target_type", "target_document_id"],
  reactions_target_type_target_document_id_idx: ["target_type", "target_document_id"],
};

type Ensure = { ensureDocumentIndexes(strapi: unknown): Promise<string[]> };

/** The columns of index `name`, in order; [] when it does not exist. */
async function columnsOf(database: TestDatabase, name: string): Promise<string[]> {
  if (database.engine === "sqlite") {
    const rows = await database.sql<{ name: string }>(
      `SELECT name FROM pragma_index_info(?) ORDER BY seqno`,
      [name],
    );
    return rows.map((row) => row.name);
  }
  const [row] = await database.sql<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ?",
    [name],
  );
  const columns = row?.indexdef.match(/\(([^)]*)\)$/)?.[1];
  return columns ? columns.split(",").map((column) => column.trim()) : [];
}

describe.each(testEngines())("the anchor indexes (v0.31) on %s", (engine) => {
  let database: TestDatabase;
  let t: TestStrapi | undefined;

  beforeAll(async () => {
    database = await createTestDatabase(engine);
    t = await createTestStrapi({ database, fixtures: false });
  });

  afterAll(async () => {
    await t?.stop();
    await database?.drop();
  });

  it("exist on their two columns after the boot", async () => {
    for (const [name, columns] of Object.entries(ANCHORS)) {
      expect(await columnsOf(database, name), name).toEqual(columns);
    }
  });

  it("a later boot creates none; a boot that lacks one creates it again", async () => {
    const ensure = t!.requireBuilt<Ensure>("src/bootstrap/document-indexes");
    expect(await ensure.ensureDocumentIndexes(t!.strapi)).toEqual([]);
    await t!.stop();
    await database.sql('DROP INDEX "comments_target_type_target_document_id_idx"');
    expect(await columnsOf(database, "comments_target_type_target_document_id_idx")).toEqual([]);
    t = await createTestStrapi({ database, fixtures: false });
    for (const [name, columns] of Object.entries(ANCHORS)) {
      expect(await columnsOf(database, name), name).toEqual(columns);
    }
    const again = t.requireBuilt<Ensure>("src/bootstrap/document-indexes");
    expect(await again.ensureDocumentIndexes(t.strapi)).toEqual([]);
  });
});
