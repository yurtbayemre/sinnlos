import { describe, expect, it } from "vitest";
import type { DepartmentListItem, TeamListItem } from "@/lib/api/org";
import { buildDepartmentChart, buildOrgTree, type OrgNode } from "./org-tree";

/**
 * The org chart tree (FX49): every person exactly once, self-managers and
 * manager cycles as marked extra roots, iterative so a deep chain cannot
 * overflow the stack.
 */
type P = { id: number; name: string; manager?: { id: number } | null };

const p = (id: number, managerId?: number | null): P => ({
  id,
  name: `p${id}`,
  manager: managerId === undefined ? undefined : managerId === null ? null : { id: managerId },
});

/** "id(issue)[children]" for compact assertions, depth first. */
function shape(nodes: OrgNode<P>[]): string {
  return nodes
    .map((n) => {
      const issue = n.issue ? `(${n.issue})` : "";
      const children = n.children.length > 0 ? `[${shape(n.children)}]` : "";
      return `${n.person.id}${issue}${children}`;
    })
    .join(",");
}

/** Every person in the tree, iteratively. */
function allIds(nodes: OrgNode<P>[]): number[] {
  const ids: number[] = [];
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    ids.push(node.person.id);
    stack.push(...node.children);
  }
  return ids.sort((a, b) => a - b);
}

describe("buildOrgTree", () => {
  it("builds a proper tree in input order; a manager outside the list makes a plain root", () => {
    const tree = buildOrgTree([p(1), p(2, 1), p(3, 1), p(4, 2), p(5, 99)]);
    expect(shape(tree.roots)).toBe("1[2[4],3],5");
    expect(tree.issues).toBe(0);
  });

  it("puts a self-manager at the top with a warning, keeping their reports", () => {
    const tree = buildOrgTree([p(1), p(2, 2), p(3, 2)]);
    expect(shape(tree.roots)).toBe("1,2(self-manager)[3]");
    expect(tree.issues).toBe(1);
  });

  it("breaks a two-person cycle at the first of them, with everyone below it", () => {
    // 2 and 3 manage each other; 4 reports to 3. Before, all three vanished.
    const tree = buildOrgTree([p(1), p(2, 3), p(3, 2), p(4, 3)]);
    expect(shape(tree.roots)).toBe("1,2(cycle)[3[4]]");
    expect(tree.issues).toBe(1);
  });

  it("breaks a longer cycle and a tail that leads into it", () => {
    // 5 → 6 → 7 → 5 and 8 → 6; the input order makes 6 the first member.
    const tree = buildOrgTree([p(6, 7), p(8, 6), p(7, 5), p(5, 6)]);
    expect(shape(tree.roots)).toBe("6(cycle)[8,5[7]]");
    expect(tree.issues).toBe(1);
    expect(allIds(tree.roots)).toEqual([5, 6, 7, 8]);
  });

  it("marks each of several cycles and self-managers, after the regular roots", () => {
    const tree = buildOrgTree([p(1, 2), p(2, 1), p(3, 3), p(4), p(5, 6), p(6, 5)]);
    expect(shape(tree.roots)).toBe("4,1(cycle)[2],3(self-manager),5(cycle)[6]");
    expect(tree.issues).toBe(3);
  });

  it("walks a deep chain without recursion", () => {
    const depth = 50_000;
    const people = Array.from({ length: depth }, (_, i) => p(i + 1, i === 0 ? null : i));
    const tree = buildOrgTree(people);
    expect(tree.roots).toHaveLength(1);
    expect(tree.issues).toBe(0);
    let node = tree.roots[0]!;
    let levels = 1;
    while (node.children.length > 0) {
      node = node.children[0]!;
      levels++;
    }
    expect(levels).toBe(depth);
    expect(node.person.id).toBe(depth);
  });

  it("closes a deep chain into a cycle without recursion", () => {
    const depth = 50_000;
    const people = Array.from({ length: depth }, (_, i) => p(i + 1, i === 0 ? depth : i));
    const tree = buildOrgTree(people);
    expect(tree.issues).toBe(1);
    expect(tree.roots.map((r) => [r.person.id, r.issue])).toEqual([[1, "cycle"]]);
    expect(allIds(tree.roots)).toHaveLength(depth);
  });

  it("lists everyone exactly once; a repeated id counts once (first entry wins)", () => {
    const first = p(2, 1);
    const tree = buildOrgTree([p(1), first, { ...p(2, 3), name: "dup" }, p(3, 2)]);
    expect(allIds(tree.roots)).toEqual([1, 2, 3]);
    expect(shape(tree.roots)).toBe("1[2[3]]");
    expect(tree.roots[0]!.children[0]!.person).toBe(first);
  });

  it("returns nothing for nobody", () => {
    expect(buildOrgTree([])).toEqual({ roots: [], issues: 0 });
  });
});

