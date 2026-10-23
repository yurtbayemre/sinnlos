import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The duties loader (v0.18): the people of the shifts are looked up in
 * chunks of at most 100 ids (Strapi parses at most 100 entries of one `$in`
 * list), so every name arrives however many people the plans name. An id
 * the directory does not list after a complete answer is a former person
 * (v0.28: /api/users hides blocked and anonymised people); after a failed
 * read it stays unknown.
 */
const state = vi.hoisted(() => ({
  queries: [] as string[],
  hidden: new Set<number>(),
  fail: false,
}));

vi.mock("@/lib/strapi", () => ({
  api: {
    dutyPlans: {
      list: async () => ({
        truncated: false,
        data: [
          {
            id: 1,
            documentId: "plan1",
            name: "Schlüsseldienst",
            shifts: Array.from({ length: 150 }, (_, i) => ({
              userId: i + 1,
              startsAt: "2026-10-20T04:00:00.000Z",
              endsAt: "2026-10-20T12:00:00.000Z",
            })),
          },
        ],
      }),
    },
  },
}));
vi.mock("@/lib/users", () => ({
  fetchAllUsers: async (query: string) => {
    state.queries.push(query);
    if (state.fail) throw new Error("cms down");
    const ids = [...query.matchAll(/filters\[id\]\[\$in\]\[\d+\]=(\d+)/g)].map((m) => Number(m[1]));
    return {
      truncated: false,
      users: ids.filter((id) => !state.hidden.has(id)).map((id) => ({ id, displayName: `P${id}` })),
    };
  },
}));

const { loadDuties } = await import("./duties");

beforeEach(() => {
  state.queries = [];
  state.hidden = new Set();
  state.fail = false;
});

describe("loadDuties", () => {
  it("looks the people up in chunks of at most 100 ids and knows every name", async () => {
    const view = await loadDuties();
    expect(state.queries).toHaveLength(2);
    for (const query of state.queries) {
      expect([...query.matchAll(/\$in\]\[\d+\]/g)].length).toBeLessThanOrEqual(100);
    }
    expect(Object.keys(view.people)).toHaveLength(150);
    expect(view.people[150]).toEqual({ name: "P150", phone: null });
  });

  it("marks an id the complete directory answer leaves out as a former person", async () => {
    state.hidden = new Set([7]);
    const view = await loadDuties();
    expect(view.people[7]).toEqual({ name: null, phone: null, former: true });
    expect(view.plans[0]!.shifts.some((shift) => shift.userId === 7)).toBe(true);
  });

  it("leaves every name unknown, never former, when the directory read fails", async () => {
    state.fail = true;
    const view = await loadDuties();
    expect(view.people).toEqual({});
  });
});
