import { describe, expect, it, vi } from "vitest";

import { assertFreeDepartmentName, DEPARTMENT_NAMES_LOCK_UID } from "./department-names";

const { lockDocument } = vi.hoisted(() => ({ lockDocument: vi.fn(async () => 1) }));
vi.mock("./document-lock", () => ({ lockDocument }));

type Row = Record<string, unknown>;
const ROWS = [
  { id: 1, name: "Sales" },
  { id: 2, name: "Ärztlicher Dienst" },
];

/** A host whose count($eqi) answers like Postgres (dbClash) and findMany filters ids. */
function host(dbClash = false, inTransaction = true) {
  return {
    db: {
      inTransaction: () => inTransaction,
      query: () => ({
        findMany: async ({ where }: Row) => {
          const notIn = ((where as Row)?.id as Row | undefined)?.$notIn as number[] | undefined;
          const id = (where as Row)?.id;
          if (typeof id === "number") return ROWS.filter((row) => row.id === id);
          return ROWS.filter((row) => !notIn?.includes(row.id));
        },
        count: async () => (dbClash ? 1 : 0),
      }),
    },
  };
}

describe("department names (v0.22)", () => {
  it.each(["sales", "SALES", "ärztlicher dienst"])("refuses %s, ignoring case", async (name) => {
    lockDocument.mockClear();
    await expect(assertFreeDepartmentName(host(), { name })).rejects.toMatchObject({
      details: { keys: ["name"], codes: { name: "taken" } },
    });
    expect(lockDocument).toHaveBeenCalledWith(
      expect.anything(),
      DEPARTMENT_NAMES_LOCK_UID,
      "global",
    );
  });
  it("refuses what only the database's folding finds (Postgres: ΟΣ = οσ)", async () => {
    await expect(assertFreeDepartmentName(host(true), { name: "οσ" })).rejects.toMatchObject({
      details: { codes: { name: "taken" } },
    });
  });
  it("keeps a department's own name on update, and other names pass", async () => {
    await expect(
      assertFreeDepartmentName(host(), { name: "SALES" }, { id: 1 }),
    ).resolves.toBeUndefined();
    await expect(assertFreeDepartmentName(host(), { name: "Logistik" })).resolves.toBeUndefined();
  });
  it("skips writes without a name and takes no lock outside a transaction", async () => {
    lockDocument.mockClear();
    await expect(assertFreeDepartmentName(host(), { color: "#000000" })).resolves.toBeUndefined();
    await expect(
      assertFreeDepartmentName(host(false, false), { name: "Logistik" }),
    ).resolves.toBeUndefined();
    expect(lockDocument).not.toHaveBeenCalled();
  });
});
