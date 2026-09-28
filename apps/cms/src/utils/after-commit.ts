/**
 * Post-commit side effects (roadmap LF02).
 *
 * Lifecycle hooks run INSIDE the caller's transaction: the Document Service
 * wraps publish/create/update/delete in `strapi.db.transaction`
 * (@strapi/core 5.55.1 document-service/common.js wrapInTransaction). A side
 * effect started there runs before the commit:
 *  - a live ping reached the browser before the rows it announces were
 *    visible, so the bell refetched and missed them; a write that rolled
 *    back still pinged;
 *  - the announcement/event fan-out inserted its notifications inside the
 *    publish transaction, where one failing INSERT (Postgres 22001, an
 *    aborted transaction despite the catch) failed the whole publish; the
 *    comment and kudos notification did the same to their comment or kudos,
 *    silently (see below).
 *
 * afterCommit(db, task) registers the task with `onCommit` when a
 * transaction is open (the pattern Strapi itself uses for its entry.*
 * events, document-service/events.js, and classified/lifecycles.ts): a
 * nested `strapi.db.transaction` joins the open one, and its commit
 * callbacks run once the OUTERMOST transaction has committed; a rollback
 * runs none of them. Without a transaction the task runs right away.
 *
 * Two properties of @strapi/database 5.55.1 (transaction-context.js) the
 * wrapper absorbs, pinned in after-commit.engine.test.ts:
 *  - commit callbacks are called without being awaited (`forEach(cb =>
 *    cb())`): a rejected promise would be an unhandled rejection, so the
 *    task's errors go to `onError` and never escape;
 *  - a transaction started after a commit, in the same async context (the
 *    fan-out's per-row transactions inside a commit callback, the comment
 *    and kudos notification), inherits the finished transaction's callback
 *    list, so a later sibling commit runs the earlier siblings' callbacks
 *    again. Every registered task is therefore wrapped to run at most once;
 *  - the same shared list keeps the callbacks of a sibling that ROLLED BACK,
 *    and a rollback does not clear it, so a later sibling's commit would
 *    run them too. Each task therefore also registers `onRollback`, which
 *    cancels it. The rollback list is shared and never cleared either, so a
 *    rollback runs the cancels of earlier siblings as well: those tasks
 *    already ran (commit callbacks start synchronously at the commit), and
 *    a task whose transaction is still open (`isCompleted()` false) is not
 *    cancelled by someone else's rollback. Today nothing registers a task
 *    and then rolls back (the only registration in a sibling is the live
 *    ping of the notification afterCreate, the last step of create()); the
 *    cancel keeps a future lifecycle step from turning that into a ping
 *    for a row that was never stored.
 *
 * Not absorbed, so every task must re-read committed state: on Postgres a
 * transaction can resolve, and run its commit callbacks, although nothing
 * was committed. The everyday case is a statement error that code inside
 * the transaction catches and swallows: Postgres has aborted the
 * transaction, COMMIT turns into a ROLLBACK without an error, knex 3.0.1
 * resolves trx.commit(), and the caller cannot tell (an API create answers
 * 201 with a row that was never stored). A failure AT COMMIT (a deferred
 * constraint) behaves the same. Both are pinned on Postgres in
 * after-commit.engine.test.ts. The fan-out re-reads its source and acts
 * only on committed state: the current published row (whose audience the
 * dedup has already served), or nobody when there is none. The comment and
 * kudos notifications re-read their row and write nothing when it is gone.
 * A live ping carries no content; a phantom one only makes clients refetch.
 */

/** What a transaction callback receives; `trx` and `onRollback` are optional for test doubles. */
export interface CommitAwareScope {
  onCommit: (callback: () => unknown) => void;
  onRollback?: (callback: () => unknown) => void;
  /** The knex transaction; `isCompleted()` tells an open one from a finished one. */
  trx?: unknown;
}

/** The slice of `strapi.db` this needs; both members are optional for test doubles. */
export interface CommitAwareDb {
  inTransaction?: () => boolean;
  transaction?: (callback: (scope: CommitAwareScope) => unknown) => Promise<unknown>;
}

/** A task that runs at most once and can be cancelled before it starts. */
interface OnceTask {
  run(): Promise<void> | undefined;
  cancel(): void;
}

/** Runs `fn` at most once; later calls, and any call after cancel(), return undefined. */
function once(fn: () => Promise<void>): OnceTask {
  let done = false;
  return {
    run() {
      if (done) return undefined;
      done = true;
      return fn();
    },
    cancel() {
      done = true;
    },
  };
}

/**
 * Whether `trx` is still open. A handle without `isCompleted` (a test
 * double) counts as finished, so a rollback cancels its tasks.
 */
function isOpen(trx: unknown): boolean {
  const isCompleted = (trx as { isCompleted?: unknown } | null | undefined)?.isCompleted;
  return typeof isCompleted === "function" && isCompleted.call(trx) === false;
}

/**
 * Runs `task` after the ambient transaction commits, or now without one.
 * Never throws: an error of the task is handed to `onError` (which must not
 * throw either). Resolves once the task is registered (inside a
 * transaction) or finished (outside one). A rollback of the transaction
 * cancels the task, also when a later sibling transaction's commit calls
 * the callback (see the header).
 */
export async function afterCommit(
  db: CommitAwareDb | null | undefined,
  task: () => unknown,
  onError: (err: unknown) => void,
): Promise<void> {
  const guarded = once(async () => {
    try {
      await task();
    } catch (err) {
      try {
        onError(err);
      } catch {
        // A failing error handler must not surface as an unhandled rejection.
      }
    }
  });
  const transaction = db?.transaction;
  if (db?.inTransaction?.() === true && typeof transaction === "function") {
    await transaction.call(db, ({ onCommit, onRollback, trx }) => {
      onCommit(() => guarded.run());
      // Someone else's rollback in the shared list must not cancel a task
      // whose own transaction is still open.
      onRollback?.(() => {
        if (!isOpen(trx)) guarded.cancel();
      });
    });
    return;
  }
  await guarded.run();
}

/**
 * Runs `task` in a transaction of its own (joining an open one, as every
 * nested strapi.db.transaction does). Used for one notification INSERT at
 * a time after the publish committed: a failing row rolls back alone and
 * cannot poison the next one (on Postgres a failed statement aborts the
 * whole transaction it runs in).
 */
export async function inOwnTransaction(
  db: CommitAwareDb | null | undefined,
  task: () => Promise<unknown>,
): Promise<void> {
  const transaction = db?.transaction;
  if (typeof transaction !== "function") {
    await task();
    return;
  }
  await transaction.call(db, () => task());
}
