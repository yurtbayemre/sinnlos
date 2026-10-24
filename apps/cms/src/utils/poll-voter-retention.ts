import { advanceRevision, lockDocument, type DocumentLockHost } from "./document-lock";
import { instantMsOrNull } from "./time";
import { reportRunFailure } from "../cron/run-context";

/**
 * Nightly removal of poll voter links (v0.28, M11; owner decision
 * 2026-10-23): 30 days after a poll closed, who voted is no longer stored.
 * The results stay exactly as they were, and the poll can never open again.
 *
 * THE RULE (pure, `votersRemovable`): every row of the poll document
 * (draft and published) has a parseable `closesAt` more than
 * POLL_VOTER_RETENTION_DAYS ago, and some row has no `votersRemovedAt` yet.
 * A poll without `closesAt` never closes, so it keeps its links while it
 * exists; an unparseable date keeps them too (fail closed).
 *
 * THE BALLOTS (pure, `ballotPlan`): the results count a voter's FIRST
 * ballot, the lowest id (utils/poll-ballots.ts), and a row without a voter
 * on its own. So, in id order, each voter's later rows are deleted first
 * (the duplicates the vote handler's cleanup may have left), then the
 * voter link of the remaining row is removed. Every row left then counts
 * on its own, and the counts and the total are those of before. The
 * deletes and unlinks go through the entity manager one row at a time
 * (`delete`, `update` with `voter: null`), which removes the link rows;
 * a bare `deleteMany`/`updateMany` would not touch the relation.
 *
 * TERMINAL. Each row of the document gets `votersRemovedAt`. From then on
 * the poll guard refuses any `closesAt` change (utils/poll-audience-guard.ts
 * `votersRemoved`) and the vote handler refuses every vote: "Already
 * voted" could no longer match anybody.
 *
 * LOCKING. One transaction per poll: the poll's document lock first (the
 * vote handler and every Document Service write of a poll take the same
 * one), then the rule again on a fresh read, then the writes, then the
 * revision advance (decision 06 §G rule; raw-writers.test.ts), so a web
 * form open on the poll sees the change. One failing poll is logged and
 * skipped (its transaction rolls back); the next night retries it.
 *
 * DELETED POLLS. A poll's delete removes its rows and, by cascade, the
 * votes' poll links, but not the vote rows or their voter links: such a
 * ballot counts nowhere any more and only still says who voted. The same
 * run deletes those orphaned votes (`deleteOrphanedVotes`), one entity
 * manager delete per row; nothing can link them again (the vote handler
 * re-reads the poll under its lock).
 *
 * The `poll-voter-janitor` runs it at 03:56 APP_TIME_ZONE (cron/registry.ts);
 * the links it removes are more than 30 days old, so the earlier nightly
 * backups hold them. The rule is applied to every candidate BEFORE the cap,
 * and every poll it admits is stamped, so a poll the rule keeps (a draft
 * still open) never crowds out a due one: at most POLL_VOTER_MAX_PER_RUN
 * due polls and ORPHANED_VOTE_MAX_PER_RUN orphaned votes per run, the rest
 * the next night. It lives here with the other poll rules, not under
 * cron/: it serves no row and sends nothing (poll-exposure.test.ts, the
 * poll consumers inventory).
 */

/** Days after `closesAt` before the voter links go (owner decision). */
export const POLL_VOTER_RETENTION_DAYS = 30;
/** Due polls per run; the rest follows the next night. */
export const POLL_VOTER_MAX_PER_RUN = 50;
/** Orphaned votes (their poll deleted) per run. */
export const ORPHANED_VOTE_MAX_PER_RUN = 1000;
/** Poll rows per candidate read, and documentIds per rule read. */
const POLL_PAGE = 200;

export const POLL_VOTER_JANITOR_LOG = "[poll-voter-janitor]";

