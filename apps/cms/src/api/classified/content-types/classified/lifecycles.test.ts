/**
 * The classified delete lifecycle: the audit row inside the delete's
 * transaction, the image scan inside it (FX45), the image removal after the
 * commit (K2) through the one locked removal (batch 16 lane 16A).
 *
 * No DB here (lifecycles-sqlite.test.ts runs the real query engine) — a fake
 * `strapi` and spies for `recordDelete` and `claimAndRemove`:
 *
 *  - beforeDelete records ONE audit row per ad, never caught: a failing
 *    insert fails the delete;
 *  - the image-id scan joins the ambient transaction (`.transacting(trx)`).
 *    The fake join-table builder fails on the pool while the delete's
 *    transaction is open, the way SQLite's single connection did;
 *  - afterDelete defers every removal to the commit (utils/after-commit.ts)
 *    and hands each image to claimAndRemove with the ad as the related
 *    document of the delete trail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteAuditContext } from "../../../../utils/delete-audit";
import lifecycles from "./lifecycles";

const mocks = vi.hoisted(() => ({
  recordDelete: vi.fn(async (_strapi: unknown, _target: unknown) => undefined),
  claimAndRemove: vi.fn(async (_strapi: unknown, _fileId: number) => "removed"),
  lockAttachableFiles: vi.fn(async (_strapi: unknown, _ids: number[]) => true),
  contexts: [] as unknown[],
}));

vi.mock("../../../../utils/delete-audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../utils/delete-audit")>()),
  recordDelete: mocks.recordDelete,
}));

vi.mock("../../../../utils/upload-orphans", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../utils/upload-orphans")>()),
  claimAndRemove: mocks.claimAndRemove,
  lockAttachableFiles: mocks.lockAttachableFiles,
}));

/** The transaction the Document Service's delete runs in. */
const AMBIENT_TRX = { name: "ambient-delete-trx" };

interface JoinRow {
  file_id: number;
  related_id: number;
  related_type: string;
  field: string;
}

function joinTableBuilder(rows: JoinRow[], log: string[], state: { open: boolean }) {
  let where: Partial<JoinRow> = {};
  let relatedIds: number[] | null = null;
  let trx: unknown = null;
  const builder = {
    where(clause: Partial<JoinRow>) {
      where = { ...where, ...clause };
      return builder;
    },
    whereIn(column: string, values: number[]) {
      if (column === "related_id") relatedIds = values;
      return builder;
    },
    transacting(handle: unknown) {
      trx = handle;
      return builder;
    },
    async pluck(column: keyof JoinRow) {
      log.push(trx === AMBIENT_TRX ? "pluck:trx" : "pluck:pool");
      if (trx !== AMBIENT_TRX && state.open) {
        throw new Error("Knex: Timeout acquiring a connection. The pool is probably full.");
      }
      return rows
        .filter(
          (row) =>
            Object.entries(where).every(([key, value]) => row[key as keyof JoinRow] === value) &&
            (relatedIds === null || relatedIds.includes(row.related_id)),
        )
        .map((row) => row[column]);
    },
  };
  return builder;
}

const image = (fileId: number, adId: number): JoinRow => ({
  file_id: fileId,
  related_id: adId,
  related_type: "api::classified.classified",
  field: "images",
});

function makeStrapi(opts: {
  ads: Array<{ id: number; documentId: string; title: string }>;
  joinRows: JoinRow[];
  scanFails?: boolean;
}) {
  const commitCallbacks: Array<() => unknown> = [];
  const log: string[] = [];
  const state = { open: true };
  const strapi = {
    log: { info: vi.fn(), error: vi.fn() },
    db: {
      inTransaction: () => state.open,
      // Nested transaction: hands out the ambient trx, registers onCommit
      // callbacks and does NOT run them yet.
      transaction: async <T>(
        cb: (args: {
          trx: unknown;
          onCommit: (fn: () => unknown) => void;
          onRollback: (fn: () => unknown) => void;
        }) => T,
      ): Promise<Awaited<T>> =>
        await cb({
          trx: AMBIENT_TRX,
          onCommit: (fn) => commitCallbacks.push(fn),
          onRollback: () => undefined,
        }),
      getConnection: (table: string) => {
        if (table !== "files_related_mph") throw new Error(`unexpected table ${table}`);
        if (opts.scanFails) throw new Error("scan exploded");
        return joinTableBuilder(opts.joinRows, log, state);
      },
      query: () => ({
        findMany: async () => opts.ads,
      }),
    },
  };
  /** Commits the delete's transaction, then runs the onCommit callbacks. */
  const commit = async () => {
    state.open = false;
    for (const cb of commitCallbacks) await cb();
  };
  return { strapi, commitCallbacks, log, commit };
}

let restore: unknown;
beforeEach(() => {
  restore = (globalThis as { strapi?: unknown }).strapi;
  mocks.recordDelete.mockReset().mockResolvedValue(undefined);
  mocks.contexts.length = 0;
  mocks.claimAndRemove.mockReset().mockImplementation(async () => {
    mocks.contexts.push(deleteAuditContext());
    return "removed";
  });
});
afterEach(() => {
  (globalThis as { strapi?: unknown }).strapi = restore;
});

const install = (strapi: unknown) => {
  (globalThis as { strapi?: unknown }).strapi = strapi;
};

const AD = { id: 4, documentId: "ad4doc", title: "Bike", author: { id: 12 } };

