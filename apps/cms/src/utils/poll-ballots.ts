/**
 * One ballot per voter: which stored poll-vote rows the results count, and
 * the one SQL statement that counts them (countPollBallots, FX20).
 *
 * The rule is written twice on purpose: `countedBallots`/`tallyBallots` are
 * the pure reference over loaded rows, and `countPollBallots` applies the
 * same rule in the database with a GROUP BY. poll-ballots.engine.test.ts
 * holds the two equal on SQLite and Postgres 16; the results handler
 * (api/poll-vote/controllers/poll-vote.ts) uses the SQL.
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
 *
 * WHY ONE STATEMENT (countPollBallots). The results read used to load the
 * vote rows and then their voters in a second query (a populate). A vote's
 * cleanup deleting a voter's later row between the two made that row come
 * back without a voter, so it counted as a separate ballot of a deleted
 * account (Codex review of batch 8). One statement reads rows and voters
 * from one snapshot (Postgres: the statement's snapshot under Read
 * Committed; SQLite: one read transaction), and the entity manager deletes
 * a vote row and its link rows in one statement (ON DELETE CASCADE), so a
 * duplicate is either fully there, and counted as its voter's later
 * ballot, or fully gone.
 *
 * The statement counts per option index with GROUP BY and `count(v.id)`:
 * the primary key, never a projection a DISTINCT could collapse (the
 * @strapi/database query builder turns a joined select without groupBy into
 * SELECT DISTINCT, 0bc7830; this raw statement has no DISTINCT at all). A
 * row counts when no row of the same voter for the same poll has a lower
 * id; `vl2.voter = vl.voter` is never true for a row without a voter, so
 * each of those counts. Table and column names come from the query
 * engine's metadata (never guessed), schema-qualified on Postgres
 * (Strapi's DATABASE_SCHEMA, which it applies per query, not through a
 * search_path).
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
 * in the total but for no option, as before this rule. The reference
 * countPollBallots is tested against.
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

// ---------------------------------------------------------------------------
// The same rule in one SQL statement (FX20)
// ---------------------------------------------------------------------------

export const POLL_VOTE_UID = "api::poll-vote.poll-vote";

/** poll_votes and its two link tables, as the query engine names them. */
export interface BallotTables {
  votes: string;
  optionColumn: string;
  pollLink: { table: string; voteColumn: string; pollColumn: string };
  voterLink: { table: string; voteColumn: string; userColumn: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * The tables of poll-vote from @strapi/database metadata (its `tableName`,
 * the optionIndex column, and the link tables of the `poll` and `voter`
 * relations), or a thrown error naming what is missing: a Strapi upgrade
 * that changes the metadata must fail loudly, not count wrong.
 */
export function ballotTables(metadata: { get(uid: string): unknown }): BallotTables {
  const meta = metadata.get(POLL_VOTE_UID);
  const attributes = field(meta, "attributes");
  const link = (relation: "poll" | "voter") => {
    const joinTable = field(field(attributes, relation), "joinTable");
    return {
      table: field(joinTable, "name"),
      voteColumn: field(field(joinTable, "joinColumn"), "name"),
      otherColumn: field(field(joinTable, "inverseJoinColumn"), "name"),
    };
  };
  const votes = field(meta, "tableName");
  const optionColumn = field(field(attributes, "optionIndex"), "columnName");
  const poll = link("poll");
  const voter = link("voter");
  const names = [votes, optionColumn, poll.table, poll.voteColumn, poll.otherColumn];
  names.push(voter.table, voter.voteColumn, voter.otherColumn);
  if (!names.every(isName)) {
    throw new Error(
      `[poll-results] the tables of ${POLL_VOTE_UID} are unknown to the query engine`,
    );
  }
  return {
    votes: votes as string,
    optionColumn: optionColumn as string,
    pollLink: {
      table: poll.table as string,
      voteColumn: poll.voteColumn as string,
      pollColumn: poll.otherColumn as string,
    },
    voterLink: {
      table: voter.table as string,
      voteColumn: voter.voteColumn as string,
      userColumn: voter.otherColumn as string,
    },
  };
}

/**
 * The statement with `??` identifier and `?` value placeholders (knex
 * raw), and its bindings. Aliases: v = the vote, pl/vl = its poll and voter
 * links; pl2/v2/vl2 = an earlier row of the same voter for the same poll.
 */
export function ballotCountStatement(
  tables: BallotTables,
  schema: string | null,
  pollId: number,
  callerId: number | null,
): { sql: string; bindings: unknown[] } {
  const qualified = (table: string) => (schema ? `${schema}.${table}` : table);
  const { votes, optionColumn, pollLink, voterLink } = tables;
  const sql = [
    "SELECT v.?? AS option_index, count(v.id) AS ballots,",
    "  sum(CASE WHEN vl.?? = ? THEN 1 ELSE 0 END) AS mine",
    "FROM ?? v",
    "JOIN ?? pl ON pl.?? = v.id",
    "LEFT JOIN ?? vl ON vl.?? = v.id",
    "WHERE pl.?? = ?",
    "  AND NOT EXISTS (",
    "    SELECT 1 FROM ?? pl2",
    "    JOIN ?? v2 ON v2.id = pl2.??",
    "    JOIN ?? vl2 ON vl2.?? = pl2.??",
    "    WHERE pl2.?? = pl.?? AND vl2.?? = vl.?? AND pl2.?? < v.id",
    "  )",
    "GROUP BY v.??",
  ].join("\n");
  const bindings: unknown[] = [
    optionColumn,
    voterLink.userColumn,
    // No caller: a value no voter id has, so `mine` stays 0.
    callerId ?? -1,
    qualified(votes),
    qualified(pollLink.table),
    pollLink.voteColumn,
    qualified(voterLink.table),
    voterLink.voteColumn,
    pollLink.pollColumn,
    pollId,
    qualified(pollLink.table),
    qualified(votes),
    pollLink.voteColumn,
    qualified(voterLink.table),
    voterLink.voteColumn,
    pollLink.voteColumn,
    pollLink.pollColumn,
    pollLink.pollColumn,
    voterLink.userColumn,
    voterLink.userColumn,
    pollLink.voteColumn,
    optionColumn,
  ];
  return { sql, bindings };
}

/** One row of the statement: an option index, its ballots, the caller's among them. */
export interface BallotCountRow {
  option_index?: unknown;
  ballots?: unknown;
  mine?: unknown;
}

/** A database count as a number (Postgres returns bigint and numeric as strings). */
const count = (value: unknown): number => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : 0;
};

/** The tally of the statement's rows: the same shape and rules as tallyBallots. */
export function tallyFromCounts(rows: readonly BallotCountRow[], optionCount: number): BallotTally {
  const counts = Array.from({ length: optionCount }, () => 0);
  let total = 0;
  let myVoteIndex: number | null = null;
  for (const row of rows) {
    const ballots = count(row.ballots);
    const option =
      typeof row.option_index === "string" ? Number(row.option_index) : row.option_index;
    total += ballots;
    if (isOptionIndex(option) && option < optionCount) counts[option] += ballots;
    if (count(row.mine) > 0) myVoteIndex = isOptionIndex(option) ? option : null;
  }
  return { counts, total, myVoteIndex };
}

/** The slice of the Strapi instance countPollBallots uses. */
export interface BallotCountHost {
  db: {
    /** knex; only raw() is used. */
    connection: { raw(sql: string, bindings: readonly unknown[]): PromiseLike<unknown> };
    metadata: { get(uid: string): unknown };
    /** The Postgres schema (DATABASE_SCHEMA); undefined on SQLite. */
    getSchemaName?(): string | undefined;
  };
}

/** knex raw's rows: an array on SQLite, `{ rows }` on Postgres. */
function rawRows(result: unknown): unknown[] {
  const rows = Array.isArray(result) ? result : field(result, "rows");
  return Array.isArray(rows) ? rows : [];
}

/**
 * The results of poll row `pollId` in ONE statement: ballots per option,
 * one per voter (the first), the total, and `callerId`'s counted option.
 */
export async function countPollBallots(
  strapi: BallotCountHost,
  pollId: number,
  callerId: number | null,
  optionCount: number,
): Promise<BallotTally> {
  const tables = ballotTables(strapi.db.metadata);
  const schema = strapi.db.getSchemaName?.() ?? null;
  const { sql, bindings } = ballotCountStatement(tables, schema || null, pollId, callerId);
  const result = await strapi.db.connection.raw(sql, bindings);
  return tallyFromCounts(rawRows(result) as BallotCountRow[], optionCount);
}

// ---------------------------------------------------------------------------
// Several polls in one statement (WD04: GET /api/poll-results)
// ---------------------------------------------------------------------------

/** Most polls one batched count takes (the endpoint's cap). */
export const MAX_BATCHED_POLLS = 50;

/**
 * The statement of ballotCountStatement for several poll rows at once: the
 * same rows count (the first ballot of each voter per poll, NOT EXISTS over
 * an earlier row of the same voter FOR THE SAME POLL), grouped by poll and
 * option, with the poll row id as `poll_id`. One snapshot for all of them.
 */
export function ballotCountsStatement(
  tables: BallotTables,
  schema: string | null,
  pollIds: readonly number[],
  callerId: number | null,
): { sql: string; bindings: unknown[] } {
  if (pollIds.length === 0 || pollIds.length > MAX_BATCHED_POLLS) {
    throw new Error(
      `[poll-results] 1..${MAX_BATCHED_POLLS} polls per statement, got ${pollIds.length}`,
    );
  }
  const qualified = (table: string) => (schema ? `${schema}.${table}` : table);
  const { votes, optionColumn, pollLink, voterLink } = tables;
  const sql = [
    "SELECT pl.?? AS poll_id, v.?? AS option_index, count(v.id) AS ballots,",
    "  sum(CASE WHEN vl.?? = ? THEN 1 ELSE 0 END) AS mine",
    "FROM ?? v",
    "JOIN ?? pl ON pl.?? = v.id",
    "LEFT JOIN ?? vl ON vl.?? = v.id",
    `WHERE pl.?? IN (${pollIds.map(() => "?").join(", ")})`,
    "  AND NOT EXISTS (",
    "    SELECT 1 FROM ?? pl2",
    "    JOIN ?? v2 ON v2.id = pl2.??",
    "    JOIN ?? vl2 ON vl2.?? = pl2.??",
    "    WHERE pl2.?? = pl.?? AND vl2.?? = vl.?? AND pl2.?? < v.id",
    "  )",
    "GROUP BY pl.??, v.??",
  ].join("\n");
  const bindings: unknown[] = [
    pollLink.pollColumn,
    optionColumn,
    voterLink.userColumn,
    // No caller: a value no voter id has, so `mine` stays 0.
    callerId ?? -1,
    qualified(votes),
    qualified(pollLink.table),
    pollLink.voteColumn,
    qualified(voterLink.table),
    voterLink.voteColumn,
    pollLink.pollColumn,
    ...pollIds,
    qualified(pollLink.table),
    qualified(votes),
    pollLink.voteColumn,
    qualified(voterLink.table),
    voterLink.voteColumn,
    pollLink.voteColumn,
    pollLink.pollColumn,
    pollLink.pollColumn,
    voterLink.userColumn,
    voterLink.userColumn,
    pollLink.voteColumn,
    pollLink.pollColumn,
    optionColumn,
  ];
  return { sql, bindings };
}

/** One poll of a batched count: its published row id and its number of options. */
export interface BallotPoll {
  id: number;
  optionCount: number;
}

/**
 * The results of several poll rows in ONE statement (ballotCountsStatement):
 * per poll row id the same tally countPollBallots gives for it alone. A
 * poll without a counted ballot gets zero counts. Throws past
 * MAX_BATCHED_POLLS; no statement for no polls.
 */
export async function countPollBallotsMany(
  strapi: BallotCountHost,
  polls: readonly BallotPoll[],
  callerId: number | null,
): Promise<Map<number, BallotTally>> {
  const tallies = new Map<number, BallotTally>();
  if (polls.length === 0) return tallies;
  const ids = [...new Set(polls.map((poll) => poll.id))];
  const tables = ballotTables(strapi.db.metadata);
  const schema = strapi.db.getSchemaName?.() ?? null;
  const { sql, bindings } = ballotCountsStatement(tables, schema || null, ids, callerId);
  const byPoll = new Map<number, BallotCountRow[]>();
  for (const row of rawRows(await strapi.db.connection.raw(sql, bindings))) {
    const pollId = Number(field(row, "poll_id"));
    const rows = byPoll.get(pollId) ?? [];
    rows.push(row as BallotCountRow);
    byPoll.set(pollId, rows);
  }
  for (const poll of polls) {
    tallies.set(poll.id, tallyFromCounts(byPoll.get(poll.id) ?? [], poll.optionCount));
  }
  return tallies;
}
