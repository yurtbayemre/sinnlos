import { describe, expect, it } from "vitest";

import {
  POLL_VOTE_UID,
  ballotCountStatement,
  ballotTables,
  ballotVoterId,
  countPollBallots,
  countedBallots,
  isOptionIndex,
  tallyBallots,
  tallyFromCounts,
  type BallotRow,
  type BallotTables,
} from "./poll-ballots";

/**
 * One ballot per voter (utils/poll-ballots.ts): a vote cannot be changed, so
 * a voter's first accepted ballot, the row with the lowest id, is the one
 * that counts; a row whose voter is gone counts on its own.
 */

const row = (id: number, voter: number | null, optionIndex: unknown): BallotRow => ({
  id,
  optionIndex,
  voter: voter === null ? null : { id: voter },
});

describe("isOptionIndex", () => {
  it("accepts integers >= 0 only", () => {
    for (const value of [0, 1, 9]) expect(isOptionIndex(value), String(value)).toBe(true);
    for (const value of [-1, 1.5, "1", null, undefined, Number.NaN]) {
      expect(isOptionIndex(value), String(value)).toBe(false);
    }
  });
});

describe("ballotVoterId", () => {
  it("reads a numeric voter id and treats anything else as a gone voter", () => {
    expect(ballotVoterId(row(1, 7, 0))).toBe(7);
    expect(ballotVoterId(row(1, null, 0))).toBeNull();
    expect(ballotVoterId({ id: 1, optionIndex: 0 })).toBeNull();
    expect(ballotVoterId({ id: 1, optionIndex: 0, voter: { id: "7" } })).toBeNull();
  });
});

