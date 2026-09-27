import { describe, expect, it } from "vitest";
import { MALFORMED_ENTRY_IDS, failLikePostgres } from "../utils/entry-id.test.helper";
import isReactionAuthor from "./is-reaction-author";

/**
 * Wiring test for the reaction delete-guard (#24): only the author may
 * remove a reaction, while admins and editors pass for moderation (same
 * semantics as comment delete).
 *
 * Trap c: the policy must accept both a numeric `id` (direct API consumers)
 * and a String `documentId` (v5 routes) and query the MATCHING column. Both
 * lookup paths are exercised below. Anything else is refused like an
 * unknown reaction before any lookup: the stub fails like Postgres on a
 * value an int4 `id` lookup cannot take (EVT-ICS-ID class).
 */

const AUTHOR = 100;
const STRANGER = 200;
const DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";

interface StubRow {
  id: number;
  documentId: string;
  author?: { id: number };
}

const REACTION: StubRow = { id: 1, documentId: DOC, author: { id: AUTHOR } };

const lookups: unknown[] = [];

function stubStrapi(rows: StubRow[]) {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async ({ where }: any) => {
          lookups.push(where);
          failLikePostgres(where);
          if (uid !== "api::reaction.reaction") return null;
          // Trap c: honour whichever column the policy chose to look up on.
          const match = (r: StubRow) =>
            where.documentId !== undefined
              ? r.documentId === where.documentId
              : r.id === where.id;
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

const run = (ctx: any, rows: StubRow[] = [REACTION]) =>
  isReactionAuthor(ctx, undefined, { strapi: stubStrapi(rows) } as any);

const author = { id: AUTHOR, role: { id: 5, type: "member" } };
const stranger = { id: STRANGER, role: { id: 5, type: "member" } };
const admin = { id: 1, role: { id: 1, type: "admin_role" } };
const editor = { id: 2, role: { id: 3, type: "editor" } };

describe("is-reaction-author policy", () => {
  it("lets the author through via a numeric id", async () => {
    await expect(run(context(author, 1))).resolves.toBe(true);
  });

  it("lets the author through via a String documentId (trap c)", async () => {
    await expect(run(context(author, DOC))).resolves.toBe(true);
  });

  it("refuses a malformed or out-of-range id like an unknown reaction, without a lookup", async () => {
    lookups.length = 0;
    for (const id of MALFORMED_ENTRY_IDS) {
      await expect(run(context(author, id)), id).resolves.toBe(false);
    }
    expect(lookups).toEqual([]);
  });

  it("rejects a non-author", async () => {
    await expect(run(context(stranger, 1))).resolves.toBe(false);
  });

  it("lets admin_role bypass for moderation", async () => {
    await expect(run(context(admin, 1))).resolves.toBe(true);
  });

  it("lets an editor bypass for moderation", async () => {
    await expect(run(context(editor, 1))).resolves.toBe(true);
  });

  it("rejects an anonymous caller", async () => {
    await expect(run(context(null, 1))).resolves.toBe(false);
  });

  it("rejects when the target reaction does not exist", async () => {
    await expect(run(context(author, 999))).resolves.toBe(false);
  });

  it("rejects when no id param is present", async () => {
    await expect(run(context(author, undefined))).resolves.toBe(false);
  });
});
