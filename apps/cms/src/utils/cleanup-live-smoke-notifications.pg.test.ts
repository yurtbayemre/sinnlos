import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PG_URL, uniqueSchema } from "../database/pg-test-db.test.helper";
import { requireCmsDependency } from "../database/strapi-knex.test.helper";

/**
 * infra/diagnostics/cleanup-live-smoke-notifications.sql (IN06) against a
 * real Postgres 16 (runs only with SINNLOS_TEST_PG_URL set, CI job
 * `datetime`), on the notification tables as Strapi 5.55.1 creates them
 * (the columns the file touches, the link tables' keys and cascades).
 * Pinned:
 *  - without the guard it is a dry run: it reports the residue and removes
 *    nothing;
 *  - armed with a count other than the residue it removes nothing;
 *  - armed with the right count it removes exactly the smoke author's
 *    comment notifications (and their link rows) in one transaction;
 *  - other actors, other types, other links and other titles stay;
 *  - the smoke author can be named (sinnlos.cleanup_smoke_author).
 */

interface PgResult {
  command: string;
  rows: Array<Record<string, unknown>>;
}
interface PgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<PgResult | PgResult[]>;
  end(): Promise<void>;
}
const { Client } = requireCmsDependency<{
  Client: new (config: { connectionString: string }) => PgClient;
}>("pg");

const CLEANUP_SQL = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "infra",
    "diagnostics",
    "cleanup-live-smoke-notifications.sql",
  ),
  "utf8",
);

const SAM = "sam.chen@sinnlos.local";