describe("countedBallots", () => {
  it("keeps one row per voter: the one with the lowest id, whatever the input order", () => {
    const rows = [row(30, 7, 1), row(10, 7, 0), row(20, 7, 1), row(15, 8, 1)];
    expect(countedBallots(rows).map((r) => r.id)).toEqual([10, 15]);
    expect(countedBallots([...rows].reverse()).map((r) => r.id)).toEqual([10, 15]);
  });

  it("counts every row without a voter on its own", () => {
    const rows = [row(3, null, 0), row(1, null, 0), row(2, 7, 1), row(4, 7, 0)];
    expect(countedBallots(rows).map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("returns nothing for no rows and does not change its input", () => {
    expect(countedBallots([])).toEqual([]);
    const rows = [row(2, 7, 0), row(1, 7, 1)];
    countedBallots(rows);
    expect(rows.map((r) => r.id)).toEqual([2, 1]);
  });
});

describe("tallyBallots", () => {
  it("counts the first ballot of each voter per option and totals the voters", () => {
    const rows = [
      row(1, 11, 1),
      row(2, 12, 0),
      // A parallel race stored more rows of voter 11: only row 1 counts.
      row(3, 11, 0),
      row(4, 11, 1),
      row(5, 13, 1),
    ];
    expect(tallyBallots(rows, 2, null)).toEqual({ counts: [1, 2], total: 3, myVoteIndex: null });
  });

  it("gives the caller the option of their first ballot, not of a later duplicate", () => {
    const rows = [row(9, 5, 1), row(4, 5, 0), row(6, 12, 1)];
    expect(tallyBallots(rows, 2, 5)).toEqual({ counts: [1, 1], total: 2, myVoteIndex: 0 });
    expect(tallyBallots(rows, 2, 12).myVoteIndex).toBe(1);
    expect(tallyBallots(rows, 2, 99).myVoteIndex).toBeNull();
  });

  it("counts identical ballots of different voters one by one", () => {
    const rows = [11, 12, 13, 14, 15, 16].map((voter, i) => row(100 + i, voter, 1));
    expect(tallyBallots(rows, 2, null)).toEqual({ counts: [0, 6], total: 6, myVoteIndex: null });
  });

  it("counts a ballot whose voter is gone, and never matches it to a caller", () => {
    const rows = [row(1, null, 0), row(2, null, 0), row(3, 5, 1)];
    expect(tallyBallots(rows, 2, 5)).toEqual({ counts: [2, 1], total: 3, myVoteIndex: 1 });
  });

  it("totals a ballot whose option no longer exists but counts it for no option", () => {
    const rows = [row(1, 11, 3), row(2, 12, 1), row(3, 13, "x")];
    expect(tallyBallots(rows, 2, 11)).toEqual({ counts: [0, 1], total: 3, myVoteIndex: 3 });
    expect(tallyBallots(rows, 2, 13).myVoteIndex).toBeNull();
  });

  it("gives zero counts for every option of a poll without votes", () => {
    expect(tallyBallots([], 3, 5)).toEqual({ counts: [0, 0, 0], total: 0, myVoteIndex: null });
    expect(tallyBallots([], 0, null)).toEqual({ counts: [], total: 0, myVoteIndex: null });
  });
});

/**
 * The SQL side (FX20). Its behaviour on the real engines is in
 * poll-ballots.engine.test.ts; these pin the pure parts around it.
 */
const TABLES: BallotTables = {
  votes: "poll_votes",
  optionColumn: "option_index",
  pollLink: { table: "poll_votes_poll_lnk", voteColumn: "poll_vote_id", pollColumn: "poll_id" },
  voterLink: { table: "poll_votes_voter_lnk", voteColumn: "poll_vote_id", userColumn: "user_id" },
};

/** poll-vote metadata in the shape @strapi/database 5.55.1 builds it. */
const metadataOf = (meta: unknown) => ({ get: (uid: string) => (uid === POLL_VOTE_UID ? meta : undefined) });
const META = {
  tableName: "poll_votes",
  attributes: {
    optionIndex: { type: "integer", columnName: "option_index" },
    poll: {
      type: "relation",
      joinTable: {
        name: "poll_votes_poll_lnk",
        joinColumn: { name: "poll_vote_id" },
        inverseJoinColumn: { name: "poll_id" },
      },
    },
    voter: {
      type: "relation",
      joinTable: {
        name: "poll_votes_voter_lnk",
        joinColumn: { name: "poll_vote_id" },
        inverseJoinColumn: { name: "user_id" },
      },
    },
  },
};

describe("ballotTables", () => {
  it("reads the table, the option column and both link tables from the metadata", () => {
    expect(ballotTables(metadataOf(META))).toEqual(TABLES);
  });

  it("fails loudly when the metadata lacks any of them", () => {
    const broken = [
      undefined,
      { ...META, tableName: "" },
      { ...META, attributes: { ...META.attributes, optionIndex: { type: "integer" } } },
      { ...META, attributes: { ...META.attributes, voter: { type: "relation" } } },
      {
        ...META,
        attributes: {
          ...META.attributes,
          poll: { type: "relation", joinTable: { name: "poll_votes_poll_lnk", joinColumn: { name: "poll_vote_id" } } },
        },
      },
    ];
    for (const meta of broken) {
      expect(() => ballotTables(metadataOf(meta)), JSON.stringify(meta)).toThrow(
        "[poll-results] the tables of api::poll-vote.poll-vote are unknown to the query engine",
      );
    }
  });
});

describe("ballotCountStatement", () => {
  it("binds one value per placeholder, schema-qualifies only tables, and has no DISTINCT", () => {
    for (const schema of [null, "tenant_a"]) {
      const { sql, bindings } = ballotCountStatement(TABLES, schema, 42, 7);
      const placeholders = sql.match(/\?\??/g) ?? [];
      expect(bindings).toHaveLength(placeholders.length);
      expect(sql).toMatch(/GROUP BY/);
      expect(sql).toMatch(/count\(v\.id\)/);
      expect(sql).not.toMatch(/distinct/i);
      const tables = bindings.filter((value) => typeof value === "string" && value.includes("_lnk"));
      for (const table of tables) {
        expect(table).toBe(schema ? `${schema}.${String(table).split(".")[1]}` : table);
      }
      expect(bindings).toContain(schema ? `${schema}.poll_votes` : "poll_votes");
      expect(bindings).toContain(42);
      expect(bindings).toContain(7);
    }
  });

  it("matches no voter without a caller", () => {
    const { bindings } = ballotCountStatement(TABLES, null, 42, null);
    expect(bindings[2]).toBe(-1);
  });
});

describe("tallyFromCounts", () => {
  it("sums the statement's rows like tallyBallots: counts, total, the caller's option", () => {
    expect(
      tallyFromCounts(
        [
          { option_index: 0, ballots: 2, mine: 0 },
          { option_index: 1, ballots: 3, mine: 1 },
        ],
        2,
      ),
    ).toEqual({ counts: [2, 3], total: 5, myVoteIndex: 1 });
  });

  it("reads Postgres' bigint and numeric strings", () => {
    expect(
      tallyFromCounts([{ option_index: 1, ballots: "4", mine: "1" }, { option_index: 0, ballots: "2", mine: "0" }], 2),
    ).toEqual({ counts: [2, 4], total: 6, myVoteIndex: 1 });
  });

  it("totals an option edited away (or a NULL option) but counts it for no option", () => {
    expect(
      tallyFromCounts(
        [
          { option_index: 3, ballots: 1, mine: 1 },
          { option_index: null, ballots: 2, mine: 0 },
          { option_index: 1, ballots: 1, mine: 0 },
        ],
        2,
      ),
    ).toEqual({ counts: [0, 1], total: 4, myVoteIndex: 3 });
    expect(tallyFromCounts([{ option_index: null, ballots: 1, mine: 1 }], 2).myVoteIndex).toBeNull();
  });

  it("gives zero counts without rows", () => {
    expect(tallyFromCounts([], 3)).toEqual({ counts: [0, 0, 0], total: 0, myVoteIndex: null });
  });
});

describe("countPollBallots", () => {
  it("runs the statement on the schema the engine uses and reads both result shapes", async () => {
    const calls: { sql: string; bindings: readonly unknown[] }[] = [];
    const rows = [{ option_index: 1, ballots: 2, mine: 1 }];
    for (const [schema, result] of [
      [undefined, rows],
      ["public", { rows }],
    ] as const) {
      const host = {
        db: {
          connection: {
            raw: async (sql: string, bindings: readonly unknown[]) => {
              calls.push({ sql, bindings });
              return result;
            },
          },
          metadata: metadataOf(META),
          getSchemaName: () => schema,
        },
      };
      await expect(countPollBallots(host, 42, 7, 2)).resolves.toEqual({
        counts: [0, 2],
        total: 2,
        myVoteIndex: 1,
      });
    }
    expect(calls).toHaveLength(2);
    expect(calls[0]?.bindings).toContain("poll_votes");
    expect(calls[1]?.bindings).toContain("public.poll_votes");
  });
});
