import { describe, expect, it } from "vitest";
import isClassifiedAuthor from "./is-classified-author";

/**
 * Wiring test for the classified write-guard (#24): only the author may
 * update/delete their ad, while admins and editors pass for moderation.
 *
 * The policy resolves the target row through `strapi.db.query(...).findOne`,
 * so a small stub is enough — no Strapi runtime, no database.
 *
 * The trap this pins down (trap c): v5 routes carry a String `documentId`
 * while the web app sends a numeric `id`. The policy must branch on the
 * shape of the param and query the MATCHING column (`where.documentId` vs
 * `where.id`); both lookup paths are exercised below.
 */

const AUTHOR = 100;
const STRANGER = 200;

interface StubRow {
  id: number;
  documentId: string;
  author?: { id: number };
}

const CLASSIFIED: StubRow = { id: 1, documentId: "doc-1", author: { id: AUTHOR } };

function stubStrapi(rows: StubRow[]) {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async ({ where }: any) => {
          if (uid !== "api::classified.classified") return null;
          // Trap c: honour whichever column the policy chose to look up on.
          const match = (r: StubRow) =>
            where.documentId !== undefined ? r.documentId === where.documentId : r.id === where.id;
          return rows.find(match) ?? null;
        },
      }),
    },
  };
}

function context(user: unknown | null, id?: string | number) {
  return {
    state: user ? { user } : {},
    request: { query: {} },
    params: { id },
  } as any;
}

const run = (ctx: any, rows: StubRow[] = [CLASSIFIED], config?: { bypassRoles?: string[] }) =>
  isClassifiedAuthor(ctx, config, { strapi: stubStrapi(rows) } as any);

/** Route configs as wired in api/classified/routes/classified.ts. */
const UPDATE_CONFIG = { bypassRoles: ["admin_role"] };
const DELETE_CONFIG = { bypassRoles: ["admin_role", "editor"] };

const author = { id: AUTHOR, role: { id: 5, type: "member" } };
const stranger = { id: STRANGER, role: { id: 5, type: "member" } };
const admin = { id: 1, role: { id: 1, type: "admin_role" } };
const editor = { id: 2, role: { id: 3, type: "editor" } };

describe("is-classified-author policy", () => {
  it("lets the author through via a numeric id", async () => {
    await expect(run(context(author, 1))).resolves.toBe(true);
  });

  it("lets the author through via a String documentId (trap c)", async () => {
    await expect(run(context(author, "doc-1"))).resolves.toBe(true);
  });

  it("rejects a non-author", async () => {
    await expect(run(context(stranger, 1))).resolves.toBe(false);
  });

  it("lets admin_role bypass for moderation (default config)", async () => {
    await expect(run(context(admin, 1))).resolves.toBe(true);
  });

  it("lets an editor bypass for moderation (default config)", async () => {
    await expect(run(context(editor, 1))).resolves.toBe(true);
  });

  it("update config: admin bypasses, editor must own", async () => {
    await expect(run(context(admin, 1), [CLASSIFIED], UPDATE_CONFIG)).resolves.toBe(true);
    await expect(run(context(editor, 1), [CLASSIFIED], UPDATE_CONFIG)).resolves.toBe(false);
    await expect(run(context(author, 1), [CLASSIFIED], UPDATE_CONFIG)).resolves.toBe(true);
  });

  it("delete config: editor keeps the takedown bypass", async () => {
    await expect(run(context(editor, 1), [CLASSIFIED], DELETE_CONFIG)).resolves.toBe(true);
    await expect(run(context(stranger, 1), [CLASSIFIED], DELETE_CONFIG)).resolves.toBe(false);
  });

  it("rejects an anonymous caller", async () => {
    await expect(run(context(null, 1))).resolves.toBe(false);
  });

  it("rejects when the target classified does not exist", async () => {
    await expect(run(context(author, 999))).resolves.toBe(false);
  });

  it("rejects when no id param is present", async () => {
    await expect(run(context(author, undefined))).resolves.toBe(false);
  });
});
