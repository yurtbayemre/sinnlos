import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";

/**
 * Read policies past the bind-parameter limit (#175, v0.33). A statement
 * may bind at most 65535 parameters on Postgres and 32766 on SQLite. Up to
 * v0.32 a visible-id list was bound one parameter per id, and a list past
 * the limit answered nothing (fail closed). Now:
 *
 *   - the list reaches the reads as ONE parameter (utils/policy-query.ts
 *     oneParamIn, through the Document Service middleware), and
 *   - the loaders that populate read in id pages (utils/paged-read.ts), so
 *     a populate never binds a whole type either.
 *
 * Seeded in bulk past the Document Service: 70,000 published wiki pages in
 * one public space (no populate in their loader, one list), and 70,000
 * company-wide documents, each with its draft twin (140,000 rows whose
 * departments populate used to bind every row id), next to the fixture's
 * own rows. Every request's statements are captured: none binds more than
 * a handful of parameters.
 */

interface Knex {
  (table: string): { insert(rows: object[]): Promise<unknown> };
  raw(sql: string, bindings?: unknown[]): Promise<unknown>;
  on(event: "query", listener: (query: { sql: string; bindings?: unknown[] }) => void): void;
  off(event: "query", listener: (query: { sql: string; bindings?: unknown[] }) => void): void;
}

interface JoinTable {
  name: string;
  joinColumn: { name: string };
  inverseJoinColumn: { name: string };
}

interface Metadata {
  get(uid: string): { tableName: string; attributes: Record<string, { joinTable?: JoinTable }> };
}

const PAGE = "api::wiki-page.wiki-page";
const DOCUMENT = "api::document.document";
const COUNT = 70_000;
const BATCH = 500;
const FIRST_ID = 1_000_000;

const documentId = () => `b${randomBytes(12).toString("hex").slice(0, 23)}`;

