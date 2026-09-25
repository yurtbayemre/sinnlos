import { errors } from "@strapi/utils";
import { describe, expect, it } from "vitest";
import type { StrapiDb, WriteCaller, WritePolicy } from "../utils/write-allowlist";
import canEditTeam from "./can-edit-team";

/**
 * Write gate for team updates (#24, FX07; formerly is-team-member-or-lead).
 *
 * Row gate: admin/editor bypass unconditionally; otherwise the caller must
 * lead the target team (class "lead") or be the department_head of the
 * team's department (class "departmentHead"). Plain MEMBERS of the team no
 * longer pass: they get no write on the team at all. The policy guards only
 * the update route, so a missing target id fails closed.
 *
 * Field gate (FX07): both classes may write `description` only. Before FX07
 * the row gate alone let a lead (or any member holding the team update
 * grant) connect `pages` (hidden wiki pages included), add or remove
 * `members`, hand over `lead` or move the team to another `department`.
 *
 * The department_head branch needs the caller's OWN department, so the policy
 * does a SECOND findOne against `plugin::users-permissions.user` after loading
 * the team. The stub answers both the team lookup and that user lookup.
 *
 * Trap (c): numeric id vs documentId string — the stub branches on
 * `where.id` vs `where.documentId` and both paths are exercised.
 *
 * Plain-object stubs only — no Strapi runtime, no DB, no mocking.
 */

const LEAD = 1;
const MEMBER = 2;
const DEPT_HEAD = 3;
const OUTSIDER = 4;
const ENGINEERING = 10;
const DESIGN = 11;

interface TeamRow {
  id: number;
  documentId: string;
  lead?: { id: number } | null;
  members: { id: number }[];
  department?: { id: number } | null;
}

const TEAM: TeamRow = {
  id: 20,
  documentId: "team-frontend",
  lead: { id: LEAD },
  members: [{ id: MEMBER }],
  department: { id: ENGINEERING },
};

interface CallerRecord {
  id: number;
  department?: { id: number } | null;
}

interface Where {
  id?: number;
  documentId?: string;
}

