import { describe, expect, it } from "vitest";
import isNotificationRecipient from "./is-notification-recipient";

/**
 * Wiring test for the notification delete-guard (#24): only the recipient
 * (or an admin) may delete a notification. editors get NO bypass — a
 * notification is addressed to one person, so an editor must only pass as
 * the actual recipient.
 *
 * Trap c: the policy must accept both a numeric `id` and a String
 * `documentId` and query the MATCHING column. Both lookup paths are
 * exercised below.
 */

const RECIPIENT = 100;
const STRANGER = 200;

interface StubRow {
  id: number;
  documentId: string;
  recipient?: { id: number };
}

const NOTIFICATION: StubRow = { id: 1, documentId: "doc-1", recipient: { id: RECIPIENT } };

function stubStrapi(rows: StubRow[]) {
  return {
    db: {
      query: (uid: string) => ({
        findOne: async ({ where }: any) => {
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
    await expect(run(context(recipient, "doc-1"))).resolves.toBe(true);
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
