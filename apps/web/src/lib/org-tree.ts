/**
 * The org chart's tree (FX49; moved out of components/people/org-tree.tsx).
 * Pure and iterative, so a long reporting chain cannot overflow the stack.
 *
 * Manager data comes from the admin panel and is not validated as a tree:
 *   - a person who is their own manager used to become their own child, and
 *     the recursive render never ended;
 *   - in a manager cycle (A → B → A, or longer) nobody was a root, so the
 *     whole cycle and everyone below it vanished from the chart.
 * Now every person appears exactly once. A self-manager is a root marked
 * "self-manager"; a cycle is broken at its member that comes first in the
 * input order (the org chart query sorts by name), which becomes a root
 * marked "cycle" with the rest of the cycle below it. Marked roots follow
 * the regular roots, so the page can show them with a warning. A manager
 * outside the list (not loaded, or blocked) makes a regular root, as before.
 */

export type OrgIssue = "self-manager" | "cycle";

export interface OrgNode<P> {
  person: P;
  children: OrgNode<P>[];
  /** Why this person is a root although a manager is set; null otherwise. */
  issue: OrgIssue | null;
}

export interface OrgTree<P> {
  /** Regular roots first, then the marked ones, each in input order. */
  roots: OrgNode<P>[];
  /** How many roots are marked (0: the data is a proper tree). */
  issues: number;
}

export function buildOrgTree<P extends { id: number; manager?: { id: number } | null }>(
  people: readonly P[],
): OrgTree<P> {
  // First occurrence wins: an id listed twice is one person.
  const nodes = new Map<number, OrgNode<P>>();
  const order = new Map<number, number>();
  for (const person of people) {
    if (nodes.has(person.id)) continue;
    order.set(person.id, order.size);
    nodes.set(person.id, { person, children: [], issue: null });
  }

  const parent = new Map<number, number | null>();
  for (const [id, node] of nodes) {
    const managerId = node.person.manager?.id ?? null;
    if (managerId === id) {
      node.issue = "self-manager";
      parent.set(id, null);
    } else {
      parent.set(id, managerId !== null && nodes.has(managerId) ? managerId : null);
    }
  }

  // Walk up from every person; meeting the current walk again means a
  // cycle. Each person is walked once (state 2 = done), so this is linear.
  const state = new Map<number, 1 | 2>();
  for (const start of nodes.keys()) {
    if (state.has(start)) continue;
    const path: number[] = [];
    let current: number | null = start;
    while (current !== null && !state.has(current)) {
      state.set(current, 1);
      path.push(current);
      current = parent.get(current) ?? null;
    }
    if (current !== null && state.get(current) === 1) {
      const cycle = path.slice(path.indexOf(current));
      const breaker = cycle.reduce((a, b) => ((order.get(a) ?? 0) <= (order.get(b) ?? 0) ? a : b));
      parent.set(breaker, null);
      nodes.get(breaker)!.issue = "cycle";
    }
    for (const id of path) state.set(id, 2);
  }

  const roots: OrgNode<P>[] = [];
  const marked: OrgNode<P>[] = [];
  for (const [id, node] of nodes) {
    const managerId = parent.get(id) ?? null;
    if (managerId !== null) nodes.get(managerId)!.children.push(node);
    else if (node.issue) marked.push(node);
    else roots.push(node);
  }
  return { roots: [...roots, ...marked], issues: marked.length };
}