function stubStrapi(callerRecords: CallerRecord[], team: TeamRow = TEAM): StrapiDb {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async ({ where }: { where: Where }) => {
          if (uid === "api::team.team") {
            const hit =
              where.documentId !== undefined
                ? where.documentId === team.documentId
                : where.id === team.id;
            return hit ? team : null;
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

const DESCRIPTION = { description: "Wir bauen das Frontend." };

function context(user: WriteCaller | null, id?: number | string, data: unknown = DESCRIPTION): Ctx {
  return {
    state: user ? { user } : {},
    request: { body: { data }, query: {} },
    params: { id },
  };
}

const run = (ctx: Ctx, callerRecords: CallerRecord[] = [], team?: TeamRow) =>
  canEditTeam(ctx, undefined, { strapi: stubStrapi(callerRecords, team) });

const lead = { id: LEAD, role: { type: "team_lead" } };
const deptHead = { id: DEPT_HEAD, role: { type: "department_head" } };
const headOfEngineering = [{ id: DEPT_HEAD, department: { id: ENGINEERING } }];

async function refusedKeys(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(errors.ValidationError);
  return (error as InstanceType<typeof errors.ValidationError>).details;
}

describe("can-edit-team policy", () => {
  it("rejects a caller with no role type", async () => {
    await expect(run(context(null))).resolves.toBe(false);
    await expect(run(context({ id: 1 }))).resolves.toBe(false);
  });

  it("lets an admin_role through with any payload (id path)", async () => {
    const admin = { id: 9, role: { type: "admin_role" } };
    const ctx = context(admin, TEAM.id, { members: { set: [] } });
    await expect(run(ctx)).resolves.toBe(true);
    expect(ctx.request.body).toEqual({ data: { members: { set: [] } } });
  });

  it("lets an editor through (documentId path)", async () => {
    const editor = { id: 9, role: { type: "editor" } };
    await expect(run(context(editor, TEAM.documentId))).resolves.toBe(true);
  });

  it("fails closed without a target id (the route is update-only)", async () => {
    await expect(run(context(lead))).resolves.toBe(false);
  });

  it("allows the team lead — numeric id path", async () => {
    await expect(run(context(lead, TEAM.id))).resolves.toBe(true);
  });

  it("allows the team lead — documentId path", async () => {
    await expect(run(context(lead, TEAM.documentId))).resolves.toBe(true);
  });

  it("rejects a plain team member (no write on the team, even for description)", async () => {
    // A member holding the team update grant (team_lead of ANOTHER team).
    const member = { id: MEMBER, role: { type: "team_lead" } };
    await expect(run(context(member, TEAM.documentId))).resolves.toBe(false);
  });

  it("rejects an unrelated caller", async () => {
    const other = { id: OUTSIDER, role: { type: "team_lead" } };
    await expect(run(context(other, TEAM.id))).resolves.toBe(false);
  });

  it("returns false when the team does not exist (both id shapes)", async () => {
    await expect(run(context(lead, 999))).resolves.toBe(false);
    await expect(run(context(lead, "ghost"))).resolves.toBe(false);
  });

  describe("department_head branch (second findOne for the caller's department)", () => {
    it("allows the head of the team's department (documentId path)", async () => {
      await expect(run(context(deptHead, TEAM.documentId), headOfEngineering)).resolves.toBe(true);
    });

    it("rejects a head of a different department (numeric id path)", async () => {
      const record = [{ id: DEPT_HEAD, department: { id: DESIGN } }];
      await expect(run(context(deptHead, TEAM.id), record)).resolves.toBe(false);
    });

    it("never matches a head without a department to a team without one", async () => {
      const orphanTeam = { ...TEAM, department: null };
      const record = [{ id: DEPT_HEAD, department: null }];
      await expect(run(context(deptHead, TEAM.id), record, orphanTeam)).resolves.toBe(false);
    });
  });

  describe("field gate (FX07)", () => {
    it("passes description through unchanged for the lead and the department head", async () => {
      const leadCtx = context(lead, TEAM.documentId);
      await expect(run(leadCtx)).resolves.toBe(true);
      expect(leadCtx.request.body).toEqual({ data: DESCRIPTION });

      const headCtx = context(deptHead, TEAM.documentId, { description: null });
      await expect(run(headCtx, headOfEngineering)).resolves.toBe(true);
      expect(headCtx.request.body).toEqual({ data: { description: null } });
    });

    it.each<[string, Record<string, unknown>]>([
      ["a pages connect (final-review attacker scenario)", { pages: { connect: [{ id: 77 }] } }],
      ["a pages set by documentId", { pages: { set: ["hidden-page"] } }],
      ["adding a member", { members: { connect: [{ id: OUTSIDER }] } }],
      ["replacing the members", { members: [OUTSIDER] }],
      ["handing over the lead", { lead: OUTSIDER }],
      ["moving the team to another department", { department: { documentId: "dept-design" } }],
      ["a rename", { name: "Platform" }],
      ["a new slug", { slug: "platform" }],
      ["an avatar", { avatar: 12 }],
      ["an id", { id: 21 }],
    ])("refuses %s with a 400 naming the key", async (_label, data) => {
      const key = Object.keys(data)[0];
      for (const [caller, records] of [
        [lead, []],
        [deptHead, headOfEngineering],
      ] as const) {
        const ctx = context(caller, TEAM.documentId, { ...DESCRIPTION, ...data });
        await expect(refusedKeys(run(ctx, [...records])), `${caller.role.type}`).resolves.toEqual({
          keys: [key],
        });
      }
    });

    it("refuses a non-string description", async () => {
      const ctx = context(lead, TEAM.documentId, { description: { type: "doc" } });
      await expect(refusedKeys(run(ctx))).resolves.toEqual({ keys: ["description"] });
    });

    it("answers 403, not 400, to a member sending a forbidden payload", async () => {
      const member = { id: MEMBER, role: { type: "team_lead" } };
      await expect(
        run(context(member, TEAM.documentId, { members: { connect: [MEMBER] } })),
      ).resolves.toBe(false);
    });
  });
});
