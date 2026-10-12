import { describe, expect, it, vi } from "vitest";
import {
  backfillDepartmentAudience,
  type DepartmentAudienceBackfillHost,
} from "./department-audience-backfill";
import { DEPARTMENT_DELETE_PAGE } from "./department-delete-restrict";

/**
 * Boot backfill of the document and quick-link audience flag (FX29
 * residual, batch 12 review B12-01): every row that links a department
 * gets 'departments', raise only, both types in one transaction that
 * stops the boot when it fails. The same flag on the real query engine and
 * both databases: integration/department-delete.integration.test.ts.
 *
 * The stub keeps both content tables and their link tables (as the query
 * engine registers them), evaluates the where/orderBy/limit shapes the
 * backfill sends, and runs one transaction that restores the tables when
 * its callback throws.
 */

type Where = Record<string, unknown>;

interface ContentRow {
  id: number;
  audience: string | null;
  departments: number[];
}

const DOCUMENT = "api::document.document";
const QUICK_LINK = "api::quick-link.quick-link";

const LINKS: Record<string, { table: string; column: string }> = {
  [DOCUMENT]: { table: "documents_departments_lnk", column: "document_id" },
  [QUICK_LINK]: { table: "quick_links_departments_lnk", column: "quick_link_id" },
};

const metadataOf = (uid: string) => ({
  attributes: {
    departments: {
      joinTable: {
        name: LINKS[uid].table,
        joinColumn: { name: LINKS[uid].column },
        inverseJoinColumn: { name: "department_id" },
      },
    },
  },
});

/** The where shapes the backfill sends: `id` ($gt, $in) and the flag ($or of $null/$ne). */
function matches(where: Where, row: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "$or") return (cond as Where[]).some((part) => matches(part, row));
    const value = row[key];
    const ops = cond as { $in?: unknown[]; $gt?: number; $null?: boolean; $ne?: unknown };
    if (ops.$in !== undefined && !ops.$in.includes(value)) return false;
    if (ops.$gt !== undefined && !((value as number) > ops.$gt)) return false;
    if (ops.$null === true && value !== null) return false;
    // SQL: `<> 'x'` never matches NULL.
    if (ops.$ne !== undefined && (value === null || value === ops.$ne)) return false;
    return true;
  });
}

function host(
  initial: Partial<Record<string, ContentRow[]>>,
  options: { failUpdateOf?: string; metadata?: (uid: string) => unknown } = {},
) {
  const clone = (rows: Record<string, ContentRow[]>) =>
    Object.fromEntries(
      Object.entries(rows).map(([uid, list]) => [
        uid,
        list.map((row) => ({ ...row, departments: [...row.departments] })),
      ]),
    );
  let tables: Record<string, ContentRow[]> = clone({
    [DOCUMENT]: initial[DOCUMENT] ?? [],
    [QUICK_LINK]: initial[QUICK_LINK] ?? [],
  });
  const linkRows = (uid: string) => {
    const rows: Array<Record<string, number>> = [];
    let id = 1;
    for (const row of tables[uid])
      for (const departmentId of row.departments)
        rows.push({ id: id++, [LINKS[uid].column]: row.id, department_id: departmentId });
    return rows;
  };
  const linkReads: Array<{ table: string; where: Where; limit?: number }> = [];
  const updates: Array<{ uid: string; ids: number[] }> = [];
  const log = { info: vi.fn() };

  const query = vi.fn((uid: string) => {
    const owner = Object.keys(LINKS).find((key) => LINKS[key].table === uid);
    if (owner) {
      return {
        findMany: vi.fn(
          async (params: { where: Where; select: string[]; limit?: number; orderBy?: unknown }) => {
            expect(params.select).toEqual(["id", LINKS[owner].column]);
            expect(params.orderBy).toEqual({ id: "asc" });
            linkReads.push({ table: uid, where: params.where, limit: params.limit });
            const hits = linkRows(owner).filter((link) => matches(params.where, link));
            return params.limit === undefined ? hits : hits.slice(0, params.limit);
          },
        ),
        updateMany: vi.fn(),
      };
    }
    return {
      findMany: vi.fn(),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: { audience: string } }) => {
        if (options.failUpdateOf === uid) throw new Error("deadlock detected");
        const ids = (where.id as { $in: number[] }).$in;
        updates.push({ uid, ids });
        const hits = tables[uid].filter((row) => matches(where, row as unknown as Where));
        for (const row of hits) row.audience = data.audience;
        return { count: hits.length };
      }),
    };
  });
  const transaction = vi.fn(async (callback: () => Promise<unknown>) => {
    const snapshot = clone(tables);
    try {
      return await callback();
    } catch (error) {
      tables = snapshot;
      throw error;
    }
  });
  const strapi: DepartmentAudienceBackfillHost = {
    db: {
      query,
      transaction: <T>(callback: () => Promise<T>) => transaction(callback) as Promise<T>,
      metadata: { get: options.metadata ?? metadataOf },
    },
    log,
  };
  const audiences = (uid: string) => tables[uid].map((row) => [row.id, row.audience]);
  return { strapi, log, transaction, linkReads, updates, audiences };
}

