import { describe, expect, it } from "vitest";

import { createUser, signIn } from "./admin-api.test.helper";
import { createTestDatabase, createTestStrapi, testEngines } from "./harness.test.helper";

/**
 * Secret shares on a restart (v0.35.0, plan §3.3 "fresh boot and restart"):
 * the first boot creates the table and the five indexes, the second finds
 * them and the pending share as it was.
 */

const UID = "api::secret-share.secret-share";

describe.each(testEngines())("secret shares across a restart on %s", (engine) => {
  it("boots again on the same database: indexes and the shares survive a restart", async () => {
    const database = await createTestDatabase(engine);
    try {
      let first = await createTestStrapi({ database });
      let documentId = "";
      try {
        const sender = await createUser(first, "member");
        const recipient = await createUser(first, "member");
        const res = await first.api<{ data?: { id?: string } }>(
          { jwt: await signIn(first, sender) },
          "/api/secret-shares",
          {
            json: { recipient: recipient.id, text: "survives", lifetime: "24h" },
          },
        );
        expect(res.status, res.text).toBe(201);
        documentId = res.body.data!.id as string;
      } finally {
        await first.stop();
      }
      const indexes =
        engine === "sqlite"
          ? "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'secret_shares_%'"
          : `SELECT indexname AS name FROM pg_indexes WHERE schemaname = '${database.env.DATABASE_SCHEMA}' AND indexname LIKE 'secret_shares_%'`;
      const names = (await database.sql<{ name: string }>(indexes)).map((row) => row.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "secret_shares_document_id_uq",
          "secret_shares_recipient_id_state_idx",
          "secret_shares_sender_id_created_at_idx",
          "secret_shares_state_expires_at_idx",
          "secret_shares_terminal_at_idx",
        ]),
      );
      first = await createTestStrapi({ database, fixtures: false });
      try {
        expect(
          await first.strapi.db.query(UID).count({ where: { documentId, state: "pending" } }),
        ).toBe(1);
      } finally {
        await first.stop();
      }
    } finally {
      await database.drop();
    }
  }, 180_000);
});
