import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadStrapiKnex, type RawKnex } from "../database/strapi-knex.test.helper";
import searchLogController from "../api/search-log/controllers/search-log";
import { pruneSearchLogs } from "./prune-search-logs";

/**
 * FX25 against a real SQLite (knex + better-sqlite3 :memory:, the local-dev
 * database). Strapi stores a datetime there as epoch milliseconds (knex's
 * better-sqlite3 client binds a Date as valueOf(), knex/lib/dialects/
 * better-sqlite3/index.js:58-60). The raw predicates used to bind ISO
 * strings, which SQLite compares as TEXT against INTEGER: the summary
 * counted nothing and the janitor deleted every row. They bind Dates now.
 */

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController:
      (_uid: string, cfg: (deps: { strapi: unknown }) => object) =>
      ({ strapi }: { strapi: unknown }) =>
        cfg({ strapi }),
  },
}));

const DAY_MS = 86400000;

let knex: RawKnex;

async function count(): Promise<number> {
  const rows = (await knex.raw("select count(*) as n from search_logs")) as { n: number }[];
  return Number(rows[0].n);
}

beforeEach(async () => {
  knex = loadStrapiKnex()({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true,
  });
  await knex.raw(
    "create table search_logs (id integer primary key autoincrement, term varchar(255), result_count integer, created_at datetime)",
  );
  const now = Date.now();
  // Inserted the way Strapi writes a datetime: a Date binding.
  await knex.raw("insert into search_logs (term, result_count, created_at) values (?, ?, ?)", [
    "fresh",
    0,
    new Date(now - DAY_MS),
  ]);
  await knex.raw("insert into search_logs (term, result_count, created_at) values (?, ?, ?)", [
    "stale",
    3,
    new Date(now - 200 * DAY_MS),
  ]);
});

afterEach(async () => {
  await knex.destroy();
});

describe("search-log time filters on SQLite (FX25)", () => {
  it("stores Strapi datetimes as epoch ms, so an ISO-string predicate matches nothing", async () => {
    const [row] = (await knex.raw("select typeof(created_at) as t from search_logs limit 1")) as { t: string }[];
    expect(row.t).toBe("integer");
    const iso = new Date(Date.now() - 30 * DAY_MS).toISOString();
    const rows = (await knex.raw("select count(*) as n from search_logs where created_at >= ?", [iso])) as {
      n: number;
    }[];
    expect(Number(rows[0].n)).toBe(0);
  });

  it("the janitor prunes only rows older than 90 days", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    await pruneSearchLogs({ db: { connection: knex }, log });
    expect(log.warn).not.toHaveBeenCalled();
    expect(await count()).toBe(1);
    const rows = (await knex.raw("select term from search_logs")) as { term: string }[];
    expect(rows.map((r) => r.term)).toEqual(["fresh"]);
  });

  it("the summary counts the rows inside its window", async () => {
    const controller = (
      searchLogController as unknown as (deps: { strapi: unknown }) => {
        summary(ctx: unknown): Promise<void>;
      }
    )({ strapi: { db: { connection: knex } } });
    const ctx = { query: { days: "30" }, send: vi.fn() };
    await controller.summary(ctx);
    expect(ctx.send).toHaveBeenCalledWith(
      expect.objectContaining({
        windowDays: 30,
        total: 1,
        zeroResultCount: 1,
        topTerms: [{ term: "fresh", count: 1, avgResults: 0 }],
      }),
    );

    const yearCtx = { query: { days: "365" }, send: vi.fn() };
    await controller.summary(yearCtx);
    expect(yearCtx.send).toHaveBeenCalledWith(expect.objectContaining({ total: 2, zeroResultCount: 1 }));
  });
});
