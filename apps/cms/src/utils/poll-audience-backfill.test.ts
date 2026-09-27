import { describe, expect, it, vi } from "vitest";
import {
  backfillPollAudience,
  POLL_AUDIENCE_BACKFILL_CHUNK,
  type PollAudienceBackfillHost,
} from "./poll-audience-backfill";

/**
 * Boot backfill of the poll audience flag (decision 02): rows with a NULL
 * flag get 'departments' when they link a department and 'all' otherwise,
 * both rows of a document alike (per row), except that a NULL row without
 * links whose other row of the same poll already says 'departments' gets
 * 'departments' too (a republish or discard on a previous cms); nothing
 * happens once no row is NULL. Everything runs in one transaction, and any
 * error rolls it back and fails the boot (Codex review, findings 3 and 4).
 * The NULL rows are read in pages by an id cursor, all of them before the
 * first lookup or update (Codex review, P2; the query engine side is in
 * poll-audience-backfill-sqlite.test.ts).
 */

/**
 * One page of the NULL-row read as the query engine answers it: rows after
 * the `id.$gt` cursor, by id, at most `limit` (all of them without one).
 */
function nullRowPage<T extends { id: number }>(rows: T[], params: Record<string, unknown>): T[] {
  const after = (params.where as { id?: { $gt?: number } }).id?.$gt ?? 0;
  const page = rows.filter((row) => row.id > after).sort((a, b) => a.id - b.id);
  return typeof params.limit === "number" ? page.slice(0, params.limit) : page;
}

/** The params of the backfill's page reads (the calls with `$null`). */
const pageReads = (calls: [Record<string, unknown>][]) =>
  calls
    .map(([params]) => params)
    .filter((params) => typeof (params.where as { audience?: unknown }).audience === "object");

interface Row {
  id: number;
  documentId?: string;
  departments?: { id: number }[] | null;
}

/** A row whose flag is already set (the stub's non-NULL side of the table). */
interface FlaggedRow {
  id: number;
  documentId: string;
  audience: string;
}

function host(
  rows: Row[],
  options: { failOn?: "findMany" | "updateMany"; flagged?: FlaggedRow[] } = {},
) {
  const findMany = vi.fn(async (params: Record<string, unknown>) => {
    if (options.failOn === "findMany") throw new Error("relation polls_departments_lnk does not exist");
    const where = params.where as { audience?: unknown; documentId?: { $in?: string[] } };
    if (typeof where.audience === "string") {
      const documentIds = where.documentId?.$in ?? [];
      return (options.flagged ?? [])
        .filter((row) => row.audience === where.audience && documentIds.includes(row.documentId))
        .map((row) => ({ documentId: row.documentId }));
    }
    return nullRowPage(rows, params) as unknown[];
  });
  const updateMany = vi.fn(async (params: Record<string, unknown>) => {
    if (options.failOn === "updateMany") throw new Error("deadlock detected");
    const ids = ((params.where as { id: { $in: number[] } }).id.$in ?? []) as number[];
    return { count: ids.length };
  });
  const log = { info: vi.fn(), warn: vi.fn() };
  const transaction = vi.fn((callback: () => Promise<unknown>) => callback());
  const strapi: PollAudienceBackfillHost = {
    db: {
      query: vi.fn(() => ({ findMany, updateMany })),
      transaction: <T>(callback: () => Promise<T>) => transaction(callback) as Promise<T>,
    },
    log,
  };
  return { strapi, findMany, updateMany, log, transaction };
}

