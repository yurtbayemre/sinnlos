import { describe, expect, it } from "vitest";

import { loadReceipts, RECEIPT_PAGE } from "./training-roster";

interface Receipt {
  id: number;
  targetDocumentId: string;
  completedAt: string | null;
  user: { id: number } | null;
}

type Where = {
  user: { id: { $in: number[] } };
  targetDocumentId: { $in: string[] };
  id: { $gt: number };
};

/**
 * A stub of db.query("lesson-progress").findMany that honours exactly what
 * loadReceipts may rely on: the user/lesson filter, the `id > cursor`
 * filter, ascending id order and the limit. Every call is recorded.
 */
function stub(receipts: Receipt[]) {
  const calls: { afterId: number; limit: unknown; returned: number }[] = [];
  const strapi = {
    db: {
      query: () => ({
        findMany: async ({
          where,
          orderBy,
          limit,
        }: {
          where: Where;
          orderBy: unknown;
          limit?: number;
        }) => {
          expect(orderBy).toEqual([{ id: "asc" }]);
          const found = receipts
            .filter(
              (row) =>
                (row.user === null || where.user.id.$in.includes(row.user.id)) &&
                where.targetDocumentId.$in.includes(row.targetDocumentId) &&
                row.id > where.id.$gt,
            )
            .sort((a, b) => a.id - b.id)
            .slice(0, limit ?? Infinity);
          calls.push({ afterId: where.id.$gt, limit, returned: found.length });
          return found;
        },
      }),
    },
  };
  return { strapi: strapi as unknown as Parameters<typeof loadReceipts>[0], calls };
}

const receipt = (id: number, userId: number | null): Receipt => ({
  id,
  targetDocumentId: "lesson-a",
  completedAt: `2026-01-01T00:00:${String(id % 60).padStart(2, "0")}.000Z`,
  user: userId === null ? null : { id: userId },
});

describe("loadReceipts (v0.32, #176: the result pages by id)", () => {
  it("reads every receipt in pages of RECEIPT_PAGE, ascending, with the cursor after each page", async () => {
    const all = Array.from({ length: 2 * RECEIPT_PAGE + 3 }, (_, i) => receipt(i + 1, 1 + (i % 7)));
    const { strapi, calls } = stub(all);
    const out = await loadReceipts(strapi, [1, 2, 3, 4, 5, 6, 7], ["lesson-a"]);
    expect(out).toHaveLength(all.length);
    expect(calls.map((call) => call.limit)).toEqual([RECEIPT_PAGE, RECEIPT_PAGE, RECEIPT_PAGE]);
    expect(calls.map((call) => call.afterId)).toEqual([0, RECEIPT_PAGE, 2 * RECEIPT_PAGE]);
    expect(new Set(out.map((row) => row.completedAt)).size).toBeGreaterThan(1);
  });

  it("asks once more after a full last page and stops at the empty one", async () => {
    const all = Array.from({ length: RECEIPT_PAGE }, (_, i) => receipt(i + 1, 1));
    const { strapi, calls } = stub(all);
    expect(await loadReceipts(strapi, [1], ["lesson-a"])).toHaveLength(RECEIPT_PAGE);
    expect(calls.map((call) => [call.afterId, call.returned])).toEqual([
      [0, RECEIPT_PAGE],
      [RECEIPT_PAGE, 0],
    ]);
  });

  it("moves the cursor past a row without a user that ends a page", async () => {
    const all = Array.from({ length: RECEIPT_PAGE + 2 }, (_, i) =>
      receipt(i + 1, i + 1 === RECEIPT_PAGE ? null : 1),
    );
    const { strapi, calls } = stub(all);
    const out = await loadReceipts(strapi, [1], ["lesson-a"]);
    expect(out).toHaveLength(RECEIPT_PAGE + 1);
    expect(calls.map((call) => call.afterId)).toEqual([0, RECEIPT_PAGE]);
  });
});