/**
 * The department view's chart (v1.1): department → head → teams → lead →
 * member count, from the department and the team list. A team is never lost.
 */
const dept = (id: number, over: Partial<DepartmentListItem> = {}): DepartmentListItem =>
  ({ id, name: `d${id}`, slug: `d${id}`, ...over }) as DepartmentListItem;
const team = (id: number, departmentId: number | null, over: Partial<TeamListItem> = {}) =>
  ({
    id,
    name: `t${id}`,
    slug: `t${id}`,
    department: departmentId === null ? null : { id: departmentId },
    ...over,
  }) as TeamListItem;
const ada = { id: 7, displayName: "Ada" };

describe("buildDepartmentChart", () => {
  it("returns nothing for nothing", () => {
    expect(buildDepartmentChart([], [])).toEqual({ departments: [], unassigned: [] });
  });

  it("keeps a department without a head and without teams", () => {
    const chart = buildDepartmentChart([dept(1)], []);
    expect(chart.departments).toEqual([{ id: 1, name: "d1", slug: "d1", head: null, teams: [] }]);
    expect(chart.unassigned).toEqual([]);
  });

  it("puts the head on its department and groups each team under its own", () => {
    const chart = buildDepartmentChart(
      [dept(1, { head: ada }), dept(2)],
      [team(10, 2), team(11, 1), team(12, 2)],
    );
    expect(
      chart.departments.map((d) => [d.id, d.head?.id ?? null, d.teams.map((t) => t.id)]),
    ).toEqual([
      [1, 7, [11]],
      [2, null, [10, 12]],
    ]);
  });

  it("shows a team without a lead and counts its members (none, or a missing roster)", () => {
    const chart = buildDepartmentChart(
      [dept(1)],
      [
        team(10, 1, { lead: ada, members: [ada, { id: 8, displayName: "Bob" }] }),
        team(11, 1, { members: [] }),
        team(12, 1),
      ],
    );
    expect(
      chart.departments[0]!.teams.map((t) => [t.id, t.lead?.id ?? null, t.memberCount]),
    ).toEqual([
      [10, 7, 2],
      [11, null, 0],
      [12, null, 0],
    ]);
  });

  it("lists a team without a department, or with one that was not loaded, as unassigned", () => {
    const chart = buildDepartmentChart([dept(1)], [team(10, null), team(11, 99), team(12, 1)]);
    expect(chart.unassigned.map((t) => t.id)).toEqual([10, 11]);
    expect(chart.departments[0]!.teams.map((t) => t.id)).toEqual([12]);
  });

  it("lists a team id that comes twice (a page walk repeating a boundary row) once, first entry wins", () => {
    const chart = buildDepartmentChart(
      [dept(1)],
      [
        team(10, 1, { name: "first" }),
        team(11, 1),
        team(10, 1, { name: "again" }),
        team(12, null),
        team(12, null),
      ],
    );
    expect(chart.departments[0]!.teams.map((t) => [t.id, t.name])).toEqual([
      [10, "first"],
      [11, "t11"],
    ]);
    expect(chart.unassigned.map((t) => t.id)).toEqual([12]);
  });

  it("keeps the order of the lists it is given", () => {
    const chart = buildDepartmentChart([dept(3), dept(1), dept(2)], []);
    expect(chart.departments.map((d) => d.id)).toEqual([3, 1, 2]);
  });
});