describe("classified beforeDelete: the delete trail", () => {
  it("records one audit row per ad, with its documentId and title", async () => {
    const { strapi } = makeStrapi({
      ads: [AD, { id: 5, documentId: "ad5doc", title: "Desk" }],
      joinRows: [],
    });
    install(strapi);
    await lifecycles.beforeDelete({ params: { where: { id: 4 } }, state: {} });
    expect(mocks.recordDelete.mock.calls.map((call) => call[1])).toEqual([
      { kind: "classified", documentId: "ad4doc", title: "Bike", authorId: 12 },
      { kind: "classified", documentId: "ad5doc", title: "Desk", authorId: null },
    ]);
  });

  it("fails the delete when the audit insert fails (never swallowed)", async () => {
    const { strapi } = makeStrapi({ ads: [AD], joinRows: [] });
    install(strapi);
    mocks.recordDelete.mockRejectedValueOnce(new Error("audit insert failed"));
    await expect(
      lifecycles.beforeDelete({ params: { where: { id: 4 } }, state: {} }),
    ).rejects.toThrow("audit insert failed");
  });

  it("does nothing without a where clause", async () => {
    const { strapi } = makeStrapi({ ads: [AD], joinRows: [] });
    install(strapi);
    await lifecycles.beforeDelete({ params: {}, state: {} });
    expect(mocks.recordDelete).not.toHaveBeenCalled();
  });
});

describe("classified beforeDelete scan (FX45 — inside the delete's transaction)", () => {
  it("reads the ad's image ids through the ambient transaction", async () => {
    const { strapi, log } = makeStrapi({
      ads: [AD],
      joinRows: [image(10, 4), image(11, 4), image(12, 9)],
    });
    install(strapi);
    const event = { params: { where: { id: 4 } }, state: {} as Record<string, unknown> };
    await lifecycles.beforeDelete(event);
    expect(log).toEqual(["pluck:trx"]);
    expect(event.state.images).toEqual([
      { fileId: 10, adDocumentId: "ad4doc" },
      { fileId: 11, adDocumentId: "ad4doc" },
    ]);
  });

  it("fails open when the scan fails: the delete goes on, the janitor sweeps later", async () => {
    const { strapi } = makeStrapi({ ads: [AD], joinRows: [], scanFails: true });
    install(strapi);
    const event = { params: { where: { id: 4 } }, state: {} as Record<string, unknown> };
    await expect(lifecycles.beforeDelete(event)).resolves.toBeUndefined();
    expect(event.state.images).toBeUndefined();
    expect(mocks.recordDelete).toHaveBeenCalledOnce();
    expect(strapi.log.error).toHaveBeenCalledWith(expect.stringContaining("scan failed"));
  });
});

describe("classified afterDelete cleanup (K2 — after the commit, one locked removal)", () => {
  it("removes nothing inline; after the commit each image goes to claimAndRemove, linked to its ad", async () => {
    const { strapi, commit } = makeStrapi({ ads: [AD], joinRows: [image(10, 4), image(11, 4)] });
    install(strapi);
    const event = { params: { where: { id: 4 } }, state: {} as Record<string, unknown> };
    await lifecycles.beforeDelete(event);
    await lifecycles.afterDelete(event);
    expect(mocks.claimAndRemove).not.toHaveBeenCalled();
    await commit();
    expect(mocks.claimAndRemove.mock.calls.map((call) => call[1])).toEqual([10, 11]);
    expect(mocks.contexts).toEqual([
      { related: { uid: "api::classified.classified", documentId: "ad4doc" } },
      { related: { uid: "api::classified.classified", documentId: "ad4doc" } },
    ]);
    expect(strapi.log.info).toHaveBeenCalledWith(expect.stringContaining("removed 2 image(s)"));
  });

  it("no recorded images → nothing registered", async () => {
    const { strapi, commitCallbacks } = makeStrapi({ ads: [AD], joinRows: [] });
    install(strapi);
    await lifecycles.afterDelete({ state: {} });
    expect(commitCallbacks).toHaveLength(0);
  });
});

describe("classified writes lock their images (every source)", () => {
  it("locks the named image rows, ascending, before the write", async () => {
    const { strapi } = makeStrapi({ ads: [], joinRows: [] });
    install(strapi);
    mocks.lockAttachableFiles.mockReset().mockResolvedValue(true);
    await lifecycles.beforeCreate({ params: { data: { title: "Bike", images: [4, { id: 3 }] } } });
    await lifecycles.beforeUpdate({ params: { data: { images: { set: [{ id: 9 }] } } } });
    expect(mocks.lockAttachableFiles.mock.calls.map((call) => call[1])).toEqual([[3, 4], [9]]);
  });

  it("refuses a missing or tombstoned image with 400 images", async () => {
    const { strapi } = makeStrapi({ ads: [], joinRows: [] });
    install(strapi);
    mocks.lockAttachableFiles.mockReset().mockResolvedValue(false);
    await expect(
      lifecycles.beforeCreate({ params: { data: { images: [3] } } }),
    ).rejects.toMatchObject({ name: "ValidationError", details: { keys: ["images"] } });
  });

  it("does nothing for a write without images", async () => {
    mocks.lockAttachableFiles.mockReset();
    await lifecycles.beforeUpdate({ params: { data: { title: "x" } } });
    await lifecycles.beforeUpdate({ params: { data: { images: [] } } });
    expect(mocks.lockAttachableFiles).not.toHaveBeenCalled();
  });
});
