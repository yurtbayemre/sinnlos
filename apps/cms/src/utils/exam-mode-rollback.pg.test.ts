import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PG_URL, uniqueSchema } from "../database/pg-test-db.test.helper";
import { requireCmsDependency } from "../database/strapi-knex.test.helper";

interface PgResult {
  rows: Array<Record<string, unknown>>;
}
interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<PgResult | PgResult[]>;
  end(): Promise<void>;
}
const { Client } = requireCmsDependency<{
  Client: new (config: { connectionString: string }) => PgClient;
}>("pg");
const sql = (file: string) =>
  readFileSync(join(__dirname, "../../../../infra/rollback/exam-mode", file), "utf8");

// The real SQL runs on disposable schemas; no Strapi boot or existing database is needed.
describe.skipIf(!PG_URL)("exam-mode rollback on Postgres 16", () => {
  let client: PgClient;
  let schema: string;
  let backup: string;
  const all = async (query: string) => {
    const result = await client.query(query);
    return (Array.isArray(result) ? result[result.length - 1] : result).rows;
  };
  const courses = () => all("SELECT * FROM courses ORDER BY id");
  const versions = () =>
    all("SELECT target_document_id, revision FROM content_versions ORDER BY target_document_id");
  const run = (file: string) => client.query(sql(file).replace(/batch17_rollback/g, backup));
  const approve = () => client.query(`UPDATE ${backup}.exam_modes SET restore_exam = true`);
  const unchangedAfterFailure = async (file: string) => {
    const beforeCourses = await courses();
    const beforeVersions = await versions();
    await expect(run(file)).rejects.toThrow();
    await client.query("ROLLBACK");
    expect(await courses()).toEqual(beforeCourses);
    expect(await versions()).toEqual(beforeVersions);
  };

  beforeAll(async () => {
    client = new Client({ connectionString: PG_URL });
    await client.connect();
    schema = uniqueSchema("exam_mode");
    backup = uniqueSchema("exam_backup");
    await client.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
  });
  afterAll(async () => {
    await client.query(
      `ROLLBACK; DROP SCHEMA IF EXISTS ${backup} CASCADE; DROP SCHEMA ${schema} CASCADE`,
    );
    await client.end();
  });
  beforeEach(async () => {
    await client.query(`
      ROLLBACK;
      DROP SCHEMA IF EXISTS ${backup} CASCADE;
      DROP TABLE IF EXISTS courses, content_versions, lessons, lesson_progresses, files;
      CREATE TABLE courses (
        id serial PRIMARY KEY, document_id varchar(255), completion_mode varchar(255),
        title varchar(255) DEFAULT 'Keep title',
        updated_at timestamptz DEFAULT '2026-10-01T12:00:00Z', published_at timestamptz);
      CREATE TABLE content_versions (
        id serial PRIMARY KEY, document_id varchar(255), target_uid varchar(255) NOT NULL,
        target_document_id varchar(255) NOT NULL, revision integer NOT NULL,
        created_at timestamptz, updated_at timestamptz, published_at timestamptz,
        UNIQUE (target_uid, target_document_id));
      CREATE TABLE lessons (id integer, quiz jsonb);
      CREATE TABLE lesson_progresses (id integer, completed_at timestamptz);
      CREATE TABLE files (id integer, url text);
      INSERT INTO courses (document_id, completion_mode, published_at) VALUES
        ('both', 'exam', NULL), ('both', 'exam', now()),
        ('mixed', 'exam', NULL), ('mixed', 'quizGate', now()),
        ('draft', 'exam', NULL), ('regular', 'quizGate', NULL), ('confirm', 'confirm', NULL);
      INSERT INTO content_versions (target_uid, target_document_id, revision) VALUES
        ('api::course.course', 'both', 4), ('api::course.course', 'mixed', 8),
        ('api::lesson.lesson', 'unrelated', 12);
      INSERT INTO lessons VALUES (1, '[{"prompt":"Keep quiz","options":["A","B"],"correctIndex":1}]');
      INSERT INTO lesson_progresses VALUES (1, '2026-10-01T12:00:00Z');
      INSERT INTO files VALUES (1, '/uploads/keep.png');
    `);
  });

  it("records only exam variants without answers and bumps each document once", async () => {
    const before = await courses();
    const preserved = await all(`SELECT row_to_json(l) AS lesson, row_to_json(p) AS progress,
      row_to_json(f) AS file FROM lessons l, lesson_progresses p, files f`);
    await run("downgrade.sql");
    expect(await courses()).toEqual(
      before.map((row) => ({
        ...row,
        completion_mode: row.completion_mode === "exam" ? "quizGate" : row.completion_mode,
      })),
    );
    expect(
      await all(`SELECT source_schema, document_id, published, original_row_id,
      original_updated_at, restore_exam FROM ${backup}.exam_modes ORDER BY original_row_id`),
    ).toEqual(
      before
        .filter((row) => row.completion_mode === "exam")
        .map((row) => ({
          source_schema: schema,
          document_id: row.document_id,
          published: row.published_at !== null,
          original_row_id: row.id,
          original_updated_at: row.updated_at,
          restore_exam: null,
        })),
    );
    expect(
      await all(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = '${backup}' AND table_name = 'exam_modes' ORDER BY ordinal_position`),
    ).toEqual(
      [
        "source_schema",
        "document_id",
        "published",
        "original_row_id",
        "original_updated_at",
        "restore_exam",
      ].map((column_name) => ({ column_name })),
    );
    expect(await versions()).toEqual([
      { target_document_id: "both", revision: 5 },
      { target_document_id: "draft", revision: 1 },
      { target_document_id: "mixed", revision: 9 },
      { target_document_id: "unrelated", revision: 12 },
    ]);
    expect(
      await all(`SELECT row_to_json(l) AS lesson, row_to_json(p) AS progress,
      row_to_json(f) AS file FROM lessons l, lesson_progresses p, files f`),
    ).toEqual(preserved);
    await unchangedAfterFailure("downgrade.sql");
    expect(await all(`SELECT count(*)::int AS count FROM ${backup}.exam_modes`)).toEqual([
      { count: 4 },
    ]);
  });

  it("rolls back mode changes and the snapshot when the revision write fails", async () => {
    await client.query(
      "UPDATE content_versions SET revision = 2147483647 WHERE target_document_id = 'both'",
    );
    await unchangedAfterFailure("downgrade.sql");
    expect(
      await all(`SELECT count(*)::int AS count FROM information_schema.schemata
      WHERE schema_name = '${backup}'`),
    ).toEqual([{ count: 0 }]);
  });

  it("restores approved identities after republish changes row IDs and keeps rejected variants", async () => {
    await run("downgrade.sql");
    await client.query(`
      DELETE FROM courses WHERE document_id = 'both' AND published_at IS NOT NULL;
      INSERT INTO courses (document_id, completion_mode, published_at) VALUES ('both', 'quizGate', now());
      UPDATE courses SET completion_mode = 'confirm' WHERE document_id = 'draft';
      INSERT INTO courses (document_id, completion_mode, published_at) VALUES ('draft', 'quizGate', now());
      UPDATE ${backup}.exam_modes SET restore_exam = (document_id <> 'draft');
    `);
    await run("restore.sql");
    expect(
      await all(`SELECT document_id, published_at IS NOT NULL AS published, completion_mode
      FROM courses ORDER BY document_id, published`),
    ).toEqual([
      { document_id: "both", published: false, completion_mode: "exam" },
      { document_id: "both", published: true, completion_mode: "exam" },
      { document_id: "confirm", published: false, completion_mode: "confirm" },
      { document_id: "draft", published: false, completion_mode: "confirm" },
      { document_id: "draft", published: true, completion_mode: "quizGate" },
      { document_id: "mixed", published: false, completion_mode: "exam" },
      { document_id: "mixed", published: true, completion_mode: "quizGate" },
      { document_id: "regular", published: false, completion_mode: "quizGate" },
    ]);
    expect(await versions()).toEqual([
      { target_document_id: "both", revision: 6 },
      { target_document_id: "draft", revision: 1 },
      { target_document_id: "mixed", revision: 10 },
      { target_document_id: "unrelated", revision: 12 },
    ]);
    const afterCourses = await courses();
    const afterVersions = await versions();
    await run("restore.sql");
    expect(await courses()).toEqual(afterCourses);
    expect(await versions()).toEqual(afterVersions);
  });

  it("leaves courses and revisions unchanged when no exam exists", async () => {
    await client.query(
      "UPDATE courses SET completion_mode = 'quizGate' WHERE completion_mode = 'exam'",
    );
    const beforeCourses = await courses();
    const beforeVersions = await versions();
    await run("downgrade.sql");
    expect(await all(`SELECT * FROM ${backup}.exam_modes`)).toEqual([]);
    await run("restore.sql");
    expect(await courses()).toEqual(beforeCourses);
    expect(await versions()).toEqual(beforeVersions);
  });

  it.each([false, true])(
    "keeps a rejected quizGate variant unchanged, deleted=%s",
    async (deleted) => {
      await run("downgrade.sql");
      await client.query(`UPDATE ${backup}.exam_modes SET restore_exam = (document_id <> 'draft')`);
      if (deleted) await client.query("DELETE FROM courses WHERE document_id = 'draft'");
      const rejectedBefore = await all("SELECT * FROM courses WHERE document_id = 'draft'");
      await run("restore.sql");
      expect(await all("SELECT * FROM courses WHERE document_id = 'draft'")).toEqual(
        rejectedBefore,
      );
      expect(
        await all("SELECT revision FROM content_versions WHERE target_document_id = 'draft'"),
      ).toEqual([{ revision: 1 }]);
    },
  );

  it.each([
    ["undecided variant", ""],
    ["changed mode", "UPDATE courses SET completion_mode = 'confirm' WHERE document_id = 'draft'"],
    ["missing variant", "DELETE FROM courses WHERE document_id = 'draft'"],
    [
      "duplicate variant",
      `INSERT INTO courses (document_id, completion_mode) VALUES ('draft', 'quizGate')`,
    ],
    [
      "wrong source schema",
      `UPDATE BACKUP.exam_modes SET source_schema = 'other_schema' WHERE document_id = 'draft'`,
    ],
  ])("rejects restore atomically for %s", async (reason, change) => {
    await run("downgrade.sql");
    if (reason !== "undecided variant") await approve();
    if (change) await client.query(change.replace(/BACKUP/g, backup));
    await unchangedAfterFailure("restore.sql");
  });

  it.each([
    ["missing document ID", "UPDATE courses SET document_id = NULL WHERE document_id = 'draft'"],
    ["empty document ID", "UPDATE courses SET document_id = '' WHERE document_id = 'draft'"],
    [
      "duplicate variant",
      "INSERT INTO courses (document_id, completion_mode) VALUES ('draft', 'exam')",
    ],
    [
      "localized course",
      "ALTER TABLE courses ADD COLUMN locale varchar(255); UPDATE courses SET locale = 'en' WHERE document_id = 'draft'",
    ],
  ])("rejects downgrade atomically for %s", async (_reason, change) => {
    await client.query(change);
    await unchangedAfterFailure("downgrade.sql");
    expect(
      await all(`SELECT count(*)::int AS count FROM information_schema.schemata
      WHERE schema_name = '${backup}'`),
    ).toEqual([{ count: 0 }]);
  });
});
