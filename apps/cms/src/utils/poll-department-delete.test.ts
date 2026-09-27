import { afterEach, describe, expect, it, vi } from "vitest";
import departmentLifecycles from "../api/department/content-types/department/lifecycles";
import { isPollTargeted } from "./poll-audience";
import { POLL_AUDIENCE_GUARD_CHUNK } from "./poll-audience-guard";
import {
  flagPollsOfDeletedDepartments,
  POLL_DEPARTMENT_DELETE_PAGE,
  pollDepartmentLinkTable,
  type PollDepartmentDeleteHost,
} from "./poll-department-delete";

/**
 * Department delete hook (decision 02, fail closed; defence in depth next
 * to the write-time guard): before a department row goes, every poll row
 * linking it gets audience 'departments', so a poll targeted only by its
 * links (flag left at 'all', e.g. linked by a previous cms) does not turn
 * company-wide when the delete cascades the links away.
 *
 * The db stub keeps a department table, a poll table and the link table
 * (polls_departments_lnk, as the query engine registers it) and evaluates
 * the where/orderBy/limit shapes the hook sends, so a wrong filter or a
 * broken paging loop fails the tests.
 */

interface PollRow {
  id: number;
  audience: string | null;
  departments: number[];
}

interface LinkRow {
  id: number;
  poll_id: number;
  department_id: number;
}

type Where = Record<string, unknown>;

const LINK_UID = "polls_departments_lnk";

const METADATA = {
  attributes: {
    departments: {
      joinTable: {
        name: LINK_UID,
        joinColumn: { name: "poll_id" },
        inverseJoinColumn: { name: "department_id" },
      },
    },
  },
};

/** Evaluates the where shapes the hook sends on numeric id columns. */
function matches(where: Where, row: Record<string, number>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "$and") return (cond as Where[]).every((part) => matches(part, row));
    const value = row[key];
    if (typeof cond === "number") return value === cond;
    const ops = cond as { $in?: number[]; $gt?: number };
    if (ops.$in !== undefined && !ops.$in.includes(value)) return false;
    if (ops.$gt !== undefined && !(value > ops.$gt)) return false;
    return true;
  });
}

function page<T extends { id: number }>(rows: T[], params: { where: Where; limit?: number; orderBy?: unknown }) {
  expect(params.orderBy).toEqual({ id: "asc" });
  const hits = rows.filter((row) => matches(params.where, row as unknown as Record<string, number>));
  hits.sort((a, b) => a.id - b.id);
  return params.limit === undefined ? hits : hits.slice(0, params.limit);
}

function host(options: {
  departments: number[];
  polls: PollRow[];
  failOn?: "departments" | "links" | "update";
  metadata?: unknown;
}) {
  const polls = options.polls.map((row) => ({ ...row, departments: [...row.departments] }));
  const links = (): LinkRow[] => {
    const rows: LinkRow[] = [];
    let id = 1;
    for (const poll of polls) for (const departmentId of poll.departments) rows.push({ id: id++, poll_id: poll.id, department_id: departmentId });
    return rows;
  };
  const departmentFindMany = vi.fn(async (params: { where: Where; limit?: number; orderBy?: unknown }) => {
    if (options.failOn === "departments") throw new Error("connection reset");
    return page(options.departments.map((id) => ({ id })), params);
  });
  const linkFindMany = vi.fn(async (params: { where: Where; select: string[]; limit?: number; orderBy?: unknown }) => {
    if (options.failOn === "links") throw new Error("connection reset");
    expect(params.select).toEqual(["id", "poll_id"]);
    return page(links(), params).map((link) => ({ id: link.id, poll_id: link.poll_id }));
  });
  const updateMany = vi.fn(async ({ where, data }: { where: Where; data: { audience: string } }) => {
    if (options.failOn === "update") throw new Error("deadlock detected");
    const ids = (where.id as { $in: number[] }).$in;
    const flagIsNotDepartments = (row: PollRow) => row.audience === null || row.audience !== "departments";
    const hits = polls.filter((row) => ids.includes(row.id) && flagIsNotDepartments(row));
    for (const row of hits) row.audience = data.audience;
    return { count: hits.length };
  });
  const log = { info: vi.fn() };
  const strapi: PollDepartmentDeleteHost = {
    db: {
      query: vi.fn((uid: string) => {
        if (uid === "api::department.department") return { findMany: departmentFindMany, updateMany: vi.fn() };
        if (uid === LINK_UID) return { findMany: linkFindMany, updateMany: vi.fn() };
        return { findMany: vi.fn(), updateMany };
      }),
      metadata: {
        get: vi.fn((uid: string) =>
          uid === "api::poll.poll" ? (options.metadata ?? METADATA) : undefined,
        ),
      },
    },
    log,
  };
  /** What ON DELETE CASCADE does to polls_departments_lnk afterwards. */
  const cascade = (departmentId: number) => {
    for (const row of polls) row.departments = row.departments.filter((id) => id !== departmentId);
  };
  return { strapi, polls, cascade, departmentFindMany, linkFindMany, updateMany, log };
}

