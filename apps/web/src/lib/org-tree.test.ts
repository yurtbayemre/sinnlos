import { describe, expect, it } from "vitest";
import { buildOrgTree, type OrgNode } from "./org-tree";

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