const POLL_UID = "api::poll.poll";
const VOTE_UID = "api::poll-vote.poll-vote";
const DAY_MS = 86_400_000;

/** The slice of the Strapi instance the janitor uses. */
export interface PollVoterJanitorStrapi {
  db: {
    query(uid: string): {
      findMany(params: Record<string, unknown>): Promise<unknown>;
      update(params: Record<string, unknown>): Promise<unknown>;
      updateMany(params: Record<string, unknown>): Promise<unknown>;
      delete(params: Record<string, unknown>): Promise<unknown>;
    };
    transaction<T>(callback: () => Promise<T>): Promise<T>;
  };
  log: { info(message: string): void; error(message: string): void };
}

/** A poll row as the rule reads it. */
export interface PollRetentionRow {
  closesAt?: unknown;
  votersRemovedAt?: unknown;
}

const asInstantInput = (value: unknown): string | Date | null =>
  typeof value === "string" || value instanceof Date ? value : null;

/** Whether the voter links of the poll with these rows go at `now` (see THE RULE). */
export function votersRemovable(
  rows: readonly PollRetentionRow[],
  now: Date,
  days: number = POLL_VOTER_RETENTION_DAYS,
): boolean {
  if (rows.length === 0) return false;
  const cutoff = now.getTime() - days * DAY_MS;
  const closedLongAgo = rows.every((row) => {
    const input = asInstantInput(row.closesAt);
    const ms = input == null ? null : instantMsOrNull(input);
    return ms != null && ms < cutoff;
  });
  return closedLongAgo && rows.some((row) => row.votersRemovedAt == null);
}

/** A vote row: its id and its voter's id (null: no voter). */
export interface BallotRow {
  id: number;
  voterId: number | null;
}

/** Which vote rows go (later duplicates) and which lose their voter link (see THE BALLOTS). */
export function ballotPlan(votes: readonly BallotRow[]): {
  deleteIds: number[];
  unlinkIds: number[];
} {
  const seen = new Set<number>();
  const deleteIds: number[] = [];
  const unlinkIds: number[] = [];
  for (const vote of [...votes].sort((a, b) => a.id - b.id)) {
    if (vote.voterId === null) continue;
    if (seen.has(vote.voterId)) deleteIds.push(vote.id);
    else {
      seen.add(vote.voterId);
      unlinkIds.push(vote.id);
    }
  }
  return { deleteIds, unlinkIds };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const listOf = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : []).filter(isRecord);

const ballotRows = (value: unknown): BallotRow[] =>
  listOf(value)
    .filter((row) => typeof row.id === "number")
    .map((row) => ({
      id: row.id as number,
      voterId: isRecord(row.voter) && typeof row.voter.id === "number" ? row.voter.id : null,
    }));

/** The poll documents due now: a row looks due, and the rule holds over all their rows. */
export async function duePolls(strapi: PollVoterJanitorStrapi, now: Date): Promise<string[]> {
  const cutoff = new Date(now.getTime() - POLL_VOTER_RETENTION_DAYS * DAY_MS).toISOString();
  const polls = strapi.db.query(POLL_UID);
  const candidates = new Set<string>();
  let afterId = 0;
  for (;;) {
    const rows = listOf(
      await polls.findMany({
        where: {
          id: { $gt: afterId },
          closesAt: { $notNull: true, $lt: cutoff },
          votersRemovedAt: { $null: true },
        },
        select: ["id", "documentId"],
        orderBy: { id: "asc" },
        limit: POLL_PAGE,
      }),
    );
    for (const row of rows) {
      if (typeof row.documentId === "string" && row.documentId !== "") {
        candidates.add(row.documentId);
      }
    }
    if (rows.length < POLL_PAGE) break;
    afterId = rows[rows.length - 1].id as number;
  }
  const ids = [...candidates];
  const due: string[] = [];
  for (let start = 0; start < ids.length; start += POLL_PAGE) {
    const chunk = ids.slice(start, start + POLL_PAGE);
    const byDocument = new Map<string, Record<string, unknown>[]>();
    for (const row of listOf(
      await polls.findMany({
        where: { documentId: { $in: chunk } },
        select: ["documentId", "closesAt", "votersRemovedAt"],
      }),
    )) {
      const documentId = row.documentId as string;
      byDocument.set(documentId, [...(byDocument.get(documentId) ?? []), row]);
    }
    for (const documentId of chunk) {
      if (votersRemovable(byDocument.get(documentId) ?? [], now)) due.push(documentId);
    }
  }
  return due;
}

