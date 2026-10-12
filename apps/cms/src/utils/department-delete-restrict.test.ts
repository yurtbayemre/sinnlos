import { afterEach, describe, expect, it, vi } from "vitest";
import departmentLifecycles from "../api/department/content-types/department/lifecycles";
import {
  DEPARTMENT_DELETE_PAGE,
  DEPARTMENT_SCOPED_TYPES,
  departmentLinkTable,
  restrictRowsOfDeletedDepartments,
  type DepartmentDeleteHost,
} from "./department-delete-restrict";

/**
 * FX29 residual (owner answer 2026-09-29 (b), RESTRICT): before a
 * department row is deleted, every document and quick-link row linking it
 * gets audience 'departments', so a row targeted only by that department
 * does not turn company-wide when the delete cascades its link rows away.
 * The read side (departmentScopedIds) is pinned in policy-factories.test.ts
 * and the two visibility policies' suites; the whole chain over HTTP in
 * integration/department-delete.integration.test.ts.
 *
 * The db stub keeps a department table, the two content tables and their
 * link tables (as the query engine registers them) and evaluates the
 * where/orderBy/limit shapes the hook sends, so a wrong filter or a broken
 * paging loop fails the tests. `events` records the department locks and
 * the link reads in order (on Postgres the lock must come first).
 */

type Where = Record<string, unknown>;

interface ContentRow {
  id: number;
  audience: string | null;
  departments: number[];
}

const DOCUMENT = "api::document.document";
const QUICK_LINK = "api::quick-link.quick-link";
const POLL = "api::poll.poll";

const LINKS: Record<string, { table: string; column: string }> = {
  [DOCUMENT]: { table: "documents_departments_lnk", column: "document_id" },
  [QUICK_LINK]: { table: "quick_links_departments_lnk", column: "quick_link_id" },
  [POLL]: { table: "polls_departments_lnk", column: "poll_id" },
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

/** Evaluates the where shapes the hook sends on numeric id columns and the audience flag. */
function matches(where: Where, row: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "$and") return (cond as Where[]).every((part) => matches(part, row));
    if (key === "$or") return (cond as Where[]).some((part) => matches(part, row));
    const value = row[key];
    if (typeof cond === "number") return value === cond;
    const ops = cond as { $in?: unknown[]; $gt?: number; $null?: boolean; $ne?: unknown };
    if (ops.$in !== undefined && !ops.$in.includes(value)) return false;
    if (ops.$gt !== undefined && !((value as number) > ops.$gt)) return false;
    if (ops.$null === true && value !== null) return false;
    // SQL: `<> 'x'` never matches NULL.
    if (ops.$ne !== undefined && (value === null || value === ops.$ne)) return false;
    return true;
  });
}

function page<T extends { id: number }>(
  rows: T[],
  params: { where: Where; limit?: number; orderBy?: unknown },
) {
  expect(params.orderBy).toEqual({ id: "asc" });
  const hits = rows.filter((row) => matches(params.where, row as unknown as Where));
  hits.sort((a, b) => a.id - b.id);
  return params.limit === undefined ? hits : hits.slice(0, params.limit);
}

