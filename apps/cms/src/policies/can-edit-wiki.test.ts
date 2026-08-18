import { describe, expect, it } from "vitest";
import canEditWiki from "./can-edit-wiki";

/**
 * Write-side guard for wiki pages (#24). Admin/editor bypass unconditionally;
 * on CREATE (no target id) any authenticated non-guest passes; on UPDATE the
 * caller must be the page author, the head of the page's department, or the
 * lead of the page's team.
 *
 * The department_head branch performs a SECOND findOne to resolve the
 * caller's OWN department — `ctx.state.user` only carries id + role — so the
 * stub answers both the wiki-page lookup and the user lookup.
 *
 * Trap (c): v5 routes carry a documentId, but direct API consumers still pass
 * a numeric id, so the policy branches on `where.id` vs `where.documentId`.
 * The stub mirrors that branch and both resolution paths are exercised below.
 *
 * Plain-object stubs only — no Strapi runtime, no DB, no mocking.
 */

const AUTHOR = 1;
const DEPT_HEAD = 2;
const TEAM_LEAD_USER = 3;
const OUTSIDER = 4;
const ENGINEERING = 10;
const DESIGN = 11;
const FRONTEND_TEAM = 20;

interface CallerRecord {
  id: number;
  department?: { id: number };
}

/** A single wiki page, addressable by numeric id OR documentId string. */
const PAGE = {
  id: 100,
  documentId: "wikidoc-100",
  author: { id: AUTHOR },
  department: { id: ENGINEERING },
  team: { id: FRONTEND_TEAM, lead: { id: TEAM_LEAD_USER }, members: [] },
};

function stubStrapi(callerRecords: CallerRecord[]) {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async ({ where }: any) => {
          if (uid === "api::wiki-page.wiki-page") {
            // Branch on the shape of `where`: documentId string vs numeric id.
            return where.documentId !== undefined
              ? where.documentId === PAGE.documentId
                ? PAGE
                : null
              : where.id === PAGE.id
                ? PAGE
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
  canEditWiki(ctx, undefined, { strapi: stubStrapi(callerRecords) } as any);

describe("can-edit-wiki policy", () => {
  it("rejects an anonymous caller", async () => {
    await expect(run(context(null))).resolves.toBe(false);
  });

  it("lets an admin_role through (id path)", async () => {
    const admin = { id: 9, role: { type: "admin_role" } };
    await expect(run(context(admin, PAGE.id))).resolves.toBe(true);
  });

  it("lets an editor through (documentId path)", async () => {
    const editor = { id: 9, role: { type: "editor" } };
    await expect(run(context(editor, PAGE.documentId))).resolves.toBe(true);
  });

  describe("on CREATE (no target id)", () => {
    it("allows any authenticated non-guest", async () => {
      const member = { id: 5, role: { type: "member" } };
      await expect(run(context(member))).resolves.toBe(true);
    });

    it("rejects a guest", async () => {
      const guest = { id: 5, role: { type: "guest" } };
      await expect(run(context(guest))).resolves.toBe(false);
    });
  });

  describe("on UPDATE", () => {
    it("allows the page author — resolved via a NUMERIC id", async () => {
      const author = { id: AUTHOR, role: { type: "member" } };
      await expect(run(context(author, PAGE.id))).resolves.toBe(true);
    });

    it("allows the page author — resolved via a documentId STRING", async () => {
      const author = { id: AUTHOR, role: { type: "member" } };
      await expect(run(context(author, PAGE.documentId))).resolves.toBe(true);
    });

    it("rejects a member who did not author the page", async () => {
      const other = { id: OUTSIDER, role: { type: "member" } };
      await expect(run(context(other, PAGE.id))).resolves.toBe(false);
    });

    it("returns false when the page does not exist (both id shapes)", async () => {
      const author = { id: AUTHOR, role: { type: "member" } };
      await expect(run(context(author, 999))).resolves.toBe(false);
      await expect(run(context(author, "nope"))).resolves.toBe(false);
    });

    describe("department_head branch (second findOne for the caller's department)", () => {
      it("allows the head of the page's department (documentId path)", async () => {
        const head = { id: DEPT_HEAD, role: { type: "department_head" } };
        const record = { id: DEPT_HEAD, department: { id: ENGINEERING } };
        await expect(run(context(head, PAGE.documentId), [record])).resolves.toBe(true);
      });

      it("rejects a head of a DIFFERENT department (numeric id path)", async () => {
        const head = { id: DEPT_HEAD, role: { type: "department_head" } };
        const record = { id: DEPT_HEAD, department: { id: DESIGN } };
        await expect(run(context(head, PAGE.id), [record])).resolves.toBe(false);
      });

      it("rejects a department_head with no resolvable department", async () => {
        const head = { id: DEPT_HEAD, role: { type: "department_head" } };
        // No caller record → second findOne yields null → no department match.
        await expect(run(context(head, PAGE.id), [])).resolves.toBe(false);
      });
    });

    describe("team_lead branch", () => {
      it("allows the lead of the page's team", async () => {
        const lead = { id: TEAM_LEAD_USER, role: { type: "team_lead" } };
        await expect(run(context(lead, PAGE.id))).resolves.toBe(true);
      });

      it("rejects a team_lead who does not lead this page's team", async () => {
        const lead = { id: OUTSIDER, role: { type: "team_lead" } };
        await expect(run(context(lead, PAGE.id))).resolves.toBe(false);
      });
    });
  });
});
