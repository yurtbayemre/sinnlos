import { describe, expect, it } from "vitest";
import { MALFORMED_ENTRY_IDS, failLikePostgres } from "../utils/entry-id.test.helper";
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
 * exercised below. Anything else is refused like an unknown RSVP before
 * any lookup: the stub fails like Postgres on a value an int4 `id` lookup
 * cannot take (EVT-ICS-ID class).
 */

const OWNER = 100;
const STRANGER = 200;
const DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";

interface StubRow {
  id: number;
  documentId: string;
  user?: { id: number };
}

const RSVP: StubRow = { id: 1, documentId: DOC, user: { id: OWNER } };

const lookups: unknown[] = [];

function stubStrapi(rows: StubRow[]) {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async ({ where }: any) => {
          lookups.push(where);
          failLikePostgres(where);
          if (uid !== "api::event-rsvp.event-rsvp") return null;
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
    await expect(run(context(owner, DOC))).resolves.toBe(true);
  });

  it("refuses a malformed or out-of-range id like an unknown RSVP, without a lookup", async () => {
    lookups.length = 0;
    for (const id of MALFORMED_ENTRY_IDS) {
      await expect(run(context(owner, id)), id).resolves.toBe(false);
    }
    expect(lookups).toEqual([]);
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
