/**
 * Delete-lifecycle transaction handling.
 *
 * No DB here (lifecycles-sqlite.test.ts runs the real query engine) — a fake
 * `strapi` models the two things that matter:
 *
 *  - K2, afterDelete: the orphan re-check + removal must NOT run inline (it
 *    would see the not-yet-committed deleteRelations rows under READ
 *    COMMITTED and skip everything), but deferred to `onCommit`, i.e. after
 *    the transaction commits. We drive the deferral explicitly: registered
 *    callbacks do not run until the test "commits", and only then is the file
 *    removed — and only when it is both stamped and unattached.
 *  - FX45, beforeDelete: the image-id scan must join the ambient transaction
 *    (`.transacting(trx)`). The fake join-table builder answers only inside
 *    that transaction; on the pool it fails the way SQLite's single
 *    connection did (a 60 s acquire timeout behind the delete's own
 *    transaction).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import lifecycles from "./lifecycles";

type FakeFile = { id: number; provider?: string; provider_metadata?: unknown };

/** The transaction the Document Service's delete runs in. */
const AMBIENT_TRX = { name: "ambient-delete-trx" };

interface JoinRow {
  file_id: number;
  related_id: number;
  related_type: string;
  field: string;
}

/** Whether the delete's transaction is still open (SQLite: it holds the only connection). */
interface TrxState {
  open: boolean;
}

/**
 * A knex-like builder over the files_related_mph rows. With `poolBlocked`,
 * a read outside the ambient transaction fails while that transaction is
 * open, like knex's acquire timeout on SQLite's one-connection pool.
 */
function joinTableBuilder(
  rows: JoinRow[],
  log: string[],
  trxState: TrxState,
  poolBlocked: boolean,
) {
  let where: Partial<JoinRow> = {};
  let relatedIds: number[] | null = null;
  let fileIds: number[] | null = null;
  let trx: unknown = null;
  const builder = {
    where(clause: Partial<JoinRow>) {
      where = { ...where, ...clause };
      return builder;
    },
    whereIn(column: string, values: number[]) {
      if (column === "related_id") relatedIds = values;
      if (column === "file_id") fileIds = values;
      return builder;
    },
    transacting(handle: unknown) {
      trx = handle;
      log.push("transacting");
      return builder;
    },
    async pluck(column: keyof JoinRow) {
      log.push(trx === AMBIENT_TRX ? "pluck:trx" : "pluck:pool");
      if (poolBlocked && trx !== AMBIENT_TRX && trxState.open) {
        throw new Error("Knex: Timeout acquiring a connection. The pool is probably full.");
      }
      const hit = rows.filter(
        (row) =>
          Object.entries(where).every(([key, value]) => row[key as keyof JoinRow] === value) &&
          (relatedIds === null || relatedIds.includes(row.related_id)) &&
          (fileIds === null || fileIds.includes(row.file_id)),
      );
      return hit.map((row) => row[column]);
    },
  };
  return builder;
}

function makeStrapi(opts: {
  files: FakeFile[];
  attachedFileIds: number[];
  joinRows?: JoinRow[];
  classifiedIds?: number[];
  /** The pool is blocked by the delete's own transaction (SQLite). */
  poolBlocked?: boolean;
}) {
  const commitCallbacks: Array<() => unknown> = [];
  const removed: number[] = [];
  const log: string[] = [];
  const trxState: TrxState = { open: true };
  const strapi = {
    log: { info: vi.fn(), error: vi.fn() },
    plugin: () => ({
      service: () => ({
        remove: async (file: FakeFile) => {
          removed.push(file.id);
        },
      }),
    }),
    db: {
      // Nested transaction: hands out the ambient trx, registers onCommit
      // callbacks and does NOT run them yet.
      transaction: async <T>(
        cb: (args: { trx: unknown; onCommit: (fn: () => unknown) => void }) => T,
      ): Promise<Awaited<T>> => {
        log.push("transaction");
        return await cb({ trx: AMBIENT_TRX, onCommit: (fn) => commitCallbacks.push(fn) });
      },
      getConnection: (table: string) => {
        if (table !== "files_related_mph") throw new Error(`unexpected table ${table}`);
        if (opts.joinRows) {
          return joinTableBuilder(opts.joinRows, log, trxState, opts.poolBlocked === true);
        }
        return { whereIn: () => ({ pluck: async () => opts.attachedFileIds }) };
      },
      query: (uid: string) => ({
        findOne: async ({ where }: { where: { id: number } }) =>
          opts.files.find((f) => f.id === where.id) ?? null,
        findMany: async () => {
          log.push(`findMany:${uid}`);
          return (opts.classifiedIds ?? []).map((id) => ({ id }));
        },
      }),
    },
  };
  return { strapi, commitCallbacks, removed, log, trxState };
}

/** Commits the delete's transaction, then runs the onCommit callbacks. */
async function runCommit(callbacks: Array<() => unknown>, trxState?: TrxState) {
  if (trxState) trxState.open = false;
  for (const cb of callbacks) await cb();
}

let restore: unknown;

beforeEach(() => {
  restore = (globalThis as { strapi?: unknown }).strapi;
});
afterEach(() => {
  (globalThis as { strapi?: unknown }).strapi = restore;
});

function install(strapi: unknown) {
  (globalThis as { strapi?: unknown }).strapi = strapi;
}

