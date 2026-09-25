import { errors } from "@strapi/utils";
import { describe, expect, it } from "vitest";
import {
  MISSING_DATA_MESSAGE,
  writeAllowlistMessage,
  type StrapiDb,
  type WriteCaller,
  type WritePolicy,
} from "../utils/write-allowlist";
import canEditDepartment from "./can-edit-department";

/**
 * Write gate for department updates (#24, FX07).
 *
 * Row gate: admin/editor bypass unconditionally; otherwise the caller must be
 * a department_head whose OWN department matches the target department. The
 * policy guards only the update route, so a missing target id fails closed.
 *
 * Field gate (FX07): the head may write `description` and a `#rrggbb`
 * `color`, nothing else. Before FX07 the row gate alone let a head connect
 * `pages` (any wiki page, including hidden ones: can-edit-wiki then gave
 * them edit rights on it and the update response its body), `members`,
 * `teams`, `head`, or rename the department.
 *
 * Because `ctx.state.user` only carries id + role, the policy does a SECOND
 * findOne against `plugin::users-permissions.user` to resolve the caller's
 * department. The stub answers both the department lookup and that user
 * lookup.
 *
 * Trap (c): numeric id vs documentId string — the stub branches on
 * `where.id` vs `where.documentId` and both paths are exercised.
 *
 * Plain-object stubs only — no Strapi runtime, no DB, no mocking.
 */

const HEAD = 1;
const ENGINEERING = 10;
const DESIGN = 11;

const DEPARTMENT = { id: ENGINEERING, documentId: "dept-eng" };

interface CallerRecord {
  id: number;
  department?: { id: number };
}

interface Where {
  id?: number;
  documentId?: string;
}

