import { describe, expect, it } from "vitest";
import isDepartmentHead from "./is-department-head";

/**
 * Ownership guard (#24): admin/editor bypass unconditionally; otherwise the
 * caller must be a department_head whose OWN department matches the target
 * department. A missing target id means a collection-level create, which the
 * policy waves through (the controller re-checks the row).
 *
 * Because `ctx.state.user` only carries id + role, the policy does a SECOND
 * findOne against `plugin::users-permissions.user` to resolve the caller's
 * department. The stub answers both the department lookup and that user
 * lookup.
 *
 * Trap (c): numeric id vs documentId string — the stub branches on
 * `where.id` vs `where.documentId` and both paths are exercised. Note the
 * documentId lookup still returns the SAME row, so the final equality is
 * against the numeric `entity.id` either way.
 *
 * Plain-object stubs only — no Strapi runtime, no DB, no mocking.
 */

const HEAD = 1;
const ENGINEERING = 10;
const DESIGN = 11;

const DEPARTMENT = {
  id: ENGINEERING,
  documentId: "dept-eng",
  members: [],
};

interface CallerRecord {
  id: number;
  department?: { id: number };
}

function stubStrapi(callerRecords: CallerRecord[]) {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async ({ where }: any) => {
          if (uid === "api::department.department") {
            return where.documentId !== undefined
              ? where.documentId === DEPARTMENT.documentId
                ? DEPARTMENT
                : null
              : where.id === DEPARTMENT.id
                ? DEPARTMENT
                : null;
          }
          if (uid === "plugin::users-permissions.user") {
            return callerRecords.find((u) => u.id === where.id) ?? null;
          }
          return null;
        },
        findMany: async () => [],
      }),
    },
  };
}

function context(user: any, id?: number | string) {
  return {
    state: user ? { user } : {},
    request: { query: {} },
    params: { id },
  } as any;
}

const run = (ctx: any, callerRecords: CallerRecord[] = []) =>
  isDepartmentHead(ctx, undefined, { strapi: stubStrapi(callerRecords) } as any);

describe("is-department-head policy", () => {
  it("rejects a caller with no role type", async () => {
    await expect(run(context(null))).resolves.toBe(false);
    await expect(run(context({ id: 1 }))).resolves.toBe(false);
  });

  it("lets an admin_role through (id path)", async () => {
    const admin = { id: 9, role: { type: "admin_role" } };
    await expect(run(context(admin, DEPARTMENT.id))).resolves.toBe(true);
  });

  it("lets an editor through (documentId path)", async () => {
    const editor = { id: 9, role: { type: "editor" } };
    await expect(run(context(editor, DEPARTMENT.documentId))).resolves.toBe(true);
  });

  it("rejects a non-department_head role", async () => {
    const member = { id: 5, role: { type: "member" } };
    await expect(run(context(member, DEPARTMENT.id))).resolves.toBe(false);
  });

  it("allows a department_head at collection level (no target id)", async () => {
    // Create route: the row-level checks happen in the controller.
    const head = { id: HEAD, role: { type: "department_head" } };
    await expect(run(context(head))).resolves.toBe(true);
  });

  describe("row level (second findOne for the caller's department)", () => {
    it("allows the head of the target department — documentId path", async () => {
      const head = { id: HEAD, role: { type: "department_head" } };
      const record = { id: HEAD, department: { id: ENGINEERING } };
      await expect(run(context(head, DEPARTMENT.documentId), [record])).resolves.toBe(true);
    });

    it("allows the head of the target department — numeric id path", async () => {
      const head = { id: HEAD, role: { type: "department_head" } };
      const record = { id: HEAD, department: { id: ENGINEERING } };
      await expect(run(context(head, DEPARTMENT.id), [record])).resolves.toBe(true);
    });

    it("rejects a head whose own department differs from the target", async () => {
      const head = { id: HEAD, role: { type: "department_head" } };
      const record = { id: HEAD, department: { id: DESIGN } };
      await expect(run(context(head, DEPARTMENT.id), [record])).resolves.toBe(false);
    });

    it("returns false when the target department does not exist (both id shapes)", async () => {
      const head = { id: HEAD, role: { type: "department_head" } };
      const record = { id: HEAD, department: { id: ENGINEERING } };
      await expect(run(context(head, 999), [record])).resolves.toBe(false);
      await expect(run(context(head, "ghost"), [record])).resolves.toBe(false);
    });

    it("returns false when the caller has no resolvable department", async () => {
      const head = { id: HEAD, role: { type: "department_head" } };
      // No caller record → second findOne yields null → no department match.
      await expect(run(context(head, DEPARTMENT.id), [])).resolves.toBe(false);
    });
  });
});
