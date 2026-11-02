import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PG_URL } from "../database/pg-test-db.test.helper";
import { requireCmsDependency } from "../database/strapi-knex.test.helper";
import { createUser, signIn } from "./admin-api.test.helper";
import { createTestStrapi, type Row, type TestDatabase } from "./harness.test.helper";

/**
 * infra/diagnostics/secret-shares-rollback.sql (v0.35.0, the rollback to
 * v0.34.0) against the schema the real cms creates, on Postgres 16.
 *
 * The cms runs in a schema whose name needs quoting (capitals, a space, a
 * hyphen), next to decoy `secret_shares` and `notifications` tables with
 * rows in a second schema the test owns, which is the rollback session's
 * ambient search_path (as an unrelated default would be); `public` is never
 * touched. The file is run as docs/UPGRADE.md says, with the cms schema in
 * the session setting `sinnlos.schema` only. The harness has no psql, so a
 * pg client connects with the startup options PGOPTIONS would send
 * (`-c search_path=<decoys> -c sinnlos.schema=<schema>`, spaces escaped as
 * `\ `) and
 * sends the whole file as one simple query, as psql does without
 * meta-commands; a failed run ends its session, as psql's ON_ERROR_STOP does.
 *
 * Pinned: every share (all states) and every `secretShared` notification
 * with the rows of both its link tables goes; other notifications and their
 * link rows stay; the reported counts; a second run deletes nothing; a
 * missing table fails and changes nothing; a failure while the
 * notifications are deleted rolls the share deletion back too.
 */

interface PgResult {
  command: string;
  rows: Row[];
}
interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<PgResult | PgResult[]>;
  end(): Promise<void>;
}
const { Client } = requireCmsDependency<{
  Client: new (config: { connectionString: string; options?: string }) => PgClient;
}>("pg");

const ROLLBACK_SQL = readFileSync(
  join(__dirname, "..", "..", "..", "..", "infra", "diagnostics", "secret-shares-rollback.sql"),
  "utf8",
);

const UID = "api::secret-share.secret-share";
const NOTIFICATION = "api::notification.notification";