function stubStrapi(callerRecords: CallerRecord[]): StrapiDb {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async ({ where }: { where: Where }) => {
          if (uid === "api::department.department") {
            const hit =
              where.documentId !== undefined
                ? where.documentId === DEPARTMENT.documentId
                : where.id === DEPARTMENT.id;
            return hit ? DEPARTMENT : null;
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

interface Ctx extends WritePolicy {
  request: { body?: unknown; query: Record<string, unknown> };
}

function context(user: WriteCaller | null, id?: number | string, data?: unknown): Ctx {
  return {
    state: user ? { user } : {},
    request: { body: data === undefined ? undefined : { data }, query: {} },
    params: { id },
  };
}

const run = (ctx: Ctx, callerRecords: CallerRecord[] = []) =>
  canEditDepartment(ctx, undefined, { strapi: stubStrapi(callerRecords) });

const head = { id: HEAD, role: { type: "department_head" } };
const ownDepartment = [{ id: HEAD, department: { id: ENGINEERING } }];

async function refusedKeys(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(errors.ValidationError);
  return (error as InstanceType<typeof errors.ValidationError>).details;
}

describe("can-edit-department policy", () => {
  it("rejects a caller with no role type", async () => {
    await expect(run(context(null))).resolves.toBe(false);
    await expect(run(context({ id: 1 }))).resolves.toBe(false);
  });

  it("lets an admin_role through with any payload (id path)", async () => {
    const admin = { id: 9, role: { type: "admin_role" } };
    const ctx = context(admin, DEPARTMENT.id, { name: "Renamed", pages: { connect: [5] } });
    await expect(run(ctx)).resolves.toBe(true);
    expect(ctx.request.body).toEqual({ data: { name: "Renamed", pages: { connect: [5] } } });
  });

  it("lets an editor through (documentId path)", async () => {
    const editor = { id: 9, role: { type: "editor" } };
    await expect(run(context(editor, DEPARTMENT.documentId, {}))).resolves.toBe(true);
  });

  it("rejects a non-department_head role", async () => {
    const member = { id: 5, role: { type: "member" } };
    await expect(run(context(member, DEPARTMENT.id, { description: "x" }))).resolves.toBe(false);
  });

  it("fails closed without a target id (the route is update-only)", async () => {
    await expect(run(context(head, undefined, { description: "x" }), ownDepartment)).resolves.toBe(
      false,
    );
  });

  describe("row gate (second findOne for the caller's department)", () => {
    it("allows the head of the target department — documentId path", async () => {
      await expect(
        run(context(head, DEPARTMENT.documentId, { description: "x" }), ownDepartment),
      ).resolves.toBe(true);
    });

    it("allows the head of the target department — numeric id path", async () => {
      await expect(
        run(context(head, DEPARTMENT.id, { description: "x" }), ownDepartment),
      ).resolves.toBe(true);
    });

    it("rejects a head whose own department differs from the target", async () => {
      const record = [{ id: HEAD, department: { id: DESIGN } }];
      await expect(run(context(head, DEPARTMENT.id, { description: "x" }), record)).resolves.toBe(
        false,
      );
    });

    it("returns false when the target department does not exist (both id shapes)", async () => {
      await expect(run(context(head, 999, { description: "x" }), ownDepartment)).resolves.toBe(
        false,
      );
      await expect(run(context(head, "ghost", { description: "x" }), ownDepartment)).resolves.toBe(
        false,
      );
    });

    it("returns false when the caller has no resolvable department", async () => {
      await expect(run(context(head, DEPARTMENT.id, { description: "x" }), [])).resolves.toBe(
        false,
      );
    });

    it("answers 403 before looking at the payload of a department it may not write", async () => {
      const record = [{ id: HEAD, department: { id: DESIGN } }];
      await expect(
        run(context(head, DEPARTMENT.id, { pages: { connect: [5] } }), record),
      ).resolves.toBe(false);
    });
  });

  describe("field gate (FX07)", () => {
    it("passes description and a #rrggbb colour through unchanged", async () => {
      const data = { description: "## Wir sind Engineering", color: "#0ea5e9" };
      const ctx = context(head, DEPARTMENT.documentId, data);
      await expect(run(ctx, ownDepartment)).resolves.toBe(true);
      expect(ctx.request.body).toEqual({ data });
    });

    it("clears the description with null", async () => {
      const ctx = context(head, DEPARTMENT.documentId, { description: null });
      await expect(run(ctx, ownDepartment)).resolves.toBe(true);
      expect(ctx.request.body).toEqual({ data: { description: null } });
    });

    it.each<[string, Record<string, unknown>]>([
      ["a pages connect (final-review attacker scenario)", { pages: { connect: [{ id: 77 }] } }],
      ["a pages set by raw id", { pages: [77] }],
      ["a members connect", { members: { connect: ["attacker-doc"] } }],
      ["a teams set", { teams: { set: [{ documentId: "team-x" }] } }],
      ["a new head", { head: 1 }],
      ["a rename (Entra department sync matches on it)", { name: "Design" }],
      ["a new slug", { slug: "design" }],
      ["a header image", { headerImage: 12 }],
      ["a publication date", { publishedAt: "2026-01-01T00:00:00.000Z" }],
      ["a documentId", { documentId: "other" }],
    ])("refuses %s with a 400 naming the key", async (_label, data) => {
      const key = Object.keys(data)[0];
      const ctx = context(head, DEPARTMENT.documentId, { description: "ok", ...data });
      await expect(refusedKeys(run(ctx, ownDepartment))).resolves.toEqual({ keys: [key] });
      // Nothing reaches the core: the body is left as the client sent it.
      expect(ctx.request.body).toEqual({ data: { description: "ok", ...data } });
    });

    it.each(["#abc", "#6366f188", "red", "url(https://x/y.png)", "#6366f1;", "", null, 6513393])(
      "refuses the colour %s",
      async (color) => {
        const ctx = context(head, DEPARTMENT.documentId, { color });
        await expect(refusedKeys(run(ctx, ownDepartment))).resolves.toEqual({ keys: ["color"] });
      },
    );

    it("names every refused key at once, in one generic message", async () => {
      const ctx = context(head, DEPARTMENT.documentId, {
        pages: [1],
        members: [2],
        color: "blue",
      });
      const error = await run(ctx, ownDepartment).catch((e: unknown) => e);
      expect((error as Error).message).toBe(writeAllowlistMessage(["color", "members", "pages"]));
    });

    it("answers the core's 400 for a missing data payload", async () => {
      const ctx = context(head, DEPARTMENT.documentId);
      const error = await run(ctx, ownDepartment).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(errors.ValidationError);
      expect((error as Error).message).toBe(MISSING_DATA_MESSAGE);
    });
  });
});