describe("classified afterDelete cleanup (K2 — post-commit deferral)", () => {
  it("does NOT remove inline — only after the transaction commits", async () => {
    const { strapi, commitCallbacks, removed } = makeStrapi({
      files: [{ id: 10, provider: "local", provider_metadata: { uploadedBy: 7 } }],
      attachedFileIds: [],
    });
    install(strapi);

    await lifecycles.afterDelete({ state: { imageFileIds: [10] } });
    // Deferred: nothing removed yet, exactly one onCommit callback queued.
    expect(removed).toEqual([]);
    expect(commitCallbacks).toHaveLength(1);

    await runCommit(commitCallbacks);
    expect(removed).toEqual([10]);
  });

  it("skips a file that is still attached to another ad", async () => {
    const { strapi, commitCallbacks, removed } = makeStrapi({
      files: [{ id: 10, provider: "local", provider_metadata: { uploadedBy: 7 } }],
      attachedFileIds: [10],
    });
    install(strapi);

    await lifecycles.afterDelete({ state: { imageFileIds: [10] } });
    await runCommit(commitCallbacks);
    expect(removed).toEqual([]);
  });

  it("never touches an unstamped (admin) upload", async () => {
    const { strapi, commitCallbacks, removed } = makeStrapi({
      files: [{ id: 10, provider: "local", provider_metadata: null }],
      attachedFileIds: [],
    });
    install(strapi);

    await lifecycles.afterDelete({ state: { imageFileIds: [10] } });
    await runCommit(commitCallbacks);
    expect(removed).toEqual([]);
  });

  it("no recorded ids → no transaction, no removal", async () => {
    const { strapi, commitCallbacks, removed } = makeStrapi({
      files: [],
      attachedFileIds: [],
    });
    install(strapi);

    await lifecycles.afterDelete({ state: {} });
    expect(commitCallbacks).toHaveLength(0);
    expect(removed).toEqual([]);
  });
});

describe("classified beforeDelete scan (FX45 — inside the delete's transaction)", () => {
  const joinRows: JoinRow[] = [
    { file_id: 10, related_id: 3, related_type: "api::classified.classified", field: "images" },
    { file_id: 11, related_id: 3, related_type: "api::classified.classified", field: "images" },
    { file_id: 10, related_id: 3, related_type: "api::classified.classified", field: "images" },
    { file_id: 12, related_id: 4, related_type: "api::classified.classified", field: "images" },
    { file_id: 13, related_id: 3, related_type: "api::user.user", field: "avatar" },
  ];

  it("reads the ad's image ids through the ambient transaction", async () => {
    const { strapi, log } = makeStrapi({
      files: [],
      attachedFileIds: [],
      joinRows,
      classifiedIds: [3],
      poolBlocked: true,
    });
    install(strapi);

    const event = { params: { where: { id: 3 } }, state: {} as { imageFileIds?: number[] } };
    await lifecycles.beforeDelete(event);
    expect(event.state.imageFileIds).toEqual([10, 11]);
    expect(log).toEqual([
      "transaction",
      "findMany:api::classified.classified",
      "transacting",
      "pluck:trx",
    ]);
    expect(strapi.log.error).not.toHaveBeenCalled();
  });

  it("fails open when the scan fails: the delete goes on, the janitor sweeps later", async () => {
    const { strapi } = makeStrapi({ files: [], attachedFileIds: [], classifiedIds: [3] });
    strapi.db.getConnection = () => {
      throw new Error("boom");
    };
    install(strapi);

    const event = { params: { where: { id: 3 } }, state: {} as { imageFileIds?: number[] } };
    await expect(lifecycles.beforeDelete(event)).resolves.toBeUndefined();
    expect(event.state.imageFileIds).toBeUndefined();
    expect(strapi.log.error).toHaveBeenCalledWith(
      "[uploads-janitor] classified beforeDelete scan failed: boom",
    );
  });

  it("does nothing without a where clause", async () => {
    const { strapi, log } = makeStrapi({ files: [], attachedFileIds: [], joinRows });
    install(strapi);
    const event = { params: {}, state: {} as { imageFileIds?: number[] } };
    await lifecycles.beforeDelete(event);
    expect(log).toEqual([]);
    expect(event.state.imageFileIds).toBeUndefined();
  });

  it("hands the recorded ids to afterDelete, which removes them after commit", async () => {
    const rows = joinRows.map((row) => ({ ...row }));
    const { strapi, commitCallbacks, removed, trxState } = makeStrapi({
      files: [
        { id: 10, provider: "local", provider_metadata: { uploadedBy: 7 } },
        { id: 11, provider: "local", provider_metadata: { uploadedBy: 7 } },
        { id: 12, provider: "local", provider_metadata: { uploadedBy: 7 } },
      ],
      attachedFileIds: [],
      joinRows: rows,
      classifiedIds: [3],
      poolBlocked: true,
    });
    install(strapi);
    const state: { imageFileIds?: number[] } = {};
    await lifecycles.beforeDelete({ params: { where: { id: 3 } }, state });
    // deleteRelations removes the ad's relation rows inside the transaction.
    rows.splice(0, rows.length, ...rows.filter((row) => row.related_id !== 3));
    await lifecycles.afterDelete({ state });
    expect(removed).toEqual([]);
    // The re-check reads the pool after the commit: no longer blocked.
    await runCommit(commitCallbacks, trxState);
    expect(removed).toEqual([10, 11]);
    expect(strapi.log.error).not.toHaveBeenCalled();
  });

  it("before FX45 the pool read timed out on SQLite and nothing was removed", async () => {
    const { strapi, log } = makeStrapi({
      files: [],
      attachedFileIds: [],
      joinRows,
      classifiedIds: [3],
      poolBlocked: true,
    });
    install(strapi);
    // The old call: no trx, so the read waits for the pool.
    const { classifiedImageFileIds } = await import("../../../../utils/upload-orphans");
    await expect(classifiedImageFileIds(strapi, [3])).rejects.toThrow("Timeout acquiring");
    expect(log).toEqual(["pluck:pool"]);
  });
});