function host(options: {
  departments: number[];
  rows: Partial<Record<string, ContentRow[]>>;
  failOn?: "departments" | "links" | "update" | "lock";
  metadata?: (uid: string) => unknown;
  /** strapi.db.dialect.client (default sqlite). */
  dialect?: string;
}) {
  const tables: Record<string, ContentRow[]> = {};
  for (const uid of [DOCUMENT, QUICK_LINK, POLL]) {
    tables[uid] = (options.rows[uid] ?? []).map((row) => ({
      ...row,
      departments: [...row.departments],
    }));
  }
  const linkRows = (uid: string) => {
    const rows: Array<{ id: number } & Record<string, number>> = [];
    let id = 1;
    for (const row of tables[uid])
      for (const departmentId of row.departments)
        rows.push({ id: id++, [LINKS[uid].column]: row.id, department_id: departmentId });
    return rows;
  };
  const updates: Array<{ uid: string; ids: number[] }> = [];
  const events: string[] = [];
  const query = vi.fn((uid: string) => {
    if (uid === "api::department.department") {
      return {
        findMany: vi.fn(async (params: { where: Where; limit?: number; orderBy?: unknown }) => {
          if (options.failOn === "departments") throw new Error("connection reset");
          return page(
            options.departments.map((id) => ({ id })),
            params,
          );
        }),
        updateMany: vi.fn(),
      };
    }
    const owner = Object.keys(LINKS).find((key) => LINKS[key].table === uid);
    if (owner) {
      return {
        findMany: vi.fn(
          async (params: { where: Where; select: string[]; limit?: number; orderBy?: unknown }) => {
            if (options.failOn === "links") throw new Error("connection reset");
            expect(params.select).toEqual(["id", LINKS[owner].column]);
            const departmentIds = (params.where.department_id as { $in: number[] }).$in;
            events.push(
              `read ${uid} ${departmentIds[0]}..${departmentIds[departmentIds.length - 1]}`,
            );
            return page(linkRows(owner), params).map((link) => ({
              id: link.id,
              [LINKS[owner].column]: link[LINKS[owner].column],
            }));
          },
        ),
        updateMany: vi.fn(),
      };
    }
    return {
      findMany: vi.fn(),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: { audience: string } }) => {
        if (options.failOn === "update") throw new Error("deadlock detected");
        const ids = (where.id as { $in: number[] }).$in;
        expect(ids.length).toBeLessThanOrEqual(DEPARTMENT_DELETE_PAGE);
        updates.push({ uid, ids });
        const hits = tables[uid].filter((row) => matches(where, row as unknown as Where));
        for (const row of hits) row.audience = data.audience;
        return { count: hits.length };
      }),
    };
  });
  /** The query builder slice the Postgres lock uses; records what it locked. */
  const queryBuilder = vi.fn((uid: string) => {
    const state: { select?: string[]; where?: Where; forUpdate: boolean } = { forUpdate: false };
    const builder = {
      select(columns: string[]) {
        state.select = columns;
        return builder;
      },
      where(where: Where) {
        state.where = where;
        return builder;
      },
      forUpdate() {
        state.forUpdate = true;
        return builder;
      },
      async execute() {
        if (options.failOn === "lock") throw new Error("deadlock detected");
        expect(uid).toBe("api::department.department");
        expect(state.select).toEqual(["id"]);
        expect(state.forUpdate).toBe(true);
        const ids = (state.where?.id as { $in: number[] }).$in;
        expect(ids.length).toBeLessThanOrEqual(DEPARTMENT_DELETE_PAGE);
        events.push(`lock ${ids[0]}..${ids[ids.length - 1]}`);
        return ids.map((id) => ({ id }));
      },
    };
    return builder;
  });
  const log = { info: vi.fn() };
  const strapi: DepartmentDeleteHost = {
    db: {
      query,
      queryBuilder,
      dialect: { client: options.dialect ?? "sqlite" },
      metadata: {
        get: vi.fn((uid: string) =>
          options.metadata ? options.metadata(uid) : LINKS[uid] ? metadataOf(uid) : undefined,
        ),
      },
    },
    log,
  };
  const flagged = (uid: string) =>
    tables[uid].filter((row) => row.audience === "departments").map((row) => row.id);
  return { strapi, tables, flagged, updates, log, query, queryBuilder, events };
}

/** Rows 1/2 (draft/published) Eng only, 3 Eng+Sales, 4 Sales, 5 none, 6 flagged already. */
const ROWS: ContentRow[] = [
  { id: 1, audience: null, departments: [1] },
  { id: 2, audience: "all", departments: [1] },
  { id: 3, audience: "all", departments: [1, 2] },
  { id: 4, audience: null, departments: [2] },
  { id: 5, audience: "all", departments: [] },
  { id: 6, audience: "departments", departments: [1] },
];

describe("departmentLinkTable", () => {
  it("reads the join table of <uid>.departments from the metadata", () => {
    const { strapi } = host({ departments: [], rows: {} });
    expect(departmentLinkTable(strapi, DOCUMENT)).toEqual({
      uid: "documents_departments_lnk",
      rowColumn: "document_id",
      departmentColumn: "department_id",
    });
  });

  it("fails closed without one", () => {
    for (const metadata of [undefined, {}, { attributes: { departments: {} } }]) {
      const { strapi } = host({ departments: [], rows: {}, metadata: () => metadata });
      expect(() => departmentLinkTable(strapi, DOCUMENT)).toThrow(
        /link table of api::document\.document\.departments is unknown/,
      );
    }
  });
});