/** Removes one poll's voter links (see LOCKING); null when the rule no longer holds. */
export async function removePollVoters(
  strapi: PollVoterJanitorStrapi,
  documentId: string,
  now: Date = new Date(),
): Promise<{ deleted: number; unlinked: number } | null> {
  return strapi.db.transaction(async () => {
    const lockHost = strapi as unknown as DocumentLockHost;
    await lockDocument(lockHost, POLL_UID, documentId);
    const polls = strapi.db.query(POLL_UID);
    const rows = listOf(
      await polls.findMany({
        where: { documentId },
        select: ["id", "closesAt", "votersRemovedAt"],
      }),
    );
    if (!votersRemovable(rows, now)) return null;
    const votes = strapi.db.query(VOTE_UID);
    const plan = ballotPlan(
      ballotRows(
        await votes.findMany({
          where: { poll: { documentId } },
          select: ["id"],
          populate: { voter: { select: ["id"] } },
          orderBy: { id: "asc" },
        }),
      ),
    );
    for (const id of plan.deleteIds) await votes.delete({ where: { id } });
    for (const id of plan.unlinkIds) await votes.update({ where: { id }, data: { voter: null } });
    await polls.updateMany({
      where: { documentId },
      data: { votersRemovedAt: now.toISOString() },
    });
    await advanceRevision(lockHost, POLL_UID, documentId);
    return { deleted: plan.deleteIds.length, unlinked: plan.unlinkIds.length };
  });
}

/** Deletes the votes whose poll was deleted (see DELETED POLLS); returns how many went. */
export async function deleteOrphanedVotes(
  strapi: PollVoterJanitorStrapi,
  limit: number = ORPHANED_VOTE_MAX_PER_RUN,
): Promise<number> {
  const votes = strapi.db.query(VOTE_UID);
  const rows = listOf(
    await votes.findMany({
      where: { poll: { id: { $null: true } } },
      select: ["id"],
      orderBy: { id: "asc" },
      limit,
    }),
  );
  for (const row of rows) await votes.delete({ where: { id: row.id } });
  return rows.length;
}

/** The nightly run: due polls, then orphaned votes; returns how many polls lost their voter links. */
export async function unlinkPollVoters(
  strapi: PollVoterJanitorStrapi,
  now: Date = new Date(),
): Promise<number> {
  let polls = 0;
  for (const documentId of await duePolls(strapi, now)) {
    if (polls >= POLL_VOTER_MAX_PER_RUN) break;
    try {
      const done = await removePollVoters(strapi, documentId, now);
      if (!done) continue;
      polls += 1;
      strapi.log.info(
        `${POLL_VOTER_JANITOR_LOG} poll ${documentId}: removed the voter links of ${done.unlinked} ` +
          `ballot(s) (${done.deleted} duplicate row(s) deleted); the results are unchanged`,
      );
    } catch (err) {
      reportRunFailure(
        err,
        `poll ${documentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      strapi.log.error(
        `${POLL_VOTER_JANITOR_LOG} poll ${documentId} failed, retried next night: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  const orphans = await deleteOrphanedVotes(strapi);
  if (orphans > 0) {
    strapi.log.info(`${POLL_VOTER_JANITOR_LOG} deleted ${orphans} vote(s) of deleted polls`);
  }
  return polls;
}