const POLLS: PollRow[] = [
  // Linked by a previous cms or raw SQL: departments set, Audience 'all'.
  { id: 10, audience: "all", departments: [1] },
  // Row from before the flag existed.
  { id: 11, audience: null, departments: [1, 2] },
  // Web-form or guarded poll: already flagged.
  { id: 12, audience: "departments", departments: [1] },
  // Another department's poll and a company-wide poll: untouched.
  { id: 13, audience: "all", departments: [2] },
  { id: 14, audience: "all", departments: [] },
];

describe("flagPollsOfDeletedDepartments", () => {
  it("keeps every poll of a deleted department restricted, and touches no other poll", async () => {
    const { strapi, polls, cascade, log } = host({ departments: [1, 2], polls: POLLS });
    await expect(flagPollsOfDeletedDepartments(strapi, { id: 1 })).resolves.toBe(2);
    cascade(1);
    expect(polls.map((row) => [row.id, row.audience])).toEqual([
      [10, "departments"],
      [11, "departments"],
      [12, "departments"],
      [13, "all"],
      [14, "all"],
    ]);
    const targeted = (row: PollRow) =>
      isPollTargeted({
        audience: row.audience,
        departments: row.departments.map((id) => ({ documentId: `d-${id}` })),
      });
    expect(polls.map((row) => [row.id, targeted(row)])).toEqual([
      [10, true],
      [11, true],
      [12, true],
      [13, true],
      [14, false],
    ]);
    expect(log.info).toHaveBeenCalledWith(
      "[poll-audience] department delete: set the audience of 2 poll row(s) to 'departments', so they stay restricted without the deleted department(s)",
    );
  });

  it("pages the delete's where, reads the link table by department, and updates only rows not yet flagged", async () => {
    const { strapi, departmentFindMany, linkFindMany, updateMany } = host({ departments: [1], polls: POLLS });
    await flagPollsOfDeletedDepartments(strapi, { id: 1 });
    expect(departmentFindMany).toHaveBeenCalledExactlyOnceWith({
      where: { $and: [{ id: 1 }, { id: { $gt: 0 } }] },
      select: ["id"],
      orderBy: { id: "asc" },
      limit: POLL_DEPARTMENT_DELETE_PAGE,
    });
    expect(linkFindMany).toHaveBeenCalledExactlyOnceWith({
      where: { department_id: { $in: [1] }, id: { $gt: 0 } },
      select: ["id", "poll_id"],
      orderBy: { id: "asc" },
      limit: POLL_DEPARTMENT_DELETE_PAGE,
    });
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        id: { $in: [10, 11, 12] },
        $or: [{ audience: { $null: true } }, { audience: { $ne: "departments" } }],
      },
      data: { audience: "departments" },
    });
  });

  it("treats a missing or empty where as every department (an unfiltered deleteMany)", async () => {
    for (const where of [undefined, null, {}]) {
      const { strapi, departmentFindMany, polls } = host({ departments: [1, 2], polls: POLLS });
      await expect(flagPollsOfDeletedDepartments(strapi, where), JSON.stringify(where)).resolves.toBe(3);
      expect(departmentFindMany.mock.calls[0]?.[0].where).toEqual({ id: { $gt: 0 } });
      expect(polls.find((row) => row.id === 13)?.audience).toBe("departments");
      expect(polls.find((row) => row.id === 14)?.audience).toBe("all");
    }
  });

  it("never puts more than one page of ids into an $in, and reaches every link past the first page", async () => {
    // 2 × PAGE + 1 departments, each linked by its own poll, plus one poll
    // linking a department of the last page: three department pages, and
    // the link table has more rows than a page for the first two.
    const count = 2 * POLL_DEPARTMENT_DELETE_PAGE + 1;
    const departments = Array.from({ length: count }, (_, i) => i + 1);
    const polls: PollRow[] = departments.map((id) => ({ id: 1000 + id, audience: "all", departments: [id] }));
    polls.push({ id: 5000, audience: null, departments: [count] });
    const { strapi, departmentFindMany, linkFindMany, updateMany } = host({ departments, polls });
    await expect(flagPollsOfDeletedDepartments(strapi, {})).resolves.toBe(count + 1);
    expect(departmentFindMany.mock.calls.map(([params]) => params.where)).toEqual([
      { id: { $gt: 0 } },
      { id: { $gt: POLL_DEPARTMENT_DELETE_PAGE } },
      { id: { $gt: 2 * POLL_DEPARTMENT_DELETE_PAGE } },
    ]);
    const departmentsPerLookup = linkFindMany.mock.calls.map(
      ([params]) => (params.where.department_id as { $in: number[] }).$in.length,
    );
    expect(Math.max(...departmentsPerLookup)).toBeLessThanOrEqual(POLL_DEPARTMENT_DELETE_PAGE);
    const idsPerUpdate = updateMany.mock.calls.map(([params]) => (params.where.id as { $in: number[] }).$in.length);
    expect(Math.max(...idsPerUpdate)).toBeLessThanOrEqual(POLL_AUDIENCE_GUARD_CHUNK);
  });

  it("pages the link table by link id within one department page", async () => {
    // One department linked by PAGE + 1 polls: two link pages.
    const polls: PollRow[] = Array.from({ length: POLL_DEPARTMENT_DELETE_PAGE + 1 }, (_, i) => ({
      id: i + 1,
      audience: "all",
      departments: [7],
    }));
    const { strapi, linkFindMany } = host({ departments: [7], polls });
    await expect(flagPollsOfDeletedDepartments(strapi, { id: 7 })).resolves.toBe(POLL_DEPARTMENT_DELETE_PAGE + 1);
    expect(linkFindMany.mock.calls.map(([params]) => params.where.id)).toEqual([
      { $gt: 0 },
      { $gt: POLL_DEPARTMENT_DELETE_PAGE },
    ]);
  });

  it("does nothing, and logs nothing, when no department or no poll matches", async () => {
    for (const setup of [
      { departments: [], polls: POLLS },
      { departments: [3], polls: POLLS },
    ]) {
      const { strapi, updateMany, log } = host(setup);
      await expect(flagPollsOfDeletedDepartments(strapi, { id: 3 })).resolves.toBe(0);
      expect(updateMany).not.toHaveBeenCalled();
      expect(log.info).not.toHaveBeenCalled();
    }
  });

  it("does not log when every linked poll was already flagged", async () => {
    const { strapi, updateMany, log } = host({ departments: [1], polls: [{ id: 12, audience: "departments", departments: [1] }] });
    await expect(flagPollsOfDeletedDepartments(strapi, { id: 1 })).resolves.toBe(0);
    expect(updateMany).toHaveBeenCalledOnce();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("lets a failure through, so the department is not deleted", async () => {
    for (const failOn of ["departments", "links", "update"] as const) {
      const { strapi } = host({ departments: [1], polls: POLLS, failOn });
      await expect(flagPollsOfDeletedDepartments(strapi, { id: 1 }), failOn).rejects.toThrow();
    }
  });

  it("refuses the delete when the link table is unknown (a Strapi upgrade renamed it)", async () => {
    for (const metadata of [{}, { attributes: { departments: {} } }, { attributes: { departments: { joinTable: { name: LINK_UID } } } }]) {
      const { strapi, departmentFindMany } = host({ departments: [1], polls: POLLS, metadata });
      await expect(flagPollsOfDeletedDepartments(strapi, { id: 1 })).rejects.toThrow(
        /^\[poll-audience\] the link table of poll\.departments is unknown/,
      );
      expect(departmentFindMany).not.toHaveBeenCalled();
    }
  });

  it("reads the link table and its columns from the poll's metadata", () => {
    const { strapi } = host({ departments: [], polls: [] });
    expect(pollDepartmentLinkTable(strapi)).toEqual({ uid: LINK_UID, pollColumn: "poll_id", departmentColumn: "department_id" });
  });
});

describe("department delete lifecycles", () => {
  const globals = globalThis as { strapi?: unknown };
  const previous = globals.strapi;
  afterEach(() => {
    globals.strapi = previous;
  });

  it("flag the polls before a delete and before a deleteMany, with the event's where", async () => {
    for (const hook of ["beforeDelete", "beforeDeleteMany"] as const) {
      const { strapi, polls } = host({ departments: [1, 2], polls: POLLS });
      globals.strapi = strapi;
      await departmentLifecycles[hook]({ params: { where: { id: { $in: [2] } } } });
      expect(
        polls.filter((row) => row.audience === "departments").map((row) => row.id),
        hook,
      ).toEqual([11, 12, 13]);
    }
  });
});