describe("restrictRowsOfDeletedDepartments (FX29 residual)", () => {
  it("flags the draft and published rows linking the deleted department, in both types", async () => {
    const { strapi, flagged } = host({
      departments: [1, 2],
      rows: { [DOCUMENT]: ROWS, [QUICK_LINK]: ROWS },
    });
    const changed = await restrictRowsOfDeletedDepartments(strapi, { id: 1 });
    // 6 was flagged already, 4 and 5 do not link Engineering.
    expect(changed).toEqual({ [DOCUMENT]: 3, [QUICK_LINK]: 3 });
    expect(flagged(DOCUMENT)).toEqual([1, 2, 3, 6]);
    expect(flagged(QUICK_LINK)).toEqual([1, 2, 3, 6]);
  });

  it("covers the types DEPARTMENT_SCOPED_TYPES names, and nothing else", async () => {
    expect(DEPARTMENT_SCOPED_TYPES.map((type) => type.uid)).toEqual([DOCUMENT, QUICK_LINK]);
    const { strapi, flagged } = host({
      departments: [1],
      rows: { [POLL]: [{ id: 1, audience: "all", departments: [1] }] },
    });
    await restrictRowsOfDeletedDepartments(strapi, { id: 1 });
    expect(flagged(POLL)).toEqual([]);
  });

  it("takes the delete's where, and every department without one", async () => {
    const run = async (where: Where | null | undefined) => {
      const { strapi, flagged } = host({ departments: [1, 2], rows: { [DOCUMENT]: ROWS } });
      await restrictRowsOfDeletedDepartments(strapi, where);
      return flagged(DOCUMENT);
    };
    await expect(run({ id: { $in: [2] } })).resolves.toEqual([3, 4, 6]);
    await expect(run({ id: 99 })).resolves.toEqual([6]);
    for (const where of [null, undefined, {}]) {
      await expect(run(where), JSON.stringify(where)).resolves.toEqual([1, 2, 3, 4, 6]);
    }
  });

  it("never touches a row without departments or one linking only a surviving department", async () => {
    const { strapi, tables } = host({ departments: [1, 2], rows: { [DOCUMENT]: ROWS } });
    await restrictRowsOfDeletedDepartments(strapi, { id: 1 });
    expect(tables[DOCUMENT].find((row) => row.id === 4)?.audience).toBeNull();
    expect(tables[DOCUMENT].find((row) => row.id === 5)?.audience).toBe("all");
  });

  it("pages departments and link rows, never binding more than one page per $in", async () => {
    const many = Array.from({ length: DEPARTMENT_DELETE_PAGE * 2 + 3 }, (_, i) => i + 1);
    const rows: ContentRow[] = many.map((id) => ({ id, audience: null, departments: [id] }));
    // One more row linking every department: more link rows than a page.
    rows.push({ id: 100_000, audience: "all", departments: many });
    const { strapi, flagged, updates } = host({ departments: many, rows: { [DOCUMENT]: rows } });
    const changed = await restrictRowsOfDeletedDepartments(strapi, null);
    expect(changed[DOCUMENT]).toBe(rows.length);
    expect(flagged(DOCUMENT)).toHaveLength(rows.length);
    for (const update of updates) {
      expect(update.ids.length).toBeLessThanOrEqual(DEPARTMENT_DELETE_PAGE);
    }
  });

  it("logs what it flagged, and stays silent when nothing changed", async () => {
    const { strapi, log } = host({
      departments: [1],
      rows: { [DOCUMENT]: ROWS, [QUICK_LINK]: [ROWS[0]] },
    });
    await restrictRowsOfDeletedDepartments(strapi, { id: 1 });
    expect(log.info).toHaveBeenCalledOnce();
    expect(log.info.mock.calls[0][0]).toBe(
      "[department-delete] set the audience of 3 document row(s) and 1 quick-link row(s) " +
        "to 'departments': they stay restricted (admins and editors only) until re-targeted",
    );
    log.info.mockClear();
    await restrictRowsOfDeletedDepartments(strapi, { id: 1 });
    expect(log.info).not.toHaveBeenCalled();
  });

  it("propagates every failure (the delete fails, its rows stay restricted by their links)", async () => {
    for (const failOn of ["departments", "links", "update", "lock"] as const) {
      const { strapi } = host({
        departments: [1],
        rows: { [DOCUMENT]: ROWS },
        failOn,
        dialect: "postgres",
      });
      await expect(restrictRowsOfDeletedDepartments(strapi, { id: 1 }), failOn).rejects.toThrow();
    }
  });

  it("on Postgres locks each page of departments before reading its links", async () => {
    // A link committed after an unlocked scan would be cascaded away
    // without the flag (Read Committed); the FOR UPDATE lock conflicts with
    // the FOR KEY SHARE lock of a link insert's foreign key check.
    const many = Array.from({ length: DEPARTMENT_DELETE_PAGE + 2 }, (_, i) => i + 1);
    const { strapi, events, flagged } = host({
      departments: many,
      rows: { [DOCUMENT]: ROWS, [QUICK_LINK]: ROWS },
      dialect: "postgres",
    });
    await restrictRowsOfDeletedDepartments(strapi, null);
    const last = DEPARTMENT_DELETE_PAGE;
    expect(events).toEqual([
      `lock 1..${last}`,
      `read documents_departments_lnk 1..${last}`,
      `read quick_links_departments_lnk 1..${last}`,
      `lock ${last + 1}..${last + 2}`,
      `read documents_departments_lnk ${last + 1}..${last + 2}`,
      `read quick_links_departments_lnk ${last + 1}..${last + 2}`,
    ]);
    expect(flagged(DOCUMENT)).toEqual([1, 2, 3, 4, 6]);
  });

  it("locks only the departments the delete matches, and nothing on SQLite", async () => {
    const postgres = host({ departments: [1, 2], rows: { [DOCUMENT]: ROWS }, dialect: "postgres" });
    await restrictRowsOfDeletedDepartments(postgres.strapi, { id: 2 });
    expect(postgres.events[0]).toBe("lock 2..2");
    expect(postgres.queryBuilder).toHaveBeenCalledOnce();

    const none = host({ departments: [1, 2], rows: { [DOCUMENT]: ROWS }, dialect: "postgres" });
    await restrictRowsOfDeletedDepartments(none.strapi, { id: 99 });
    expect(none.queryBuilder).not.toHaveBeenCalled();

    const sqlite = host({ departments: [1, 2], rows: { [DOCUMENT]: ROWS } });
    await restrictRowsOfDeletedDepartments(sqlite.strapi, { id: 2 });
    expect(sqlite.queryBuilder).not.toHaveBeenCalled();
    expect(sqlite.events).toEqual([
      "read documents_departments_lnk 2..2",
      "read quick_links_departments_lnk 2..2",
    ]);
    expect(sqlite.flagged(DOCUMENT)).toEqual(postgres.flagged(DOCUMENT));
  });

  it("refuses before any write when a type's link table is unknown", async () => {
    const { strapi, updates, queryBuilder } = host({
      departments: [1],
      rows: { [DOCUMENT]: ROWS },
      metadata: (uid) => (uid === QUICK_LINK ? undefined : metadataOf(uid)),
      dialect: "postgres",
    });
    await expect(restrictRowsOfDeletedDepartments(strapi, { id: 1 })).rejects.toThrow(
      /quick-link\.quick-link\.departments is unknown/,
    );
    expect(updates).toEqual([]);
    expect(queryBuilder).not.toHaveBeenCalled();
  });
});

describe("department delete lifecycles", () => {
  const globals = globalThis as { strapi?: unknown };
  const previous = globals.strapi;
  afterEach(() => {
    globals.strapi = previous;
  });

  it("restrict polls, documents and quick links before a delete and a deleteMany", async () => {
    for (const hook of ["beforeDelete", "beforeDeleteMany"] as const) {
      const { strapi, flagged } = host({
        departments: [1, 2],
        rows: { [DOCUMENT]: ROWS, [QUICK_LINK]: ROWS, [POLL]: ROWS },
      });
      globals.strapi = strapi;
      await departmentLifecycles[hook]({ params: { where: { id: { $in: [2] } } } });
      expect(flagged(DOCUMENT), hook).toEqual([3, 4, 6]);
      expect(flagged(QUICK_LINK), hook).toEqual([3, 4, 6]);
      expect(flagged(POLL), hook).toEqual([3, 4, 6]);
    }
  });
});
