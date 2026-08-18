import { describe, expect, it } from "vitest";
import isTeamMemberOrLead from "./is-team-member-or-lead";

/**
 * Ownership guard (#24): admin/editor bypass unconditionally; otherwise the
 * caller must lead the target team, be one of its members, or be the
 * department_head of the team's department. A missing target id means a
 * collection-level access, which the policy waves through.
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

const TEAM = {
  id: 20,
  documentId: "team-frontend",
  lead: { id: LEAD },
  members: [{ id: MEMBER }],
  department: { id: ENGINEERING },
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
          if (uid === "api::team.team") {
            return where.documentId !== undefined
              ? where.documentId === TEAM.documentId
                ? TEAM
                : null
              : where.id === TEAM.id
                ? TEAM
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
  isTeamMemberOrLead(ctx, undefined, { strapi: stubStrapi(callerRecords) } as any);

describe("is-team-member-or-lead policy", () => {
  it("rejects a caller with no role type", async () => {
    await expect(run(context(null))).resolves.toBe(false);
    await expect(run(context({ id: 1 }))).resolves.toBe(false);
  });

  it("lets an admin_role through (id path)", async () => {
    const admin = { id: 9, role: { type: "admin_role" } };
    await expect(run(context(admin, TEAM.id))).resolves.toBe(true);
  });

  it("lets an editor through (documentId path)", async () => {
    const editor = { id: 9, role: { type: "editor" } };
    await expect(run(context(editor, TEAM.documentId))).resolves.toBe(true);
  });

  it("allows any role holder at collection level (no target id)", async () => {
    const member = { id: OUTSIDER, role: { type: "member" } };
    await expect(run(context(member))).resolves.toBe(true);
  });

  it("allows the team lead — numeric id path", async () => {
    const lead = { id: LEAD, role: { type: "team_lead" } };
    await expect(run(context(lead, TEAM.id))).resolves.toBe(true);
  });

  it("allows a plain team member — documentId path", async () => {
    const member = { id: MEMBER, role: { type: "member" } };
    await expect(run(context(member, TEAM.documentId))).resolves.toBe(true);
  });

  it("rejects an unrelated member", async () => {
    const other = { id: OUTSIDER, role: { type: "member" } };
    await expect(run(context(other, TEAM.id))).resolves.toBe(false);
  });

  it("returns false when the team does not exist (both id shapes)", async () => {
    const lead = { id: LEAD, role: { type: "team_lead" } };
    await expect(run(context(lead, 999))).resolves.toBe(false);
    await expect(run(context(lead, "ghost"))).resolves.toBe(false);
  });

  describe("department_head branch (second findOne for the caller's department)", () => {
    it("allows the head of the team's department (documentId path)", async () => {
      const head = { id: DEPT_HEAD, role: { type: "department_head" } };
      const record = { id: DEPT_HEAD, department: { id: ENGINEERING } };
      await expect(run(context(head, TEAM.documentId), [record])).resolves.toBe(true);
    });

    it("rejects a head of a different department (numeric id path)", async () => {
      const head = { id: DEPT_HEAD, role: { type: "department_head" } };
      const record = { id: DEPT_HEAD, department: { id: DESIGN } };
      await expect(run(context(head, TEAM.id), [record])).resolves.toBe(false);
    });
  });
});
