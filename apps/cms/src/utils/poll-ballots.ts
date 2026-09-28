/**
 * One ballot per voter: which stored poll-vote rows the results count.
 * Pure; the poll-vote controller (api/poll-vote/controllers/poll-vote.ts)
 * loads the rows and applies it.
 *
 * Why rows and ballots can differ: a vote is check-then-insert, and no
 * database constraint can make (poll, voter) unique, because the voter sits
 * in a link table (#16, DA04). Parallel votes of one user can therefore all
 * be stored (measured on Postgres 16: up to 8 of 8, docs/architecture.md
 * §7b). The vote handler removes a voter's later rows right after its own
 * insert, so stored duplicates converge, but rows from before that cleanup
 * existed, or from the instant between an insert and its cleanup, must not
 * count either.
 *
 * THE RULE: a vote cannot be changed once it is cast (the handler answers
 * "Already voted"), so a voter's FIRST accepted ballot is the one that
 * counts: the row with the lowest id. Ids grow with every insert on SQLite
 * and Postgres alike, and it is the row the vote handler's cleanup keeps,
 * the same "keep the oldest row" rule as the reaction dedupe
 * (api/reaction/controllers/reaction.ts). A row whose voter is gone (the
 * user was deleted, which removes the link row) counts on its own, as an
 * RSVP row without a user does in the RSVP summary (utils/rsvp.ts).
 *
 * Nothing here names a voter: callers get counts, a total and the caller's
 * own option only.
 */

/** A poll-vote row as the results query reads it: its id, option and voter id. */
export interface BallotRow {
  id: number;
  optionIndex?: unknown;
  voter?: { id?: unknown } | null;
}

export interface BallotTally {
  /** Ballots per option, by option index. */
  counts: number[];
  /** Every counted ballot, including one whose option no longer exists. */
  total: number;
  /** The option of the caller's counted ballot, or null. */
  myVoteIndex: number | null;
}

export const isOptionIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** The numeric voter id of a row, or null when the voter is gone. */
export function ballotVoterId(row: BallotRow): number | null {
  const id = row.voter?.id;
  return typeof id === "number" ? id : null;
}

/**
 * The rows that count, one per voter: the voter's row with the lowest id.
 * Rows without a voter each count on their own. Sorted by id ascending.
 */
export function countedBallots<T extends BallotRow>(rows: readonly T[]): T[] {
  const firstByVoter = new Map<number, T>();
  const counted: T[] = [];
  for (const row of rows) {
    const voterId = ballotVoterId(row);
    if (voterId === null) {
      counted.push(row);
      continue;
    }
    const first = firstByVoter.get(voterId);
    if (!first || row.id < first.id) firstByVoter.set(voterId, row);
  }
  counted.push(...firstByVoter.values());
  return counted.sort((a, b) => a.id - b.id);
}

/**
 * Counts per option over the counted ballots (countedBallots), their total,
 * and the option of `callerId`'s counted ballot. A ballot whose option index
 * is outside `optionCount` (the options were edited after the vote) counts
 * in the total but for no option, as before this rule.
 */
export function tallyBallots(
  rows: readonly BallotRow[],
  optionCount: number,
  callerId: number | null,
): BallotTally {
  const counts = Array.from({ length: optionCount }, () => 0);
  let myVoteIndex: number | null = null;
  const ballots = countedBallots(rows);
  for (const ballot of ballots) {
    const option = ballot.optionIndex;
    if (isOptionIndex(option) && option < optionCount) counts[option] += 1;
    if (callerId !== null && ballotVoterId(ballot) === callerId) {
      myVoteIndex = isOptionIndex(option) ? option : null;
    }
  }
  return { counts, total: ballots.length, myVoteIndex };
}
