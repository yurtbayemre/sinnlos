/**
 * Post-commit side effects (LF02) against the shared Strapi stub, whose
 * transactions behave like @strapi/database's: nested calls join the open
 * transaction, commit callbacks run once the OUTERMOST one commits, a
 * rollback runs none. The real engine is pinned in after-commit.engine.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

import { createStrapiStub } from "../test/strapi-stub.test.helper";
import { afterCommit, inOwnTransaction, type CommitAwareDb } from "./after-commit";

describe("afterCommit", () => {
  it("no transaction: runs right away and resolves after the task", async () => {
    const { db } = createStrapiStub();
    const order: string[] = [];
    await afterCommit(
      db,
      async () => {
        await Promise.resolve();
        order.push("task");
      },
      () => undefined,
    );
    order.push("returned");
    expect(order).toEqual(["task", "returned"]);
  });

  it("in a transaction: nothing runs before the commit", async () => {
    const { db } = createStrapiStub();
    const task = vi.fn();
    await db.transaction(async () => {
      await afterCommit(db, task, () => undefined);
      expect(task).not.toHaveBeenCalled();
    });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("a nested transaction defers to the OUTER commit", async () => {
    const { db } = createStrapiStub();
    const task = vi.fn();
    await db.transaction(async () => {
      await db.transaction(async () => {
        await afterCommit(db, task, () => undefined);
      });
      expect(task).not.toHaveBeenCalled();
    });
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("a rollback runs nothing", async () => {
    const { db } = createStrapiStub();
    const task = vi.fn();
    await expect(
      db.transaction(async () => {
        await afterCommit(db, task, () => undefined);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(task).not.toHaveBeenCalled();
  });

  it("never throws: a failing task goes to onError, a failing onError is swallowed", async () => {
    const { db } = createStrapiStub();
    const onError = vi.fn();
    await expect(
      afterCommit(
        db,
        () => {
          throw new Error("boom");
        },
        onError,
      ),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(new Error("boom"));

    await expect(
      db.transaction(async () => {
        await afterCommit(
          db,
          async () => {
            throw new Error("late boom");
          },
          () => {
            throw new Error("handler broke");
          },
        );
        return "committed";
      }),
    ).resolves.toBe("committed");
  });

  it("runs a registered task at most once, however often the callback is called", async () => {
    // @strapi/database 5.55.1 can call a commit callback again from a later
    // sibling transaction (after-commit.engine.test.ts pins it).
    const callbacks: Array<() => unknown> = [];
    const db: CommitAwareDb = {
      inTransaction: () => true,
      transaction: async (callback) => callback({ onCommit: (fn) => callbacks.push(fn) }),
    };
    const task = vi.fn();
    await afterCommit(db, task, () => undefined);
    expect(callbacks).toHaveLength(1);
    await callbacks[0]();
    await callbacks[0]();
    expect(task).toHaveBeenCalledTimes(1);
  });

  /**
   * A transaction double with @strapi/database's shared callback lists:
   * every transaction pushes into the same two arrays and nothing clears
   * them, as for sibling transactions inside a commit callback.
   */
  function sharedListsDb() {
    const commits: Array<() => unknown> = [];
    const rollbacks: Array<() => unknown> = [];
    const open = (completed: { value: boolean }): CommitAwareDb => ({
      inTransaction: () => true,
      transaction: async (callback) =>
        callback({
          onCommit: (fn) => commits.push(fn),
          onRollback: (fn) => rollbacks.push(fn),
          trx: { isCompleted: () => completed.value },
        }),
    });
    const fire = async (list: Array<() => unknown>) => {
      for (const fn of [...list]) await fn();
    };
    return { commits, rollbacks, open, fire };
  }

  it("a rollback cancels the task, also when a later sibling's commit calls it", async () => {
    const { commits, rollbacks, open, fire } = sharedListsDb();
    const first = { value: false };
    const task = vi.fn();
    await afterCommit(open(first), task, () => undefined);
    // The first sibling rolls back: its own trx is finished.
    first.value = true;
    await fire(rollbacks);
    // A later sibling commits and the shared list still holds the callback.
    await fire(commits);
    expect(task).not.toHaveBeenCalled();
  });

  it("another transaction's rollback does not cancel a task whose transaction is still open", async () => {
    const { commits, rollbacks, open, fire } = sharedListsDb();
    const own = { value: false };
    const task = vi.fn();
    await afterCommit(open(own), task, () => undefined);
    await fire(rollbacks); // someone else's rollback, the task's trx is open
    own.value = true;
    await fire(commits); // its own commit
    await fire(rollbacks); // a later rollback: the task already ran
    await fire(commits);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("a transaction handle without isCompleted counts as finished: a rollback cancels", async () => {
    const commits: Array<() => unknown> = [];
    const rollbacks: Array<() => unknown> = [];
    const db: CommitAwareDb = {
      inTransaction: () => true,
      transaction: async (callback) =>
        callback({
          onCommit: (fn) => commits.push(fn),
          onRollback: (fn) => rollbacks.push(fn),
          trx: { stubTransaction: true },
        }),
    };
    const task = vi.fn();
    await afterCommit(db, task, () => undefined);
    for (const fn of rollbacks) await fn();
    for (const fn of commits) await fn();
    expect(task).not.toHaveBeenCalled();
  });

  it("a db without transaction support runs the task right away", async () => {
    const task = vi.fn();
    await afterCommit({}, task, () => undefined);
    await afterCommit(null, task, () => undefined);
    await afterCommit({ inTransaction: () => true }, task, () => undefined);
    expect(task).toHaveBeenCalledTimes(3);
  });
});

describe("inOwnTransaction", () => {
  it("wraps the task in a transaction, which a failing task rolls back", async () => {
    const { db } = createStrapiStub();
    const seen: boolean[] = [];
    await inOwnTransaction(db, async () => {
      seen.push(db.inTransaction());
    });
    expect(seen).toEqual([true]);

    const rolledBack = vi.fn();
    await expect(
      inOwnTransaction(db, async () => {
        await db.transaction(async ({ onRollback }) => onRollback(rolledBack));
        throw new Error("insert failed");
      }),
    ).rejects.toThrow("insert failed");
    expect(rolledBack).toHaveBeenCalledTimes(1);
    expect(db.inTransaction()).toBe(false);
  });

  it("runs the task directly without transaction support", async () => {
    const task = vi.fn(async () => "done");
    await inOwnTransaction(undefined, task);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
