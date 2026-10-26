import { describe, expect, it } from "vitest";

import { REPORT_ACKS_PER_ITEM, reportAckIndex, type ReportIndexHost } from "./ack-report-index";

/**
 * The report index (v0.31, #173): one user set per requested item, the
 * receipts read in id pages, and the budget of REPORT_ACKS_PER_ITEM scanned
 * rows per item with one row of lookahead. The stub db evaluates exactly
 * the where, order and limit the walk sends.
 */

type Receipt = {
  id: number;
  targetType: string;
  targetDocumentId: string;
  user: { id: number } | null;
};

function host(receipts: Receipt[]): ReportIndexHost & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    db: {
      query: () => ({
        async findMany(params: Record<string, unknown>) {
          calls.push(params);
          const where = params.where as {
            targetType: string;
            targetDocumentId: { $in: string[] };
            id: { $gt: number };
          };
          return receipts
            .filter(
              (row) =>
                row.targetType === where.targetType &&
                where.targetDocumentId.$in.includes(row.targetDocumentId) &&
                row.id > where.id.$gt,
            )
            .sort((a, b) => a.id - b.id)
            .slice(0, params.limit as number);
        },
      }),
    },
  };
}

const receipt = (id: number, doc: string, user: number | null, type = "announcement"): Receipt => ({
  id,
  targetType: type,
  targetDocumentId: doc,
  user: user === null ? null : { id: user },
});

describe("reportAckIndex", () => {
  it("answers every requested item, collapses duplicates and skips receipts without a user", async () => {
    const db = host([
      receipt(1, "a", 7),
      receipt(2, "a", 7),
      receipt(3, "a", 3),
      receipt(4, "b", null),
      receipt(5, "b", 9, "document"),
      receipt(6, "x", 1),
    ]);
    expect(await reportAckIndex(db, "announcement", ["a", "b", "c"])).toEqual({
      acks: { a: [3, 7], b: [], c: [] },
      truncated: false,
    });
  });

  it("reads nothing for no ids", async () => {
    const db = host([receipt(1, "a", 7)]);
    expect(await reportAckIndex(db, "announcement", [])).toEqual({ acks: {}, truncated: false });
    expect(db.calls).toEqual([]);
  });

  it("walks the pages by id, selecting the cursor", async () => {
    const rows = Array.from({ length: 2_500 }, (_, i) => receipt(i + 1, i % 2 ? "a" : "b", i + 1));
    const db = host(rows);
    const index = await reportAckIndex(db, "announcement", ["a", "b"]);
    expect(index.truncated).toBe(false);
    expect(index.acks.a).toHaveLength(1_250);
    expect(index.acks.b).toHaveLength(1_250);
    expect(db.calls.map((call) => (call.where as { id: { $gt: number } }).id.$gt)).toEqual([
      0, 1_000, 2_000,
    ]);
    expect(db.calls[0]).toMatchObject({
      select: ["id", "targetDocumentId"],
      orderBy: [{ id: "asc" }],
    });
  });

  it("is complete at exactly the budget and truncated one row past it", async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => receipt(i + 1, "a", i + 1));
    for (const [n, truncated, kept] of [
      [REPORT_ACKS_PER_ITEM - 1, false, REPORT_ACKS_PER_ITEM - 1],
      [REPORT_ACKS_PER_ITEM, false, REPORT_ACKS_PER_ITEM],
      [REPORT_ACKS_PER_ITEM + 1, true, REPORT_ACKS_PER_ITEM],
    ] as const) {
      const index = await reportAckIndex(host(rows(n)), "announcement", ["a"]);
      expect(index.truncated, String(n)).toBe(truncated);
      expect(index.acks.a, String(n)).toHaveLength(kept);
    }
  });

  it("counts duplicates against the budget before they collapse", async () => {
    const rows = Array.from({ length: REPORT_ACKS_PER_ITEM + 1 }, (_, i) => receipt(i + 1, "a", 7));
    expect(await reportAckIndex(host(rows), "announcement", ["a"])).toEqual({
      acks: { a: [7] },
      truncated: true,
    });
  });
});
