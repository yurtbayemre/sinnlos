import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The duties loader (v0.18): the people of the shifts are looked up in
 * chunks of at most 100 ids (Strapi parses at most 100 entries of one `$in`
 * list), so every name arrives however many people the plans name.
 */
const state = vi.hoisted(() => ({ queries: [] as string[] }));

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
    const ids = [...query.matchAll(/filters\[id\]\[\$in\]\[\d+\]=(\d+)/g)].map((m) => Number(m[1]));
    return { truncated: false, users: ids.map((id) => ({ id, displayName: `P${id}` })) };
  },
}));

const { loadDuties } = await import("./duties");

beforeEach(() => {
  state.queries = [];
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
});
