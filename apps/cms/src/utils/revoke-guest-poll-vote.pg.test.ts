import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PG_URL, uniqueSchema } from "../database/pg-test-db.test.helper";
import { requireCmsDependency } from "../database/strapi-knex.test.helper";

/**
 * infra/rollback/revoke-guest-poll-vote.sql against a real Postgres 16 (runs
 * only with SINNLOS_TEST_PG_URL set, CI job `datetime`), on the
 * users-permissions tables as Strapi 5.55.1 creates them (the columns the
 * file touches, with the link table's keys and cascades), filled like the
 * first boot of poll guest access: every intranet role holds its own
 * poll-vote.vote row. Pinned:
 *  - the guest's link and its row go, every other role's vote grant and the
 *    guest's other grants stay;
 *  - a permission row the run did not unlink stays, an orphan with the same
 *    action from before included;
 *  - a row the guest shares with another role loses only the guest link;
 *  - a second run removes nothing, and a run after a new cms granted the
 *    row again removes exactly that.
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

const REVOKE_SQL = readFileSync(
  join(__dirname, "..", "..", "..", "..", "infra", "rollback", "revoke-guest-poll-vote.sql"),
  "utf8",
);
const VOTE = "api::poll-vote.poll-vote.vote";
const ROLES = [
  "admin_role",
  "editor",
  "department_head",
  "team_lead",
  "member",
  "guest",
  "authenticated",
];

describe.skipIf(!PG_URL)("revoke-guest-poll-vote.sql on Postgres 16", () => {
  let client: PgClient;
  let schema: string;

  const all = async (sql: string) => {
    const result = await client.query(sql);
    return (Array.isArray(result) ? result[result.length - 1] : result).rows;
  };
  const one = async (sql: string) => (await all(sql))[0];

  /** Runs the file as psql would (one simple query, all statements) and returns its report. */
  async function revoke(): Promise<{ links: number; rows: number; left: number }> {
    const results = await client.query(REVOKE_SQL);
    const list = Array.isArray(results) ? results : [results];
    expect(list.map((r) => r.command)).toEqual(["BEGIN", "SELECT", "SELECT", "COMMIT"]);
    const report = list[1].rows[0];
    return {
      links: Number(report.guest_links_removed),
      rows: Number(report.permission_rows_removed),
      left: Number(list[2].rows[0].guest_poll_vote_grants_left),
    };
  }

  /** "role:action" for every link, sorted. */
  const grants = async () =>
    (
      await all(`
        SELECT r.type || ':' || p.action AS grant
          FROM up_permissions_role_lnk l
          JOIN up_permissions p ON p.id = l.permission_id
          JOIN up_roles r ON r.id = l.role_id
         ORDER BY 1`)
    ).map((row) => String(row.grant));
  const documentIds = async () =>
    (await all(`SELECT document_id FROM up_permissions ORDER BY 1`)).map((row) =>
      String(row.document_id),
    );

  /** Grants `action` to `role` with a row of its own, as users-permissions does. */
  const grant = (role: string, action: string, documentId: string) =>
    client.query(`
      WITH p AS (
        INSERT INTO up_permissions (document_id, action, created_at, updated_at, published_at)
        VALUES ('${documentId}', '${action}', now(), now(), now()) RETURNING id)
      INSERT INTO up_permissions_role_lnk (permission_id, role_id, permission_ord)
      SELECT p.id, (SELECT id FROM up_roles WHERE type = '${role}'), 1 FROM p`);

  beforeAll(async () => {
    client = new Client({ connectionString: PG_URL });
    await client.connect();
    schema = uniqueSchema("revoke_guest_vote");
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  beforeEach(async () => {
    await client.query(`
      DROP TABLE IF EXISTS up_permissions_role_lnk, up_permissions, up_roles;
      CREATE TABLE up_roles (
        id serial PRIMARY KEY, document_id varchar(255), name varchar(255), type varchar(255));
      CREATE TABLE up_permissions (
        id serial PRIMARY KEY, document_id varchar(255), action varchar(255),
        created_at timestamp(6) with time zone, updated_at timestamp(6) with time zone,
        published_at timestamp(6) with time zone);
      CREATE TABLE up_permissions_role_lnk (
        id serial PRIMARY KEY,
        permission_id integer REFERENCES up_permissions(id) ON DELETE CASCADE,
        role_id integer REFERENCES up_roles(id) ON DELETE CASCADE,
        permission_ord double precision,
        CONSTRAINT up_permissions_role_lnk_uq UNIQUE (permission_id, role_id));
      INSERT INTO up_roles (document_id, name, type)
      SELECT 'role-' || t, t, t FROM unnest(ARRAY['${ROLES.join("','")}']) AS t;
    `);
    for (const role of ROLES) {
      await grant(role, VOTE, `vote-${role}`);
      await grant(role, "api::poll.poll.find", `find-${role}`);
    }
    // Unrelated orphans from before the rollback: a vote row and another action's row.
    await client.query(`
      INSERT INTO up_permissions (document_id, action, created_at, updated_at, published_at)
      VALUES ('orphan-vote', '${VOTE}', now(), now(), now()),
             ('orphan-find', 'api::poll.poll.find', now(), now(), now())`);
  });

  it("removes the guest's vote grant and its row, and nothing else", async () => {
    const grantsBefore = await grants();
    const rowsBefore = await documentIds();

    expect(await revoke()).toEqual({ links: 1, rows: 1, left: 0 });

    expect(await grants()).toEqual(grantsBefore.filter((g) => g !== `guest:${VOTE}`));
    expect(await documentIds()).toEqual(rowsBefore.filter((id) => id !== "vote-guest"));
    expect(await documentIds()).toEqual(expect.arrayContaining(["orphan-vote", "orphan-find"]));
  });

  it("removes nothing on a second run (idempotent)", async () => {
    await revoke();
    const grantsBefore = await grants();
    const rowsBefore = await documentIds();

    expect(await revoke()).toEqual({ links: 0, rows: 0, left: 0 });

    expect(await grants()).toEqual(grantsBefore);
    expect(await documentIds()).toEqual(rowsBefore);
  });

  it("keeps a vote row the guest shares with another role, without the guest link", async () => {
    await client.query(`
      INSERT INTO up_permissions_role_lnk (permission_id, role_id, permission_ord)
      SELECT p.id, (SELECT id FROM up_roles WHERE type = 'member'), 2
        FROM up_permissions p WHERE p.document_id = 'vote-guest'`);

    expect(await revoke()).toEqual({ links: 1, rows: 0, left: 0 });

    expect(
      await one(`
        SELECT string_agg(r.type, ',' ORDER BY r.type) AS roles
          FROM up_permissions p
          JOIN up_permissions_role_lnk l ON l.permission_id = p.id
          JOIN up_roles r ON r.id = l.role_id
         WHERE p.document_id = 'vote-guest'`),
    ).toEqual({ roles: "member" });
  });

  it("removes the row a restarting new cms granted again, then nothing", async () => {
    await revoke();
    await grant("guest", VOTE, "vote-guest-again");

    expect(await revoke()).toEqual({ links: 1, rows: 1, left: 0 });
    expect(await revoke()).toEqual({ links: 0, rows: 0, left: 0 });
    expect(await documentIds()).not.toContain("vote-guest-again");
    expect(await documentIds()).toContain("orphan-vote");
  });

  it("finds nothing to do once the permission was unticked in the admin panel", async () => {
    // Unticking deletes the role's permission row; the link goes with it (cascade).
    await client.query(`DELETE FROM up_permissions WHERE document_id = 'vote-guest'`);
    const rowsBefore = await documentIds();

    expect(await revoke()).toEqual({ links: 0, rows: 0, left: 0 });
    expect(await documentIds()).toEqual(rowsBefore);
  });
});