describe("backfillDepartmentAudience", () => {
  it("flags every row that links a department, of both types, and nothing else", async () => {
    const { strapi, log, transaction, audiences } = host({
      [DOCUMENT]: [
        // A document's draft and published row, NULL from the first boot.
        { id: 1, audience: null, departments: [7] },
        { id: 2, audience: null, departments: [7, 8] },
        // Written before the guard: Audience 'all' with a department.
        { id: 3, audience: "all", departments: [8] },
        // Company-wide rows stay as they are.
        { id: 4, audience: null, departments: [] },
        { id: 5, audience: "all", departments: [] },
        // Left without departments by a department delete: stays restricted.
        { id: 6, audience: "departments", departments: [] },
      ],
      [QUICK_LINK]: [
        { id: 1, audience: null, departments: [8] },
        { id: 2, audience: "departments", departments: [8] },
        { id: 3, audience: null, departments: [] },
      ],
    });
    await backfillDepartmentAudience(strapi);
    expect(audiences(DOCUMENT)).toEqual([
      [1, "departments"],
      [2, "departments"],
      [3, "departments"],
      [4, null],
      [5, "all"],
      [6, "departments"],
    ]);
    expect(audiences(QUICK_LINK)).toEqual([
      [1, "departments"],
      [2, "departments"],
      [3, null],
    ]);
    expect(transaction).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledExactlyOnceWith(
      "[department-audience] set the audience of 3 existing document row(s) and " +
        "1 existing quick-link row(s) to 'departments' (they link a department)",
    );
  });

  it("writes only rows that are not flagged yet, and logs nothing when nothing changed", async () => {
    const { strapi, log, updates, linkReads } = host({
      [DOCUMENT]: [{ id: 1, audience: "departments", departments: [7] }],
      [QUICK_LINK]: [{ id: 1, audience: null, departments: [] }],
    });
    await backfillDepartmentAudience(strapi);
    // Every link of every department: no department filter.
    expect(linkReads).toEqual([
      {
        table: "documents_departments_lnk",
        where: { id: { $gt: 0 } },
        limit: DEPARTMENT_DELETE_PAGE,
      },
      {
        table: "quick_links_departments_lnk",
        where: { id: { $gt: 0 } },
        limit: DEPARTMENT_DELETE_PAGE,
      },
    ]);
    expect(updates).toEqual([{ uid: DOCUMENT, ids: [1] }]);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("reads the link table in pages and binds at most a page of ids per statement", async () => {
    const rows = Array.from({ length: DEPARTMENT_DELETE_PAGE + 3 }, (_, i) => ({
      id: i + 1,
      audience: null,
      departments: [7],
    }));
    const { strapi, linkReads, updates, audiences } = host({ [DOCUMENT]: rows });
    await backfillDepartmentAudience(strapi);
    expect(linkReads.filter((read) => read.table === "documents_departments_lnk")).toHaveLength(2);
    expect(updates.map((update) => update.ids.length)).toEqual([DEPARTMENT_DELETE_PAGE, 3]);
    expect(new Set(audiences(DOCUMENT).map(([, audience]) => audience))).toEqual(
      new Set(["departments"]),
    );
  });

  it("rolls everything back and stops the boot when a write fails", async () => {
    const { strapi, log, audiences } = host(
      {
        [DOCUMENT]: [{ id: 1, audience: null, departments: [7] }],
        [QUICK_LINK]: [{ id: 1, audience: null, departments: [7] }],
      },
      { failUpdateOf: QUICK_LINK },
    );
    await expect(backfillDepartmentAudience(strapi)).rejects.toThrow(
      /^\[department-audience\] could not backfill the audience of documents and quick links \(deadlock detected\); nothing was changed .*the cms does not start/,
    );
    // The document written before the failure is rolled back too.
    expect(audiences(DOCUMENT)).toEqual([[1, null]]);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("refuses to start when a link table is unknown, before any write", async () => {
    const { strapi, updates, linkReads } = host(
      { [DOCUMENT]: [{ id: 1, audience: null, departments: [7] }] },
      { metadata: (uid) => (uid === QUICK_LINK ? { attributes: {} } : metadataOf(uid)) },
    );
    await expect(backfillDepartmentAudience(strapi)).rejects.toThrow(
      "the link table of api::quick-link.quick-link.departments is unknown; " +
        "the backfill cannot find the rows that link a department",
    );
    expect(linkReads).toEqual([]);
    expect(updates).toEqual([]);
  });
});