/** Inserts `rows` in batches, then moves the table's Postgres serial past them. */
async function insertRows(
  connection: Knex,
  table: string,
  rows: object[],
  postgres: boolean,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += BATCH) {
    await connection(table).insert(rows.slice(offset, offset + BATCH));
  }
  if (postgres && rows.length > 0 && "id" in (rows[0] as object)) {
    // Explicit ids leave the serial behind; later inserts must not collide.
    await connection.raw(
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT max(id) FROM ${table}))`,
    );
  }
}

describe.each(testEngines())("read policies past the bind limit on %s", (engine) => {
  let t: TestStrapi;
  let connection: Knex;
  let announcement: Row;
  let memberDocumentsBefore = 0;

  const threadPath = () =>
    "/api/comments?filters[targetType][$eq]=announcement" +
    `&filters[targetDocumentId][$eq]=${announcement.documentId}`;

  /** The request's answer and the most parameters one of its statements bound. */
  async function measured<T>(caller: Parameters<TestStrapi["api"]>[0], path: string) {
    let most = 0;
    const listener = (query: { bindings?: unknown[] }) => {
      most = Math.max(most, query.bindings?.length ?? 0);
    };
    connection.on("query", listener);
    try {
      const res = await t.api<T>(caller, path);
      return { res, most };
    } finally {
      connection.off("query", listener);
    }
  }

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    const postgres = engine === "postgres";
    const docs = (uid: string) => t.strapi.documents(uid);
    announcement = await docs("api::announcement.announcement").create({
      data: { title: "BL announcement", audience: "all" },
      status: "published",
    });
    await t.strapi.db.query("api::comment.comment").create({
      data: {
        body: "BL comment",
        targetType: "announcement",
        targetDocumentId: announcement.documentId,
        author: t.fixtures.users.member.id,
      },
    });
    const space = await docs("api::wiki-space.wiki-space").create({
      data: { name: "BL space", slug: "bl-space", visibility: "public" },
      status: "published",
    });
    const before = await t.api<{ meta: { pagination: { total: number } } }>(
      "member",
      "/api/documents?pagination[pageSize]=1",
    );
    memberDocumentsBefore = before.body.meta.pagination.total;

    const db = t.strapi.db as unknown as { connection: Knex; metadata: Metadata };
    connection = db.connection;
    const now = new Date().toISOString();

    // 70,000 published wiki pages in the public space.
    const pageMeta = db.metadata.get(PAGE);
    const spaceJoin = pageMeta.attributes.space.joinTable;
    if (!spaceJoin) throw new Error("wiki-page.space has no join table");
    const spaceRows = await t.strapi.db.query("api::wiki-space.wiki-space").findMany({
      where: { documentId: space.documentId, publishedAt: { $notNull: true } },
      select: ["id"],
    });
    const spaceId = spaceRows[0]?.id;
    if (typeof spaceId !== "number") throw new Error("published space row missing");
    const pages = Array.from({ length: COUNT }, (_, index) => ({
      id: FIRST_ID + index,
      document_id: documentId(),
      title: `BL page ${index}`,
      slug: `bl-page-${index}`,
      published_at: now,
      created_at: now,
      updated_at: now,
    }));
    await insertRows(connection, pageMeta.tableName, pages, postgres);
    await insertRows(
      connection,
      spaceJoin.name,
      pages.map((page) => ({
        [spaceJoin.joinColumn.name]: page.id,
        [spaceJoin.inverseJoinColumn.name]: spaceId,
      })),
      postgres,
    );

    // 70,000 company-wide documents, each a draft and a published row.
    const documentMeta = db.metadata.get(DOCUMENT);
    const documents = Array.from({ length: COUNT }, (_, index) => {
      const shared = {
        document_id: documentId(),
        title: `BL document ${index}`,
        audience: "all",
        created_at: now,
        updated_at: now,
      };
      return [
        { id: FIRST_ID + 2 * index, ...shared, published_at: null },
        { id: FIRST_ID + 2 * index + 1, ...shared, published_at: now },
      ];
    }).flat();
    await insertRows(connection, documentMeta.tableName, documents, postgres);
  }, 600_000);

  afterAll(async () => {
    await t?.stop();
  });

  it("answers a member's wiki-page list with rows, one parameter for the list", async () => {
    const { res, most } = await measured<{ data: Row[]; meta: { pagination: { total: number } } }>(
      "member",
      "/api/wiki-pages?pagination[pageSize]=5",
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.meta.pagination.total).toBeGreaterThanOrEqual(COUNT);
    expect(most).toBeLessThan(100);
  }, 120_000);

  it("answers a member's documents, the populated loader read in pages", async () => {
    const { res, most } = await measured<{ data: Row[]; meta: { pagination: { total: number } } }>(
      "member",
      "/api/documents?pagination[pageSize]=5",
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    // Each document once: its published row.
    expect(res.body.meta.pagination.total).toBe(memberDocumentsBefore + COUNT);
    // A page of 5,000 parent ids per populate, never all 140,000 rows.
    expect(most).toBeLessThanOrEqual(5_000);
  }, 120_000);

  it("answers the full comment path and the single-anchor path with the thread", async () => {
    const full = await measured<{ data: Row[] }>("member", "/api/comments");
    expect(full.res.status).toBe(200);
    expect(full.res.body.data.map((row) => row.body)).toContain("BL comment");
    expect(full.most).toBeLessThan(100);
    const thread = await t.api<{ data: Row[] }>("member", threadPath());
    expect(thread.status).toBe(200);
    expect(thread.body.data.map((row) => row.body)).toEqual(["BL comment"]);
  }, 120_000);

  it("leaves the admin/editor bypass alone", async () => {
    const res = await t.api<{ data: Row[]; meta: { pagination: { total: number } } }>(
      "admin_role",
      "/api/wiki-pages?pagination[pageSize]=1",
    );
    expect(res.status).toBe(200);
    expect(res.body.meta.pagination.total).toBeGreaterThanOrEqual(COUNT);
  });
});
