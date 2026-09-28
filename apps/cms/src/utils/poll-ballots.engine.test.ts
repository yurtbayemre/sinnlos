/**
 * The poll results count (FX20, utils/poll-ballots.ts countPollBallots)
 * against Strapi's real query engine (@strapi/database 5.55.1): on SQLite
 * always, on Postgres 16 with SINNLOS_TEST_PG_URL set (in its own schema,
 * as DATABASE_SCHEMA does it). The tables, link tables and columns are the
 * ones the engine creates from the poll-vote model, read back through its
 * metadata.
 *
 * Pinned:
 *  - the GROUP BY statement equals the reference rule (tallyBallots over
 *    the rows and voters the old results read loaded) on seeded random
 *    polls with duplicate ballots, votes of deleted accounts, identical
 *    votes and options edited away, for every caller;
 *  - without duplicates it equals the plain row count per option (the
 *    SELECT count(*) baseline of the deploy check);
 *  - identical votes count one by one (the DISTINCT trap of 0bc7830);
 *  - it is ONE statement, so a duplicate deleted by a parallel vote's
 *    cleanup is never read without its voter; the two-step read it replaced
 *    counted such a row as a separate ballot of a deleted account;
 *  - parallel votes of one voter interleaved with results reads never show
 *    more than one ballot for that voter.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PG_URL, createTestKnex, uniqueSchema } from "../database/pg-test-db.test.helper";
import { type RawKnex } from "../database/strapi-knex.test.helper";
import {
  loadDatabase,
  openSqliteEngine,
  type KnexQueryEvent,
} from "../test/sqlite-engine.test.helper";
import {
  POLL_VOTE_UID,
  ballotTables,
  countPollBallots,
  tallyBallots,
  type BallotCountHost,
  type BallotRow,
} from "./poll-ballots";

const USER_UID = "plugin::users-permissions.user";
const POLL_UID = "api::poll.poll";

const MODELS = [
  {
    uid: USER_UID,
    singularName: "user",
    tableName: "up_users",
    attributes: {
      id: { type: "increments" },
      username: { type: "string" },
    },
  },
  {
    uid: POLL_UID,
    singularName: "poll",
    tableName: "polls",
    attributes: {
      id: { type: "increments" },
      documentId: { type: "string" },
      question: { type: "string" },
    },
  },
  {
    uid: POLL_VOTE_UID,
    singularName: "poll-vote",
    tableName: "poll_votes",
    attributes: {
      id: { type: "increments" },
      poll: { type: "relation", relation: "manyToOne", target: POLL_UID },
      optionIndex: { type: "integer" },
      voter: { type: "relation", relation: "manyToOne", target: USER_UID },
    },
  },
];

type Row = Record<string, unknown>;

/** The engine calls this suite makes (@strapi/database 5.55.1 Database). */
interface Engine {
  connection: {
    raw(sql: string, bindings?: readonly unknown[]): Promise<unknown>;
    on(event: "query", listener: (query: KnexQueryEvent) => void): unknown;
    off(event: "query", listener: (query: KnexQueryEvent) => void): unknown;
  };
  metadata: { get(uid: string): unknown };
  getSchemaName(): string | undefined;
  query(uid: string): {
    create(params: { data: Row }): Promise<Row | null>;
    findMany(params: Record<string, unknown>): Promise<Row[]>;
    delete(params: { where: Row }): Promise<unknown>;
  };
  destroy(): Promise<void>;
}

interface Opened {
  engine: Engine;
  close(): Promise<void>;
}

const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

async function openSqlite(): Promise<Opened> {
  const opened = await openSqliteEngine(MODELS);
  return { engine: opened.db as unknown as Engine, close: () => opened.close() };
}

