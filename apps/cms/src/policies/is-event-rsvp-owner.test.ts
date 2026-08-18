import { describe, expect, it } from "vitest";
import isEventRsvpOwner from "./is-event-rsvp-owner";

/**
 * Wiring test for the event-RSVP update-guard (#24): only the responding
 * user may change their own answer. admin_role bypasses (matrix
 * corrections); editors get NO moderation bypass here — an RSVP is a
 * personal statement, not content, so an editor must only pass as the actual
 * owner.
 *
 * Trap c: the policy must accept both a numeric `id` and a String
 * `documentId` and query the MATCHING column. Both lookup paths are
 * exercised below.
 */

const OWNER = 100;
const STRANGER = 200;

interface StubRow {
  id: number;
  documentId: string;
  user?: { id: number };
}

const RSVP: StubRow = { id: 1, documentId: "doc-1", user: { id: OWNER } };

function stubStrapi(rows: StubRow[]) {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async ({ where }: any) => {
          if (uid !== "api::event-rsvp.event-rsvp") return null;
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

const run = (ctx: any, rows: StubRow[] = [RSVP]) =>
  isEventRsvpOwner(ctx, undefined, { strapi: stubStrapi(rows) } as any);

const owner = { id: OWNER, role: { id: 5, type: "member" } };
const stranger = { id: STRANGER, role: { id: 5, type: "member" } };
const admin = { id: 1, role: { id: 1, type: "admin_role" } };
const editor = { id: 2, role: { id: 3, type: "editor" } };

describe("is-event-rsvp-owner policy", () => {
  it("lets the owner through via a numeric id", async () => {
    await expect(run(context(owner, 1))).resolves.toBe(true);
  });

  it("lets the owner through via a String documentId (trap c)", async () => {
    await expect(run(context(owner, "doc-1"))).resolves.toBe(true);
  });

  it("rejects a non-owner", async () => {
    await expect(run(context(stranger, 1))).resolves.toBe(false);
  });

  it("lets admin_role bypass", async () => {
    await expect(run(context(admin, 1))).resolves.toBe(true);
  });

  it("does NOT grant an editor a moderation bypass — an RSVP is personal", async () => {
    // The editor is not the responding user, so no bypass may save them.
    await expect(run(context(editor, 1))).resolves.toBe(false);
  });

  it("rejects an anonymous caller", async () => {
    await expect(run(context(null, 1))).resolves.toBe(false);
  });

  it("rejects when the target RSVP does not exist", async () => {
    await expect(run(context(owner, 999))).resolves.toBe(false);
  });

  it("rejects when no id param is present", async () => {
    await expect(run(context(owner, undefined))).resolves.toBe(false);
  });
});
