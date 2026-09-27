import { afterEach, describe, expect, it, vi } from "vitest";
import departmentLifecycles from "../api/department/content-types/department/lifecycles";
import { isPollTargeted } from "./poll-audience";
import {
  flagPollsOfDeletedDepartments,
  POLL_DEPARTMENT_DELETE_CHUNK,
  type PollDepartmentDeleteHost,
} from "./poll-department-delete";

/**
 * Department delete hook (decision 02, fail closed): before a department
 * row goes, every poll row linking it gets audience 'departments', so a
 * poll targeted only by its links (flag left at 'all') does not turn
 * company-wide when the delete cascades the links away.
 *
 * The db stub keeps a small department and poll table and evaluates the
 * `where` shapes the hook sends, so a wrong filter fails the tests.
 */

interface PollRow {
  id: number;
  audience: string | null;
  departments: number[];
}

type Where = Record<string, unknown>;

const inList = (cond: unknown, value: number): boolean =>
  ((cond as { $in?: number[] } | undefined)?.$in ?? []).includes(value);

function host(options: { departments: number[]; polls: PollRow[]; failOn?: "departments" | "polls" | "update" }) {
  const polls = options.polls.map((row) => ({ ...row, departments: [...row.departments] }));
  const departmentFindMany = vi.fn(async ({ where }: { where: Where }) => {
    if (options.failOn === "departments") throw new Error("connection reset");
    const id = where.id;
    return options.departments
      .filter((departmentId) => id === undefined || id === departmentId || inList(id, departmentId))
      .map((departmentId) => ({ id: departmentId }));
  });
  const pollFindMany = vi.fn(async ({ where }: { where: Where }) => {
    if (options.failOn === "polls") throw new Error("connection reset");
    const departmentIn = (where.departments as { id: unknown }).id;
    return polls
      .filter((row) => row.departments.some((departmentId) => inList(departmentIn, departmentId)))
      .map((row) => ({ id: row.id }));
  });
  const updateMany = vi.fn(async ({ where, data }: { where: Where; data: { audience: string } }) => {
    if (options.failOn === "update") throw new Error("deadlock detected");
    const flagIsNotDepartments = (row: PollRow) => row.audience === null || row.audience !== "departments";
    const hits = polls.filter((row) => inList(where.id, row.id) && flagIsNotDepartments(row));
    for (const row of hits) row.audience = data.audience;
    return { count: hits.length };
  });
  const log = { info: vi.fn() };
  const strapi: PollDepartmentDeleteHost = {
    db: {
      query: vi.fn((uid: string) =>
        uid === "api::department.department"
          ? { findMany: departmentFindMany, updateMany: vi.fn() }
          : { findMany: pollFindMany, updateMany },
      ),
    },
    log,
  };
  /** What ON DELETE CASCADE does to polls_departments_lnk afterwards. */
  const cascade = (departmentId: number) => {
    for (const row of polls) row.departments = row.departments.filter((id) => id !== departmentId);
  };
  return { strapi, polls, cascade, departmentFindMany, pollFindMany, updateMany, log };
}

const POLLS: PollRow[] = [
  // Admin-panel poll: departments set, Audience left at its default 'all'.
  { id: 10, audience: "all", departments: [1] },
  // Row from before the flag existed.
  { id: 11, audience: null, departments: [1, 2] },
  // Web-form poll: already flagged.
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

  it("sends the delete's where, selects the poll ids and updates only rows not yet flagged", async () => {
    const { strapi, departmentFindMany, pollFindMany, updateMany } = host({ departments: [1], polls: POLLS });
    await flagPollsOfDeletedDepartments(strapi, { id: 1 });
    expect(departmentFindMany).toHaveBeenCalledWith({ where: { id: 1 }, select: ["id"] });
    expect(pollFindMany).toHaveBeenCalledWith({
      where: { departments: { id: { $in: [1] } } },
      select: ["id"],
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: { $in: [10, 11, 12] },
        $or: [{ audience: { $null: true } }, { audience: { $ne: "departments" } }],
      },
      data: { audience: "departments" },
    });
  });

  it("treats a missing where as every department (an unfiltered deleteMany)", async () => {
    const { strapi, departmentFindMany, polls } = host({ departments: [1, 2], polls: POLLS });
    await expect(flagPollsOfDeletedDepartments(strapi, undefined)).resolves.toBe(3);
    expect(departmentFindMany).toHaveBeenCalledWith({ where: {}, select: ["id"] });
    expect(polls.find((row) => row.id === 13)?.audience).toBe("departments");
    expect(polls.find((row) => row.id === 14)?.audience).toBe("all");
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

  it("updates in bounded chunks", async () => {
    const many = Array.from({ length: POLL_DEPARTMENT_DELETE_CHUNK + 1 }, (_, i) => ({
      id: i + 1,
      audience: "all",
      departments: [1],
    }));
    const { strapi, updateMany } = host({ departments: [1], polls: many });
    await expect(flagPollsOfDeletedDepartments(strapi, { id: 1 })).resolves.toBe(POLL_DEPARTMENT_DELETE_CHUNK + 1);
    const sizes = updateMany.mock.calls.map(([params]) => (params.where.id as { $in: number[] }).$in.length);
    expect(sizes).toEqual([POLL_DEPARTMENT_DELETE_CHUNK, 1]);
  });

  it("lets a failure through, so the department is not deleted", async () => {
    for (const failOn of ["departments", "polls", "update"] as const) {
      const { strapi } = host({ departments: [1], polls: POLLS, failOn });
      await expect(flagPollsOfDeletedDepartments(strapi, { id: 1 }), failOn).rejects.toThrow();
    }
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
