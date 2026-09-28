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
 *    aborted transaction despite the catch) failed the whole publish.
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
 *    fan-out's per-row transactions inside a commit callback), inherits the
 *    finished transaction's callback list, so a later sibling commit runs
 *    the earlier siblings' callbacks again. Every registered task is
 *    therefore wrapped to run at most once.
 *
 * Not absorbed, so every task must re-read committed state: a failure AT
 * COMMIT (a deferred constraint) is not surfaced by knex 3.0.1 — trx.commit()
 * resolves — so the transaction resolves and the commit callbacks run
 * although nothing was committed (pinned on Postgres). The fan-out re-reads
 * its source and notifies nobody when it is gone; a live ping carries no
 * content, a phantom one only makes clients refetch.
 */

/** The slice of `strapi.db` this needs; both members are optional for test doubles. */
export interface CommitAwareDb {
  inTransaction?: () => boolean;
  transaction?: (
    callback: (scope: { onCommit: (callback: () => unknown) => void }) => unknown,
  ) => Promise<unknown>;
}

/** Runs `fn` at most once; later calls return undefined. */
function once(fn: () => Promise<void>): () => Promise<void> | undefined {
  let done = false;
  return () => {
    if (done) return undefined;
    done = true;
    return fn();
  };
}

/**
 * Runs `task` after the ambient transaction commits, or now without one.
 * Never throws: an error of the task is handed to `onError` (which must not
 * throw either). Resolves once the task is registered (inside a
 * transaction) or finished (outside one).
 */
export async function afterCommit(
  db: CommitAwareDb | null | undefined,
  task: () => unknown,
  onError: (err: unknown) => void,
): Promise<void> {
  const run = once(async () => {
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
    await transaction.call(db, ({ onCommit }) => {
      onCommit(run);
    });
    return;
  }
  await run();
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
