import { describe, expect, it } from "vitest";

import {
  ballotVoterId,
  countedBallots,
  isOptionIndex,
  tallyBallots,
  type BallotRow,
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