describe.skipIf(!PG_URL)("cleanup-live-smoke-notifications.sql on Postgres 16", () => {
  let client: PgClient;
  let schema: string;

  const all = async (sql: string) => {
    const result = await client.query(sql);
    return (Array.isArray(result) ? result[result.length - 1] : result).rows;
  };

  /** Runs the file as psql would (one simple query, all statements); returns its report. */
  async function cleanup(settings: Record<string, string> = {}) {
    // An empty setting reads as unset (the file's nullif).
    const values = {
      "sinnlos.cleanup_expected_rows": "",
      "sinnlos.cleanup_smoke_author": "",
      ...settings,
    };
    for (const [name, value] of Object.entries(values)) {
      await client.query(`SET ${name} = '${value}'`);
    }
    const results = await client.query(CLEANUP_SQL);
    const list = Array.isArray(results) ? results : [results];
    expect(list.map((r) => r.command)).toEqual([
      "BEGIN",
      "SET",
      "SELECT",
      "SELECT",
      "SELECT",
      "SELECT",
      "COMMIT",
    ]);
    const summary = list[3].rows[0];
    const report = list[5].rows[0];
    return {
      residue: Number(summary.residue_rows),
      byTitle: list[4].rows.map((row) => `${String(row.title)}=${Number(row.rows)}`),
      removed: Number(report.notifications_removed),
      links: Number(report.link_rows_removed),
      result: String(report.result),
    };
  }

  /** "id:type:actor->recipient" of every notification left, sorted by id. */
  const left = async () =>
    (
      await all(`
        SELECT n.id || ':' || n.type || ':' || coalesce(ua.email, '-') || '->' || coalesce(ur.email, '-') AS row
          FROM notifications n
          LEFT JOIN notifications_actor_lnk a ON a.notification_id = n.id
          LEFT JOIN up_users ua ON ua.id = a.user_id
          LEFT JOIN notifications_recipient_lnk r ON r.notification_id = n.id
          LEFT JOIN up_users ur ON ur.id = r.user_id
         ORDER BY n.id`)
    ).map((row) => String(row.row));
  const linkRows = async () =>
    Number(
      (
        await all(`SELECT (SELECT count(*) FROM notifications_actor_lnk)
                        + (SELECT count(*) FROM notifications_recipient_lnk) AS n`)
      )[0].n,
    );

  /** One notification with its actor and recipient links (null = no link). */
  const notify = (
    id: number,
    type: string,
    title: string,
    link: string,
    actor: string | null,
    recipient: string | null,
  ) =>
    client.query(`
      INSERT INTO notifications (id, document_id, type, title, link, created_at, updated_at)
      VALUES (${id}, 'n${id}', '${type}', '${title.replace(/'/g, "''")}', '${link}', now(), now());
      ${actor ? `INSERT INTO notifications_actor_lnk (notification_id, user_id) SELECT ${id}, id FROM up_users WHERE email = '${actor}';` : ""}
      ${recipient ? `INSERT INTO notifications_recipient_lnk (notification_id, user_id) SELECT ${id}, id FROM up_users WHERE email = '${recipient}';` : ""}`);

  beforeAll(async () => {
    client = new Client({ connectionString: PG_URL });
    await client.connect();
    schema = uniqueSchema("cleanup_live_smoke");
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  beforeEach(async () => {
    await client.query(`
      SET search_path TO "${schema}";
      DROP TABLE IF EXISTS notifications_actor_lnk, notifications_recipient_lnk, notifications, up_users;
      CREATE TABLE up_users (id serial PRIMARY KEY, document_id varchar(255), email varchar(255));
      CREATE TABLE notifications (
        id serial PRIMARY KEY, document_id varchar(255), type varchar(255), title varchar(255),
        link varchar(255), read_at timestamp(6) with time zone,
        source_type varchar(255), source_document_id varchar(255),
        created_at timestamp(6) with time zone, updated_at timestamp(6) with time zone);
      CREATE TABLE notifications_actor_lnk (
        id serial PRIMARY KEY,
        notification_id integer REFERENCES notifications(id) ON DELETE CASCADE,
        user_id integer REFERENCES up_users(id) ON DELETE CASCADE,
        CONSTRAINT notifications_actor_lnk_uq UNIQUE (notification_id, user_id));
      CREATE TABLE notifications_recipient_lnk (
        id serial PRIMARY KEY,
        notification_id integer REFERENCES notifications(id) ON DELETE CASCADE,
        user_id integer REFERENCES up_users(id) ON DELETE CASCADE,
        CONSTRAINT notifications_recipient_lnk_uq UNIQUE (notification_id, user_id));
      INSERT INTO up_users (document_id, email) VALUES
        ('u1', 'dana.patel@sinnlos.local'), ('u2', '${SAM}'), ('u3', 'casey.jones@sinnlos.local');
    `);
    // The residue: the smoke author's comments on two announcements.
    await notify(
      1,
      "comment",
      'Sam Chen commented on "Welcome to Sinnlos Intranet!"',
      "/announcements",
      SAM,
      "dana.patel@sinnlos.local",
    );
    await notify(
      2,
      "comment",
      'Sam Chen commented on "Welcome to Sinnlos Intranet!"',
      "/announcements",
      SAM,
      "dana.patel@sinnlos.local",
    );
    await notify(
      3,
      "comment",
      'Sam Chen commented on "Q3 All-Hands"',
      "/announcements",
      SAM,
      "casey.jones@sinnlos.local",
    );
    // Not residue: another actor, another type, another link, another title, no actor.
    await notify(
      4,
      "comment",
      'Casey Jones commented on "Q3 All-Hands"',
      "/announcements",
      "casey.jones@sinnlos.local",
      "dana.patel@sinnlos.local",
    );
    await notify(5, "kudos", "Sam Chen sent you kudos", "/kudos", SAM, "casey.jones@sinnlos.local");
    await notify(
      6,
      "comment",
      'Sam Chen commented on "Code Review Guidelines"',
      "/wiki",
      SAM,
      "dana.patel@sinnlos.local",
    );
    await notify(
      7,
      "comment",
      "Sam Chen replied",
      "/announcements",
      SAM,
      "dana.patel@sinnlos.local",
    );
    await notify(
      8,
      "announcement",
      "New announcement: Q3 All-Hands",
      "/announcements",
      null,
      "casey.jones@sinnlos.local",
    );
  });

  it("is a dry run without the guard: reports the residue, removes nothing", async () => {
    const before = await left();
    expect(await cleanup()).toEqual({
      residue: 3,
      byTitle: [
        'Sam Chen commented on "Welcome to Sinnlos Intranet!"=2',
        'Sam Chen commented on "Q3 All-Hands"=1',
      ],
      removed: 0,
      links: 0,
      result: expect.stringMatching(/^dry run: nothing removed/),
    });
    expect(await left()).toEqual(before);
  });

  it("removes nothing when armed with another count", async () => {
    const before = await left();
    for (const count of ["2", "4", "03", "all"]) {
      const report = await cleanup({ "sinnlos.cleanup_expected_rows": count });
      expect(report.removed, count).toBe(0);
      expect(report.result, count).toBe("expected_rows is not residue_rows: nothing removed");
    }
    expect(await left()).toEqual(before);
  });

  it("removes exactly the residue and its links when armed with its count", async () => {
    const linksBefore = await linkRows();
    expect(await cleanup({ "sinnlos.cleanup_expected_rows": "3" })).toMatchObject({
      residue: 3,
      removed: 3,
      links: 6,
      result: "removed",
    });
    expect(await left()).toEqual([
      "4:comment:casey.jones@sinnlos.local->dana.patel@sinnlos.local",
      "5:kudos:sam.chen@sinnlos.local->casey.jones@sinnlos.local",
      "6:comment:sam.chen@sinnlos.local->dana.patel@sinnlos.local",
      "7:comment:sam.chen@sinnlos.local->dana.patel@sinnlos.local",
      "8:announcement:-->casey.jones@sinnlos.local",
    ]);
    expect(await linkRows()).toBe(linksBefore - 6);
    // A second run finds nothing.
    expect(await cleanup({ "sinnlos.cleanup_expected_rows": "0" })).toMatchObject({
      residue: 0,
      removed: 0,
      result: "removed",
    });
  });

  it("takes another smoke author", async () => {
    const report = await cleanup({
      "sinnlos.cleanup_smoke_author": "CASEY.JONES@sinnlos.local",
      "sinnlos.cleanup_expected_rows": "1",
    });
    expect(report).toMatchObject({ residue: 1, removed: 1, links: 2, result: "removed" });
    expect(await left()).not.toContain(
      "4:comment:casey.jones@sinnlos.local->dana.patel@sinnlos.local",
    );
    expect((await left()).filter((row) => row.includes(":comment:sam.chen"))).toHaveLength(5);
  });
});