describe.skipIf(!PG_URL)("secret-shares-rollback.sql on the cms schema (Postgres 16)", () => {
  const schema = `Sinnlos IT-${randomBytes(3).toString("hex")}`;
  const decoys = `Sinnlos Decoys-${randomBytes(3).toString("hex")}`;
  const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
  const at = (table: string) => `${q(schema)}.${q(table)}`;
  let admin: PgClient;

  /** One statement on the admin connection; its rows. */
  const sql = async (statement: string) => {
    const result = await admin.query(statement);
    return (Array.isArray(result) ? result[result.length - 1] : result).rows;
  };
  const count = async (from: string, where = "true") =>
    Number((await sql(`SELECT count(*) AS n FROM ${from} WHERE ${where}`))[0].n);

  /** Runs the file in a session of its own with `sinnlos.schema`; its results, or the error. */
  async function rollback(target: string) {
    const client = new Client({
      connectionString: PG_URL,
      options: [`search_path=${q(decoys)}`, `sinnlos.schema=${target}`]
        .map((setting) => `-c ${setting.replace(/ /g, "\\ ")}`)
        .join(" "),
    });
    await client.connect();
    try {
      const results = await client.query(ROLLBACK_SQL);
      const list = Array.isArray(results) ? results : [results];
      expect(list.map((r) => r.command)).toEqual(["BEGIN", "SET", "SELECT", "SELECT", "COMMIT"]);
      return { schema: list[2].rows[0].schema, counts: list[3].rows[0] };
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: PG_URL, options: "-c TimeZone=UTC" });
    await admin.connect();
    await sql(`CREATE SCHEMA ${q(schema)}`);
    // The decoys: the same table names with rows, in a schema the test owns.
    await sql(`CREATE SCHEMA ${q(decoys)}`);
    await sql(`CREATE TABLE ${q(decoys)}.secret_shares (id integer)`);
    await sql(`CREATE TABLE ${q(decoys)}.notifications (id integer, type text)`);
    await sql(`INSERT INTO ${q(decoys)}.secret_shares VALUES (1), (2)`);
    await sql(`INSERT INTO ${q(decoys)}.notifications VALUES (1, 'secretShared'), (2, 'kudos')`);
  });
  afterAll(async () => {
    try {
      await sql(`DROP SCHEMA IF EXISTS ${q(decoys)} CASCADE`);
      await sql(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  it("deletes every share and secretShared notification of the cms schema, and only those", async () => {
    // The cms boots into the quoted schema; the test owns and drops it.
    const database: TestDatabase = {
      engine: "postgres",
      env: {
        DATABASE_CLIENT: "postgres",
        DATABASE_URL: PG_URL,
        DATABASE_SCHEMA: schema,
        DATABASE_POOL_MIN: "0",
        DATABASE_POOL_MAX: "5",
      },
      sql: async () => [],
      drop: async () => undefined,
    };
    const t = await createTestStrapi({ database });
    let other: Row;
    try {
      const sender = await createUser(t, "member");
      const recipient = await createUser(t, "member");
      const from = { jwt: await signIn(t, sender) };
      const to = { jwt: await signIn(t, recipient) };
      const ids: string[] = [];
      for (const text of ["one", "two", "three", "four"]) {
        const res = await t.api<{ data?: { id?: string } }>(from, "/api/secret-shares", {
          json: { recipient: recipient.id, text, lifetime: "1h" },
        });
        expect(res.status, res.text).toBe(201);
        ids.push(res.body.data!.id!);
      }
      // Four states: retrieved, revoked, expired by the janitor, pending.
      expect(
        (await t.api(to, `/api/secret-shares/${ids[0]}/reveal`, { method: "POST" })).status,
      ).toBe(200);
      expect(
        (await t.api(from, `/api/secret-shares/${ids[1]}/revoke`, { method: "POST" })).status,
      ).toBe(200);
      await t.strapi.db.query(UID).update({
        where: { documentId: ids[2] },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await t
        .requireBuilt<{ runSecretShareJanitor(s: unknown): Promise<unknown> }>(
          "src/cron/secret-share-janitor",
        )
        .runSecretShareJanitor(t.strapi);
      // Another notification with both link rows, which must stay.
      other = await t.strapi.db.query(NOTIFICATION).create({
        data: {
          type: "kudos",
          title: "Ada gave you kudos!",
          link: "/kudos",
          recipient: recipient.id,
          actor: sender.id,
        },
      });
    } finally {
      await t.stop();
    }

    const states = (await sql(`SELECT state FROM ${at("secret_shares")} ORDER BY state`)).map(
      (row) => row.state,
    );
    expect(states).toEqual(["expired", "pending", "retrieved", "revoked"]);
    const shared = (
      await sql(`SELECT id FROM ${at("notifications")} WHERE type = 'secretShared'`)
    ).map((row) => Number(row.id));
    expect(shared).toHaveLength(1);
    const links = (n: number) =>
      Promise.all(
        ["notifications_recipient_lnk", "notifications_actor_lnk"].map((table) =>
          count(at(table), `notification_id = ${n}`),
        ),
      );
    expect(await links(shared[0])).toEqual([1, 1]);
    expect(await links(other.id)).toEqual([1, 1]);

    const first = await rollback(schema);
    expect(first.schema).toBe(q(schema));
    expect(first.counts).toEqual({ secret_shares_deleted: "4", notifications_deleted: "1" });
    expect(await count(at("secret_shares"))).toBe(0);
    expect(await count(at("notifications"), "type = 'secretShared'")).toBe(0);
    expect(await links(shared[0])).toEqual([0, 0]);
    expect(await count(at("notifications"), `id = ${other.id}`)).toBe(1);
    expect(await links(other.id)).toEqual([1, 1]);
    // The decoys are untouched.
    expect(await count(`${q(decoys)}.secret_shares`)).toBe(2);
    expect(await count(`${q(decoys)}.notifications`)).toBe(2);

    const second = await rollback(schema);
    expect(second.counts).toEqual({ secret_shares_deleted: "0", notifications_deleted: "0" });
  }, 180_000);

  it("a missing table fails and changes nothing", async () => {
    await sql(
      `INSERT INTO ${at("notifications")} (document_id, type, title, link, created_at, updated_at) ` +
        `VALUES ('kept', 'secretShared', 'x', '/secrets/kept', now(), now())`,
    );
    await sql(`ALTER TABLE ${at("secret_shares")} RENAME TO secret_shares_away`);
    try {
      await expect(rollback(schema)).rejects.toMatchObject({ code: "42P01" });
    } finally {
      await sql(`ALTER TABLE ${at("secret_shares_away")} RENAME TO secret_shares`);
    }
    expect(await count(at("notifications"), "type = 'secretShared'")).toBe(1);
    expect(await count(`${q(decoys)}.secret_shares`)).toBe(2);
  });

  it("a failure while the notifications are deleted rolls the share deletion back", async () => {
    await sql(
      `INSERT INTO ${at("secret_shares")} (document_id, sender_id, recipient_id, expires_at, state, created_at, updated_at) ` +
        `VALUES ('a1b2c3d4e5f6g7h8i9j0k1l2', 1, 2, now(), 'pending', now(), now())`,
    );
    await sql(
      `CREATE FUNCTION ${at("it_refuse_delete")}() RETURNS trigger LANGUAGE plpgsql AS ` +
        `$$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`,
    );
    await sql(
      `CREATE TRIGGER it_refuse_delete BEFORE DELETE ON ${at("notifications")} ` +
        `FOR EACH ROW EXECUTE FUNCTION ${at("it_refuse_delete")}()`,
    );
    try {
      await expect(rollback(schema)).rejects.toMatchObject({ message: "injected failure" });
    } finally {
      await sql(`DROP TRIGGER it_refuse_delete ON ${at("notifications")}`);
      await sql(`DROP FUNCTION ${at("it_refuse_delete")}()`);
    }
    expect(await count(at("secret_shares"))).toBe(1);
    expect(await count(at("notifications"), "type = 'secretShared'")).toBe(1);
    // Without the failure the same run goes through.
    expect((await rollback(schema)).counts).toEqual({
      secret_shares_deleted: "1",
      notifications_deleted: "1",
    });
  });
});
