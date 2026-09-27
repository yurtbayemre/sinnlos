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
 * happens once no row is NULL; an error is logged, never thrown into the
 * boot.
 */

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
    return rows as unknown[];
  });
  const updateMany = vi.fn(async (params: Record<string, unknown>) => {
    if (options.failOn === "updateMany") throw new Error("deadlock detected");
    const ids = ((params.where as { id: { $in: number[] } }).id.$in ?? []) as number[];
    return { count: ids.length };
  });
  const log = { info: vi.fn(), warn: vi.fn() };
  const strapi: PollAudienceBackfillHost = {
    db: { query: vi.fn(() => ({ findMany, updateMany })) },
    log,
  };
  return { strapi, findMany, updateMany, log };
}

describe("backfillPollAudience", () => {
  it("reads only rows whose flag is NULL, with their department links", async () => {
    const { strapi, findMany } = host([]);
    await backfillPollAudience(strapi);
    expect(strapi.db.query).toHaveBeenCalledWith("api::poll.poll");
    expect(findMany).toHaveBeenCalledWith({
      where: { audience: { $null: true } },
      select: ["id", "documentId"],
      populate: { departments: { select: ["id"] } },
    });
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

  it("logs a failure instead of failing the boot", async () => {
    for (const failOn of ["findMany", "updateMany"] as const) {
      const { strapi, log } = host([{ id: 1, departments: [{ id: 2 }] }], { failOn });
      await expect(backfillPollAudience(strapi), failOn).resolves.toBeUndefined();
      expect(log.warn, failOn).toHaveBeenCalledWith(expect.stringContaining("[poll-audience] could not backfill"));
      expect(log.info, failOn).not.toHaveBeenCalled();
    }
  });
});
