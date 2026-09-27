import { describe, expect, it } from "vitest";
import { MALFORMED_ENTRY_IDS, failLikePostgres } from "../utils/entry-id.test.helper";
import isNotificationRecipient from "./is-notification-recipient";

/**
 * Wiring test for the notification delete-guard (#24): only the recipient
 * (or an admin) may delete a notification. editors get NO bypass — a
 * notification is addressed to one person, so an editor must only pass as
 * the actual recipient.
 *
 * Trap c: the policy must accept both a numeric `id` and a String
 * `documentId` and query the MATCHING column. Both lookup paths are
 * exercised below. Anything else is refused like an unknown notification
 * before any lookup: the stub fails like Postgres on a value an int4 `id`
 * lookup cannot take (EVT-ICS-ID class).
 */

const RECIPIENT = 100;
const STRANGER = 200;
const DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";

interface StubRow {
  id: number;
  documentId: string;
  recipient?: { id: number };
}

const NOTIFICATION: StubRow = { id: 1, documentId: DOC, recipient: { id: RECIPIENT } };

const lookups: unknown[] = [];

function stubStrapi(rows: StubRow[]) {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async ({ where }: any) => {
          lookups.push(where);
          failLikePostgres(where);
          if (uid !== "api::notification.notification") return null;
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

const run = (ctx: any, rows: StubRow[] = [NOTIFICATION]) =>
  isNotificationRecipient(ctx, undefined, { strapi: stubStrapi(rows) } as any);

const recipient = { id: RECIPIENT, role: { id: 5, type: "member" } };
const stranger = { id: STRANGER, role: { id: 5, type: "member" } };
const admin = { id: 1, role: { id: 1, type: "admin_role" } };
const editor = { id: 2, role: { id: 3, type: "editor" } };

describe("is-notification-recipient policy", () => {
  it("lets the recipient through via a numeric id", async () => {
    await expect(run(context(recipient, 1))).resolves.toBe(true);
  });

  it("lets the recipient through via a String documentId (trap c)", async () => {
    await expect(run(context(recipient, DOC))).resolves.toBe(true);
  });

  it("refuses a malformed or out-of-range id like an unknown notification, without a lookup", async () => {
    lookups.length = 0;
    for (const id of MALFORMED_ENTRY_IDS) {
      await expect(run(context(recipient, id)), id).resolves.toBe(false);
    }
    expect(lookups).toEqual([]);
  });

  it("rejects a non-recipient", async () => {
    await expect(run(context(stranger, 1))).resolves.toBe(false);
  });

  it("lets admin_role bypass", async () => {
    await expect(run(context(admin, 1))).resolves.toBe(true);
  });

  it("does NOT grant an editor a bypass — a notification is personal", async () => {
    await expect(run(context(editor, 1))).resolves.toBe(false);
  });

  it("rejects an anonymous caller", async () => {
    await expect(run(context(null, 1))).resolves.toBe(false);
  });

  it("rejects when the target notification does not exist", async () => {
    await expect(run(context(recipient, 999))).resolves.toBe(false);
  });

  it("rejects when no id param is present", async () => {
    await expect(run(context(recipient, undefined))).resolves.toBe(false);
  });
});
