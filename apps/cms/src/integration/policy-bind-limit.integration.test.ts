import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";

/**
 * Read policies bind their visible-id lists into one SQL statement; a
 * statement with more bound values than the database's limit (Postgres
 * 65535, SQLite 32766) fails and Strapi answers 500. The guard (PL04,
 * utils/policy-query.ts fitsBindLimit) admits a list of at most the engine
 * limit minus 1000 values of headroom for the rest of the statement and
 * answers a longer one with nothing and an error log. Visible wiki pages
 * are inserted in bulk past the Document Service, in two steps:
 *
 *   - one page more than the guard admits (31,767 on SQLite, 64,536 on
 *     Postgres). Still bindable: 5f2eac0 served these rows, the guard fails
 *     closed here (the accepted headroom window).
 *   - one page more than the engine can bind at all (32,767 / 65,536),
 *     where 5f2eac0 failed with a 500.
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

/** Where the bulk pages go: the page table and its space join table. */
interface PageSeed {
  connection: Knex;
  tableName: string;
  join: JoinTable;
  spaceId: number;
  postgres: boolean;
}

const PAGE = "api::wiki-page.wiki-page";
const BATCH = 500;
const FIRST_ID = 1_000_000;
/** Restated from utils/policy-query.ts (BIND_LIMITS, BIND_HEADROOM): a change there shows here. */
const ENGINE_LIMIT = { postgres: 65535, sqlite: 32766 } as const;
const HEADROOM = 1000;

/** Inserts published pages number `from` to `to - 1` into the seed's space. */
async function insertPages(seed: PageSeed, from: number, to: number): Promise<void> {
  const now = new Date().toISOString();
  for (let offset = from; offset < to; offset += BATCH) {
    const pages: object[] = [];
    const links: object[] = [];
    for (let index = offset; index < Math.min(to, offset + BATCH); index += 1) {
      const id = FIRST_ID + index;
      pages.push({
        id,
        document_id: `b${randomBytes(12).toString("hex").slice(0, 23)}`,
        title: `BL page ${index}`,
        slug: `bl-page-${index}`,
        published_at: now,
        created_at: now,
        updated_at: now,
      });
      links.push({
        [seed.join.joinColumn.name]: id,
        [seed.join.inverseJoinColumn.name]: seed.spaceId,
      });
    }
    await seed.connection(seed.tableName).insert(pages);
    await seed.connection(seed.join.name).insert(links);
  }
  if (seed.postgres) {
    // Explicit ids leave the serial behind; later inserts must not collide.
    await seed.connection.raw(
      `SELECT setval(pg_get_serial_sequence('${seed.tableName}', 'id'), (SELECT max(id) FROM ${seed.tableName}))`,
    );
  }
}

describe.each(testEngines())("policy bind limit on %s", (engine) => {
  const engineLimit = ENGINE_LIMIT[engine];
  let t: TestStrapi;
  let seed: PageSeed;
  let announcement: Row;
  let pageCount = 0;
  const logged: string[] = [];

  const threadPath = () =>
    "/api/comments?filters[targetType][$eq]=announcement" +
    `&filters[targetDocumentId][$eq]=${announcement.documentId}`;

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
    seed = { connection: db.connection, tableName, join, spaceId, postgres: engine === "postgres" };

    // One page more than the guard admits: the engine limit minus the 1000
    // values of headroom (utils/policy-query.ts). A statement could still
    // bind this list; the guard fails closed from here on by design.
    pageCount = engineLimit - HEADROOM + 1;
    await insertPages(seed, 0, pageCount);

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

  it("answers the page list with nothing and a log once the guard's limit is passed", async () => {
    const before = logged.length;
    const res = await t.api<{ data: Row[] }>("member", "/api/wiki-pages?pagination[pageSize]=5");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    const lines = logged.slice(before);
    expect(lines.some((line) => line.includes(`${pageCount} values exceed`))).toBe(true);
    // The log names the policy and the count, never the ids.
    expect(lines.join("\n")).not.toContain(String(FIRST_ID));
  });

  it("answers the full comment path with nothing, the single-anchor path as before", async () => {
    const full = await t.api<{ data: Row[] }>("member", "/api/comments");
    expect(full.status).toBe(200);
    expect(full.body.data).toEqual([]);
    const thread = await t.api<{ data: Row[] }>("member", threadPath());
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

  it("answers with nothing and a log past the engine limit, where 5f2eac0 failed with a 500", async () => {
    // Last case: it grows the table for good.
    await insertPages(seed, pageCount, engineLimit + 1);
    pageCount = engineLimit + 1;

    const before = logged.length;
    const pages = await t.api<{ data: Row[] }>("member", "/api/wiki-pages?pagination[pageSize]=5");
    expect(pages.status).toBe(200);
    expect(pages.body.data).toEqual([]);
    expect(logged.slice(before).some((line) => line.includes(`${pageCount} values exceed`))).toBe(
      true,
    );

    const full = await t.api<{ data: Row[] }>("member", "/api/comments");
    expect(full.status).toBe(200);
    expect(full.body.data).toEqual([]);
    const thread = await t.api<{ data: Row[] }>("member", threadPath());
    expect(thread.status).toBe(200);
    expect(thread.body.data.map((row) => row.body)).toEqual(["BL comment"]);
  });
});
