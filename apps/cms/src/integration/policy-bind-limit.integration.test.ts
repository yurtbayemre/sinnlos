import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";

/**
 * Read policies bind their visible-id lists into one SQL statement; past
 * the database's bind-parameter limit (Postgres 65535, SQLite 32766) that
 * statement fails and Strapi answers 500. The guard (PL04,
 * utils/policy-query.ts fitsBindLimit) answers with nothing and an error
 * log instead: here with more visible wiki pages than one statement may
 * bind on the engine under test, inserted in bulk past the Document
 * Service.
 */

interface Knex {
  (table: string): { insert(rows: object[]): Promise<unknown> };
  raw(sql: string, bindings?: unknown[]): Promise<unknown>;
}

interface JoinTable {
  name: string;
  joinColumn: { name: string };
  inverseJoinColumn: { name: string };
}

interface Metadata {
  get(uid: string): { tableName: string; attributes: Record<string, { joinTable?: JoinTable }> };
}

interface Logger {
  error(...args: unknown[]): unknown;
}

const PAGE = "api::wiki-page.wiki-page";
const BATCH = 500;

describe.each(testEngines())("policy bind limit on %s", (engine) => {
  let t: TestStrapi;
  let announcement: Row;
  let pageCount = 0;
  const logged: string[] = [];

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
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

    const db = t.strapi.db as unknown as { connection: Knex; metadata: Metadata };
    const { tableName, attributes } = db.metadata.get(PAGE);
    const join = attributes.space.joinTable;
    if (!join) throw new Error("wiki-page.space has no join table");
    const spaceRows = await t.strapi.db.query("api::wiki-space.wiki-space").findMany({
      where: { documentId: space.documentId, publishedAt: { $notNull: true } },
      select: ["id"],
    });
    const spaceId = spaceRows[0]?.id;
    if (typeof spaceId !== "number") throw new Error("published space row missing");

    // One page more than the engine's statement may bind (limits minus the
    // 1000 parameters of headroom, utils/policy-query.ts).
    pageCount = (engine === "postgres" ? 65535 : 32766) - 1000 + 1;
    const now = new Date().toISOString();
    const firstId = 1_000_000;
    for (let offset = 0; offset < pageCount; offset += BATCH) {
      const pages: object[] = [];
      const links: object[] = [];
      for (let index = offset; index < Math.min(pageCount, offset + BATCH); index += 1) {
        const id = firstId + index;
        pages.push({
          id,
          document_id: `b${randomBytes(12).toString("hex").slice(0, 23)}`,
          title: `BL page ${index}`,
          slug: `bl-page-${index}`,
          published_at: now,
          created_at: now,
          updated_at: now,
        });
        links.push({ [join.joinColumn.name]: id, [join.inverseJoinColumn.name]: spaceId });
      }
      await db.connection(tableName).insert(pages);
      await db.connection(join.name).insert(links);
    }
    if (engine === "postgres") {
      // Explicit ids leave the serial behind; later inserts must not collide.
      await db.connection.raw(
        `SELECT setval(pg_get_serial_sequence('${tableName}', 'id'), (SELECT max(id) FROM ${tableName}))`,
      );
    }

    const log = t.strapi.log as unknown as Logger;
    const original = log.error.bind(log);
    log.error = (...args: unknown[]) => {
      logged.push(String(args[0]));
      return original(...args);
    };
  }, 300_000);

  afterAll(async () => {
    await t?.stop();
  });

  it("answers the page list with nothing and a log instead of an SQL error", async () => {
    const before = logged.length;
    const res = await t.api<{ data: Row[] }>("member", "/api/wiki-pages?pagination[pageSize]=5");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    const lines = logged.slice(before);
    expect(lines.some((line) => line.includes(`${pageCount} values exceed`))).toBe(true);
    // The log names the policy and the count, never the ids.
    expect(lines.join("\n")).not.toContain(String(1_000_000));
  });

  it("answers the full comment path with nothing, the single-anchor path as before", async () => {
    const full = await t.api<{ data: Row[] }>("member", "/api/comments");
    expect(full.status).toBe(200);
    expect(full.body.data).toEqual([]);
    const pin =
      "filters[targetType][$eq]=announcement" +
      `&filters[targetDocumentId][$eq]=${announcement.documentId}`;
    const thread = await t.api<{ data: Row[] }>("member", `/api/comments?${pin}`);
    expect(thread.status).toBe(200);
    expect(thread.body.data.map((row) => row.body)).toEqual(["BL comment"]);
  });

  it("leaves the admin/editor bypass alone", async () => {
    const res = await t.api<{ data: Row[]; meta: { pagination: { total: number } } }>(
      "admin_role",
      "/api/wiki-pages?pagination[pageSize]=1",
    );
    expect(res.status).toBe(200);
    expect(res.body.meta.pagination.total).toBe(pageCount);
  });
});