async function openPostgres(): Promise<Opened> {
  const knex: RawKnex = createTestKnex();
  const schema = uniqueSchema("poll_ballots");
  await knex.raw(`CREATE SCHEMA "${schema}"`);
  const dir = mkdtempSync(join(tmpdir(), "sinnlos-poll-ballots-"));
  const Database = loadDatabase();
  const db = new Database({
    connection: {
      client: "postgres",
      connection: { connectionString: PG_URL, options: "-c TimeZone=UTC", schema },
      pool: { min: 0, max: 8 },
    },
    settings: { migrations: { dir }, forceMigration: false },
    logger: quiet,
  });
  await db.init({ models: MODELS });
  await db.schema.create();
  vi.stubGlobal("strapi", { db });
  return {
    engine: db as unknown as Engine,
    async close() {
      await db.destroy();
      vi.unstubAllGlobals();
      await knex.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await knex.destroy();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Deterministic PRNG (mulberry32), so a failing seed reproduces. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function suite(name: string, open: () => Promise<Opened>) {
  describe(name, () => {
    let opened: Opened;
    let engine: Engine;
    let host: BallotCountHost;
    let users: number[];

    beforeEach(async () => {
      opened = await open();
      engine = opened.engine;
      host = { db: engine };
      users = [];
      for (let i = 0; i < 12; i += 1) {
        const user = await engine.query(USER_UID).create({ data: { username: `voter-${i}` } });
        users.push(user?.id as number);
      }
    }, 30_000);

    afterEach(async () => {
      await opened?.close();
    });

    const createPoll = async (question: string) =>
      (await engine.query(POLL_UID).create({ data: { question, documentId: question } }))
        ?.id as number;

    const addVote = async (poll: number, voter: number | null, optionIndex: number) =>
      (await engine.query(POLL_VOTE_UID).create({ data: { poll, voter, optionIndex } }))
        ?.id as number;

    /** The old results read: rows with id + optionIndex, then their voter ids. */
    const referenceRows = async (poll: number) =>
      (await engine.query(POLL_VOTE_UID).findMany({
        where: { poll },
        select: ["id", "optionIndex"],
        populate: { voter: { select: ["id"] } },
      })) as unknown as BallotRow[];

    it("reads the poll-vote tables from the engine's metadata", () => {
      const tables = ballotTables(engine.metadata);
      expect(tables.votes).toBe("poll_votes");
      expect(tables.optionColumn).toBe("option_index");
      expect(tables.pollLink.table).toMatch(/^poll_votes_poll_lnk$/);
      expect(tables.voterLink.table).toMatch(/^poll_votes_voter_lnk$/);
    });

    it("equals the reference rule on seeded random polls, for every caller", async () => {
      const random = prng(0x5eed);
      const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)] as T;
      const polls: { id: number; optionCount: number }[] = [];
      for (let p = 0; p < 6; p += 1) {
        const id = await createPoll(`poll-${p}`);
        // Option counts 2..4; votes may name an option edited away (index 4).
        const optionCount = 2 + Math.floor(random() * 3);
        polls.push({ id, optionCount });
        const ballots = 5 + Math.floor(random() * 25);
        for (let b = 0; b < ballots; b += 1) {
          // ~1 in 8 rows of a deleted account (no voter link).
          const voter = random() < 0.125 ? null : pick(users.slice(0, 8));
          await addVote(id, voter, Math.floor(random() * 5));
        }
      }
      for (const poll of polls) {
        const reference = await referenceRows(poll.id);
        for (const caller of [...users.slice(0, 9), null]) {
          const expected = tallyBallots(reference, poll.optionCount, caller);
          await expect(
            countPollBallots(host, poll.id, caller, poll.optionCount),
            `poll ${poll.id}, caller ${String(caller)}`,
          ).resolves.toEqual(expected);
        }
      }
    }, 60_000);

    it("equals the plain row count per option when every voter voted once", async () => {
      const poll = await createPoll("once");
      const other = await createPoll("other");
      for (const [i, voter] of users.entries()) await addVote(poll, voter, i % 3);
      await addVote(other, users[0] as number, 2);
      const tables = ballotTables(engine.metadata);
      const schema = engine.getSchemaName();
      const qualify = (table: string) => (schema ? `${schema}.${table}` : table);
      const raw = await engine.connection.raw(
        `SELECT v.?? AS option_index, count(*) AS n FROM ?? v JOIN ?? l ON l.?? = v.id WHERE l.?? = ? GROUP BY v.?? ORDER BY 1`,
        [
          tables.optionColumn,
          qualify(tables.votes),
          qualify(tables.pollLink.table),
          tables.pollLink.voteColumn,
          tables.pollLink.pollColumn,
          poll,
          tables.optionColumn,
        ],
      );
      const rows = (Array.isArray(raw) ? raw : (raw as { rows: Row[] }).rows) as Row[];
      const baseline = [0, 0, 0];
      for (const row of rows) baseline[Number(row.option_index)] = Number(row.n);
      const counted = await countPollBallots(host, poll, users[4] as number, 3);
      expect(counted).toEqual({ counts: baseline, total: 12, myVoteIndex: 1 });
      expect(baseline).toEqual([4, 4, 4]);
    });

    it("counts identical votes one by one (no DISTINCT over the projection)", async () => {
      const poll = await createPoll("identical");
      for (const voter of users.slice(0, 6)) await addVote(poll, voter, 1);
      await expect(countPollBallots(host, poll, null, 2)).resolves.toEqual({
        counts: [0, 6],
        total: 6,
        myVoteIndex: null,
      });
    });

    it("counts a voter's first ballot only, and each vote of a deleted account", async () => {
      const poll = await createPoll("duplicates");
      const [ada, grace] = users as [number, number];
      await addVote(poll, ada, 0);
      await addVote(poll, grace, 1);
      await addVote(poll, ada, 1); // a parallel duplicate: does not count
      await addVote(poll, null, 1);
      await addVote(poll, null, 1);
      await expect(countPollBallots(host, poll, ada, 2)).resolves.toEqual({
        counts: [1, 3],
        total: 4,
        myVoteIndex: 0,
      });
      // Deleting an account removes its link rows: its first ballot then
      // counts on its own, and so does its duplicate.
      await engine.query(USER_UID).delete({ where: { id: grace } });
      await expect(countPollBallots(host, poll, grace, 2)).resolves.toEqual({
        counts: [1, 3],
        total: 4,
        myVoteIndex: null,
      });
    });

    it("reads in ONE statement", async () => {
      const poll = await createPoll("one statement");
      await addVote(poll, users[0] as number, 0);
      const statements: string[] = [];
      const listener = (query: KnexQueryEvent) => statements.push(query.sql);
      engine.connection.on("query", listener);
      try {
        await countPollBallots(host, poll, users[0] as number, 2);
      } finally {
        engine.connection.off("query", listener);
      }
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatch(/group by/i);
      expect(statements[0]).not.toMatch(/distinct/i);
    });

    it("a duplicate deleted between two reads: the two-step read miscounted, the statement cannot", async () => {
      const poll = await createPoll("cleanup race");
      const [ada, grace] = users as [number, number];
      await addVote(poll, grace, 0);
      await addVote(poll, ada, 1);
      const duplicate = await addVote(poll, ada, 0);

      // The old read, split where a parallel cleanup can land: the rows
      // first, the cleanup deletes Ada's later row, then the voter populate.
      const rows = (await engine.query(POLL_VOTE_UID).findMany({
        where: { poll },
        select: ["id", "optionIndex"],
      })) as unknown as BallotRow[];
      const counted = await countPollBallots(host, poll, null, 2);
      await engine.query(POLL_VOTE_UID).delete({ where: { id: duplicate } });
      const voters = (await engine.query(POLL_VOTE_UID).findMany({
        where: { id: { $in: rows.map((row) => row.id) } },
        select: ["id"],
        populate: { voter: { select: ["id"] } },
      })) as unknown as BallotRow[];
      const twoStep = rows.map((row) => ({
        ...row,
        voter: voters.find((voter) => voter.id === row.id)?.voter ?? null,
      }));
      // The deleted duplicate came back without a voter: a "deleted account".
      expect(tallyBallots(twoStep, 2, null)).toMatchObject({ total: 3 });

      // The statement sees the duplicate with its voter (before) or not at
      // all (after): two ballots either way.
      expect(counted).toEqual({ counts: [1, 1], total: 2, myVoteIndex: null });
      await expect(countPollBallots(host, poll, ada, 2)).resolves.toEqual({
        counts: [1, 1],
        total: 2,
        myVoteIndex: 1,
      });
    });

    it("parallel votes of one voter never show as more than one ballot", async () => {
      const poll = await createPoll("parallel");
      const voter = users[0] as number;
      // The vote handler's insert and cleanup (poll-vote.ts vote).
      const vote = async (optionIndex: number) => {
        await addVote(poll, voter, optionIndex);
        const mine = await engine.query(POLL_VOTE_UID).findMany({
          where: { poll, voter },
          select: ["id"],
          orderBy: { id: "asc" },
        });
        for (const row of mine.slice(1)) {
          await engine.query(POLL_VOTE_UID).delete({ where: { id: row.id } });
        }
      };
      const totals: number[] = [];
      const read = async () => {
        for (let i = 0; i < 10; i += 1) {
          totals.push((await countPollBallots(host, poll, voter, 2)).total);
        }
      };
      await Promise.all([...Array.from({ length: 8 }, (_, i) => vote(i % 2)), read(), read()]);
      expect(Math.max(...totals)).toBeLessThanOrEqual(1);
      await expect(countPollBallots(host, poll, voter, 2)).resolves.toMatchObject({ total: 1 });
    }, 60_000);
  });
}

suite("poll results count on SQLite", openSqlite);
describe.skipIf(!PG_URL)("Postgres 16", () => {
  suite("poll results count on Postgres 16 (own schema)", openPostgres);
});