describe("backfillPollAudience", () => {
  it("reads only rows whose flag is NULL, with their department links, one bounded page at a time", async () => {
    const { strapi, findMany } = host([]);
    await backfillPollAudience(strapi);
    expect(strapi.db.query).toHaveBeenCalledWith("api::poll.poll");
    expect(findMany).toHaveBeenCalledWith({
      where: { audience: { $null: true }, id: { $gt: 0 } },
      select: ["id", "documentId"],
      orderBy: { id: "asc" },
      limit: POLL_AUDIENCE_BACKFILL_CHUNK,
      populate: { departments: { select: ["id"] } },
    });
  });

  it("reads every page before the first sibling lookup or update", async () => {
    // Codex P2: the department populate binds the ids of every row a read
    // returned, so one read of all NULL rows broke the bind limit. Two full
    // pages and a short one; the sibling case sits in the last page.
    const rows: Row[] = Array.from({ length: 2 * POLL_AUDIENCE_BACKFILL_CHUNK + 1 }, (_, i) => ({
      id: i + 1,
      documentId: `d${i}`,
      departments: i % 100 === 1 ? [{ id: 2 }] : [],
    }));
    rows[rows.length - 1].documentId = "p-republished";
    const { strapi, findMany, updateMany, log } = host(rows, {
      flagged: [{ id: 9001, documentId: "p-republished", audience: "departments" }],
    });
    await backfillPollAudience(strapi);

    const reads = pageReads(findMany.mock.calls);
    expect(reads.map((params) => [(params.where as { id: { $gt: number } }).id.$gt, params.limit])).toEqual([
      [0, POLL_AUDIENCE_BACKFILL_CHUNK],
      [POLL_AUDIENCE_BACKFILL_CHUNK, POLL_AUDIENCE_BACKFILL_CHUNK],
      [2 * POLL_AUDIENCE_BACKFILL_CHUNK, POLL_AUDIENCE_BACKFILL_CHUNK],
    ]);
    // The three page reads come first, then the sibling lookups, then the updates.
    const order = findMany.mock.invocationCallOrder;
    expect(order.length).toBeGreaterThan(reads.length);
    expect(pageReads(findMany.mock.calls.slice(reads.length))).toEqual([]);
    expect(Math.min(...updateMany.mock.invocationCallOrder)).toBeGreaterThan(Math.max(...order));
    expect(log.info).toHaveBeenCalledWith(
      "[poll-audience] set the audience of 401 existing poll row(s): 4 to 'departments' (they link a department), " +
        "1 to 'departments' (the other row of their poll is restricted), 396 to 'all'",
    );
  });

  it("stops with a [poll-audience] error instead of looping when a full page does not advance", async () => {
    const rows = Array.from({ length: POLL_AUDIENCE_BACKFILL_CHUNK }, (_, i) => ({ id: i + 1, departments: [] }));
    const { strapi, findMany, updateMany } = host(rows);
    // A read that ignores the cursor returns the same full page forever.
    findMany.mockImplementation(async () => rows);
    await expect(backfillPollAudience(strapi)).rejects.toThrow(
      /^\[poll-audience\] could not backfill .*did not advance past id 200\); nothing was changed/,
    );
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("keeps a flag-only restricted poll restricted when a previous cms republished or discarded it", async () => {
    const { strapi, findMany, updateMany, log } = host(
      [
        // Republished on a cms without the flag: a new published row, no links.
        { id: 21, documentId: "p-republished", departments: [] },
        // "Discard changes" there: a new draft row, no links.
        { id: 22, documentId: "p-discarded", departments: [] },
        // A poll the previous cms created: both rows NULL, nothing to inherit.
        { id: 23, documentId: "p-new", departments: [] },
        { id: 24, documentId: "p-new", departments: [] },
        // Its other row says 'all': stays company-wide.
        { id: 25, documentId: "p-open", departments: [] },
      ],
      {
        flagged: [
          { id: 9, documentId: "p-republished", audience: "departments" },
          { id: 12, documentId: "p-discarded", audience: "departments" },
          { id: 13, documentId: "p-open", audience: "all" },
        ],
      },
    );
    await backfillPollAudience(strapi);
    expect(findMany).toHaveBeenCalledWith({
      where: { documentId: { $in: ["p-republished", "p-discarded", "p-new", "p-open"] }, audience: "departments" },
      select: ["documentId"],
    });
    expect(updateMany.mock.calls.map(([params]) => params)).toEqual([
      { where: { id: { $in: [21, 22] }, audience: { $null: true } }, data: { audience: "departments" } },
      { where: { id: { $in: [23, 24, 25] }, audience: { $null: true } }, data: { audience: "all" } },
    ]);
    expect(log.info).toHaveBeenCalledWith(
      "[poll-audience] set the audience of 5 existing poll row(s): 0 to 'departments' (they link a department), " +
        "2 to 'departments' (the other row of their poll is restricted), 3 to 'all'",
    );
  });

  it("decides a row with links by its links alone, and asks about siblings only for rows without", async () => {
    const { strapi, findMany, updateMany } = host([
      { id: 30, documentId: "p-a", departments: [{ id: 2 }] },
      { id: 31, documentId: "p-a", departments: [] },
    ]);
    await backfillPollAudience(strapi);
    // The first-boot case (every row NULL): the draft that dropped its
    // departments is not pulled along by the published row flagged in the
    // same run.
    expect(findMany).toHaveBeenLastCalledWith({
      where: { documentId: { $in: ["p-a"] }, audience: "departments" },
      select: ["documentId"],
    });
    expect(updateMany.mock.calls.map(([params]) => params)).toEqual([
      { where: { id: { $in: [30] }, audience: { $null: true } }, data: { audience: "departments" } },
      { where: { id: { $in: [31] }, audience: { $null: true } }, data: { audience: "all" } },
    ]);
  });

  it("sets 'departments' on rows with links and 'all' on the rest, draft and published rows alike", async () => {
    const { strapi, updateMany, log } = host([
      // A targeted document: draft row 10, published row 11, both linked.
      { id: 10, departments: [{ id: 2 }] },
      { id: 11, departments: [{ id: 2 }, { id: 3 }] },
      // A company-wide document, and a legacy row without a populate key.
      { id: 20, departments: [] },
      { id: 21 },
      { id: 22, departments: null },
    ]);
    await backfillPollAudience(strapi);
    expect(updateMany.mock.calls.map(([params]) => params)).toEqual([
      { where: { id: { $in: [10, 11] }, audience: { $null: true } }, data: { audience: "departments" } },
      { where: { id: { $in: [20, 21, 22] }, audience: { $null: true } }, data: { audience: "all" } },
    ]);
    expect(log.info).toHaveBeenCalledWith(
      "[poll-audience] set the audience of 5 existing poll row(s): 2 to 'departments' (they link a department), 3 to 'all'",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("does nothing, and logs nothing, once no row is NULL", async () => {
    const { strapi, updateMany, log } = host([]);
    await backfillPollAudience(strapi);
    expect(updateMany).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("skips an update whose id list is empty", async () => {
    const { strapi, updateMany } = host([{ id: 1, departments: [] }]);
    await backfillPollAudience(strapi);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({ data: { audience: "all" } });
  });

  it("updates in bounded chunks", async () => {
    const rows = Array.from({ length: POLL_AUDIENCE_BACKFILL_CHUNK + 1 }, (_, i) => ({ id: i + 1, departments: [] }));
    const { strapi, updateMany } = host(rows);
    await backfillPollAudience(strapi);
    expect(updateMany).toHaveBeenCalledTimes(2);
    const sizes = updateMany.mock.calls.map(
      ([params]) => (params.where as { id: { $in: number[] } }).id.$in.length,
    );
    expect(sizes).toEqual([POLL_AUDIENCE_BACKFILL_CHUNK, 1]);
  });

  it("runs the whole backfill in one transaction", async () => {
    const { strapi, transaction, findMany, updateMany } = host([{ id: 1, departments: [] }]);
    await backfillPollAudience(strapi);
    expect(transaction).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalled();
  });

  it("fails the boot with a [poll-audience] error instead of logging on", async () => {
    for (const failOn of ["findMany", "updateMany"] as const) {
      const { strapi, log } = host([{ id: 1, departments: [{ id: 2 }] }], { failOn });
      await expect(backfillPollAudience(strapi), failOn).rejects.toThrow(
        /^\[poll-audience\] could not backfill the audience of existing polls \((relation polls_departments_lnk does not exist|deadlock detected)\); nothing was changed/,
      );
      expect(log.info, failOn).not.toHaveBeenCalled();
      expect(log.warn, failOn).not.toHaveBeenCalled();
    }
  });
});

/**
 * Atomicity against a stateful table: the stub evaluates the where shapes
 * the backfill sends and runs `transaction` like @strapi/database (the
 * callback's writes are undone when it throws).
 */
describe("backfillPollAudience: atomic and fail closed", () => {
  interface TableRow {
    id: number;
    documentId: string;
    published: boolean;
    audience: string | null;
    departments: number[];
  }

  const INITIAL: TableRow[] = [
    // First-boot case of finding 4: the draft links a department, the
    // published row does not (a saved, unpublished change).
    { id: 1, documentId: "p-a", published: false, audience: null, departments: [2] },
    { id: 2, documentId: "p-a", published: true, audience: null, departments: [] },
    // Republished on a previous cms: the draft still says 'departments'.
    { id: 3, documentId: "p-b", published: false, audience: "departments", departments: [] },
    { id: 4, documentId: "p-b", published: true, audience: null, departments: [] },
    // Plain company-wide and targeted polls from before the flag.
    { id: 5, documentId: "p-c", published: false, audience: null, departments: [] },
    { id: 6, documentId: "p-c", published: true, audience: null, departments: [] },
    { id: 7, documentId: "p-d", published: false, audience: null, departments: [3] },
    { id: 8, documentId: "p-d", published: true, audience: null, departments: [3] },
  ];

  const copy = (rows: TableRow[]) => rows.map((row) => ({ ...row, departments: [...row.departments] }));

  function tableHost(initial: TableRow[], fail: { updateCall?: number; findManyCall?: number } = {}) {
    let table = copy(initial);
    let updates = 0;
    let finds = 0;
    const query = {
      findMany: vi.fn(async ({ where, limit }: { where: Record<string, unknown>; limit?: number }) => {
        finds += 1;
        if (finds === fail.findManyCall) throw new Error("canceling statement due to lock timeout");
        if (where.audience === "departments") {
          const documentIds = (where.documentId as { $in: string[] }).$in;
          return table
            .filter((row) => row.audience === "departments" && documentIds.includes(row.documentId))
            .map((row) => ({ documentId: row.documentId }));
        }
        return nullRowPage(
          table.filter((row) => row.audience === null),
          { where, limit },
        ).map((row) => ({ id: row.id, documentId: row.documentId, departments: row.departments.map((id) => ({ id })) }));
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: { audience: string } }) => {
        updates += 1;
        if (updates === fail.updateCall) throw new Error("deadlock detected");
        const ids = (where.id as { $in: number[] }).$in;
        const hits = table.filter((row) => ids.includes(row.id) && row.audience === null);
        for (const row of hits) row.audience = data.audience;
        return { count: hits.length };
      }),
    };
    const transaction = async <T>(callback: () => Promise<T>): Promise<T> => {
      const snapshot = copy(table);
      try {
        return await callback();
      } catch (error) {
        table = snapshot;
        throw error;
      }
    };
    const log = { info: vi.fn() };
    const strapi: PollAudienceBackfillHost = { db: { query: () => query, transaction }, log };
    return { strapi, table: () => table, log };
  }

  const flags = (rows: TableRow[]) => rows.map((row) => [row.id, row.audience]);

  const CLEAN_RUN = [
    [1, "departments"],
    [2, "all"],
    [3, "departments"],
    [4, "departments"],
    [5, "all"],
    [6, "all"],
    [7, "departments"],
    [8, "departments"],
  ];

  it("a clean first run classifies per row, the sibling rule applying only to rows flagged before the run", async () => {
    const { strapi, table } = tableHost(INITIAL);
    await backfillPollAudience(strapi);
    expect(flags(table())).toEqual(CLEAN_RUN);
  });

  it("an injected failure changes nothing and throws, at every step", async () => {
    // findMany calls: 1 the NULL rows, 2 the sibling lookup; updateMany
    // calls: 1 'departments' by links, 2 by sibling, 3 'all'.
    for (const fail of [{ findManyCall: 1 }, { findManyCall: 2 }, { updateCall: 1 }, { updateCall: 2 }, { updateCall: 3 }]) {
      const label = JSON.stringify(fail);
      const { strapi, table, log } = tableHost(INITIAL, fail);
      await expect(backfillPollAudience(strapi), label).rejects.toThrow(
        /^\[poll-audience\] could not backfill .*nothing was changed .*the cms does not start/,
      );
      expect(table(), label).toEqual(INITIAL);
      expect(log.info, label).not.toHaveBeenCalled();
    }
  });

  it("a retry after a failure classifies exactly like a clean first run", async () => {
    // Finding 4: before, a run that flagged the draft of p-a and then failed
    // left it flagged; the retry took it as a restricted sibling and gave
    // the published row of p-a 'departments' instead of 'all'.
    const { strapi, table } = tableHost(INITIAL, { updateCall: 3 });
    await expect(backfillPollAudience(strapi)).rejects.toThrow(/^\[poll-audience\]/);
    const retry = tableHost(table());
    await backfillPollAudience(retry.strapi);
    expect(flags(retry.table())).toEqual(CLEAN_RUN);
    expect(retry.log.info).toHaveBeenCalledWith(
      "[poll-audience] set the audience of 7 existing poll row(s): 3 to 'departments' (they link a department), " +
        "1 to 'departments' (the other row of their poll is restricted), 3 to 'all'",
    );
  });

  it("paging keeps the classification of one read when the rows of a poll are pages apart", async () => {
    // The INITIAL rows with two pages of filler in between: every draft row
    // is read in the first page, every published row two pages later.
    // Flagging page by page would, among others, make the linked draft of
    // p-a a restricted sibling of its unlinked published row.
    const gap = 2 * POLL_AUDIENCE_BACKFILL_CHUNK;
    const shifted = (id: number) =>
      INITIAL.find((row) => row.id === id)?.published ? id + INITIAL.length + gap : id;
    const initial: TableRow[] = [
      ...INITIAL.map((row) => ({ ...row, id: shifted(row.id) })),
      ...Array.from({ length: gap }, (_, i) => ({
        id: INITIAL.length + 1 + i,
        documentId: `f${i}`,
        published: false,
        audience: null,
        departments: [],
      })),
    ].sort((a, b) => a.id - b.id);
    const { strapi, table } = tableHost(initial);
    await backfillPollAudience(strapi);
    const audienceOf = new Map(table().map((row) => [row.id, row.audience]));
    expect(CLEAN_RUN.map(([id]) => [id, audienceOf.get(shifted(Number(id)))])).toEqual(CLEAN_RUN);
    expect(table().filter((row) => row.documentId.startsWith("f")).every((row) => row.audience === "all")).toBe(true);
  });
});
