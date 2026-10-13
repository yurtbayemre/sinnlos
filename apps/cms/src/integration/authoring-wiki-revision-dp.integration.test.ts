import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PG_URL } from "../database/pg-test-db.test.helper";
import { loadStrapiKnex, type RawKnex } from "../database/strapi-knex.test.helper";
import {
  createTestDatabase,
  createTestStrapi,
  testEngines,
  type TestDatabase,
  type TestStrapi,
} from "./harness.test.helper";
import { untilPoolIdle } from "./pool-idle.test.helper";

/**
 * Wiki revisions without draft & publish (batch 16, lane 16D; decision 06
 * §J4, Migration §2): the boot guard and the one-time migration.
 *
 * Both engines, as org-dp-guard.integration.test.ts: a revision row with
 * published_at NULL makes the boot refuse with the `[revision-dp]` line
 * BEFORE Strapi's draft & publish disable hook could delete it; the row
 * survives, and the boot succeeds once it is gone.
 *
 * Postgres 16 only, the rehearsal of the runbook with the real SQL files
 * run by psql (infra/migrations/wiki-revision-dp/{preflight,migrate}.sql;
 * the probe query of infra/deploy.sh), on a database of its own (migrate.sql
 * refuses while any other session is connected to its database):
 *   1. the first upgrade from a batch-15 database (no batch-16 columns): the
 *      preflight and the migration run on that schema and promote a
 *      draft-only revision; the boot backfills anchors, kinds and the
 *      cutover baseline;
 *   2. the fast path: R0 = 0;
 *   3. a rollback to batch 15.1 and forward: one identical twin per revision
 *      as 15.1's boot makes them (C26: a draft with the same content, its
 *      page link to the page's DRAFT row, the batch-16 columns NULL), and
 *      two edits on 15.1 (before-images, a draft-only page change); a clone
 *      on batch 16 that moved a page's revision links to the copy, and a
 *      discard plus unpublish on 15.1 that left the published revisions of a
 *      page without page links (Codex review, both rounds). The
 *      deploy.sh probe counts the twins (so the deploy is refused), the boot
 *      refuses, the preflight classifies them, migrate.sql refuses outside
 *      one transaction and with another session connected, then deletes
 *      the twins, twice (idempotent); the boot records the 15.1 content as
 *      a baseline; ids, contents, anchors and counts per page match;
 *   4. divergent twins (raw SQL; the panel cannot make one since 15.1):
 *      migrate.sql stops, lists them and changes nothing; the README's two
 *      manual resolutions, run as written, resolve them;
 *   5. an orphan (promoted, counted) and a conflicting anchor (stops).
 * psql: `psql` on PATH with SINNLOS_TEST_PG_URL (CI), or a command prefix in
 * SINNLOS_TEST_PSQL that reaches the same server (e.g. `docker exec -i
 * <container> psql -U sinnlos`); without either the Postgres part is
 * skipped locally and fails in CI.
 */

const PAGE = "api::wiki-page.wiki-page";
const SPACE = "api::wiki-space.wiki-space";

/** Boots per test (a refused boot, a restart, a rehearsal step). */
const BOOT_BUDGET = 180_000;

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SQL_DIR = join(REPO_ROOT, "infra", "migrations", "wiki-revision-dp");
const PREFLIGHT = readFileSync(join(SQL_DIR, "preflight.sql"), "utf8");
const MIGRATE = readFileSync(join(SQL_DIR, "migrate.sql"), "utf8");

/** The probe query infra/deploy.sh runs before the backup (revision_draft_rows). */
/** One fenced SQL statement group of the README, from its `-- Choice n` comment to its COMMIT. */
function readmeBlock(marker: string): string {
  const readme = readFileSync(join(SQL_DIR, "README.md"), "utf8").replace(/\r\n/g, "\n");
  const start = readme.indexOf(marker);
  if (start < 0) throw new Error(`${marker} not found in the README`);
  const end = readme.indexOf("COMMIT;", start) + "COMMIT;".length;
  return `${readme.slice(start, end)}\n`;
}

const DEPLOY_PROBE = (() => {
  const deploy = readFileSync(join(REPO_ROOT, "infra", "deploy.sh"), "utf8").replace(/\r\n/g, "\n");
  const start = deploy.indexOf("\nrevision_draft_rows() {\n");
  const from = deploy.indexOf("<<'SQL'\n", start) + "<<'SQL'\n".length;
  return deploy.slice(from, deploy.indexOf("\nSQL\n", from) + 1);
})();

describe.each(testEngines())("the wiki revision draft guard on %s", (engine) => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase(engine);
    const t = await createTestStrapi({ database, fixtures: false });
    await untilPoolIdle(t);
    await t.stop();
  });

  afterAll(async () => {
    await database?.drop();
  });

  const drafts = async () => {
    const [row] = await database.sql<{ n: number | string }>(
      "SELECT count(*) AS n FROM wiki_revisions WHERE published_at IS NULL",
    );
    return Number(row.n);
  };

  it(
    "refuses to boot while a revision draft row exists, and boots once it is gone",
    async () => {
      await database.sql(
        "INSERT INTO wiki_revisions (document_id, body, published_at) VALUES (?, ?, NULL)",
        ["itrevisiondraft000000000", "a twin of a rollback"],
      );
      expect(await drafts()).toBe(1);
      await expect(createTestStrapi({ database, fixtures: false })).rejects.toThrow(
        /\[revision-dp\] wiki_revisions still holds 1 draft row\(s\)\. Booting would let Strapi delete them/,
      );
      // Refused before Strapi's beforeSync hook could delete the row.
      expect(await drafts()).toBe(1);

      await database.sql("DELETE FROM wiki_revisions WHERE published_at IS NULL");
      const t = await createTestStrapi({ database, fixtures: false });
      await untilPoolIdle(t);
      await t.stop();
    },
    BOOT_BUDGET,
  );
});

// ---------------------------------------------------------------------------
// The rehearsal on Postgres 16.

const PSQL_PREFIX = (process.env.SINNLOS_TEST_PSQL ?? "").trim();

/** The psql command for `database`, or null when there is none. */
function psqlCommand(databaseName: string): string[] | null {
  if (!PG_URL) return null;
  if (PSQL_PREFIX) return [...PSQL_PREFIX.split(/\s+/), "-d", databaseName];
  const url = new URL(PG_URL);
  url.pathname = `/${databaseName}`;
  return ["psql", url.toString()];
}

const PSQL_READY = (() => {
  const command = psqlCommand("postgres");
  if (!command) return false;
  const res = spawnSync(command[0], [...command.slice(1), "--version"], { encoding: "utf8" });
  return res.status === 0;
})();

if (PG_URL && !PSQL_READY && process.env.CI) {
  throw new Error(
    "[integration] the wiki-revision-dp rehearsal needs psql in CI (or SINNLOS_TEST_PSQL)",
  );
}

interface PsqlRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe.skipIf(!PG_URL || !PSQL_READY)(
  "the wiki-revision-dp migration on Postgres 16 (a rehearsal with the real SQL files)",
  () => {
    const name = `sinnlos_revdp_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    const dbUrl = (() => {
      const url = new URL(PG_URL);
      url.pathname = `/${name}`;
      return url.toString();
    })();
    const admin: RawKnex = loadStrapiKnex()({
      client: "pg",
      connection: { connectionString: PG_URL, options: "-c TimeZone=UTC" },
      pool: { min: 0, max: 1 },
    });

    /** Raw SQL on the rehearsal database, on a connection closed right after. */
    async function sql<T = Record<string, unknown>>(
      statement: string,
      bindings: readonly unknown[] = [],
    ): Promise<T[]> {
      const knex = loadStrapiKnex()({
        client: "pg",
        connection: { connectionString: dbUrl, options: "-c TimeZone=UTC" },
        pool: { min: 0, max: 1 },
      });
      try {
        const result = (await knex.raw(statement, bindings)) as { rows?: T[] };
        return result.rows ?? [];
      } finally {
        await knex.destroy();
      }
    }

    const database: TestDatabase = {
      engine: "postgres",
      env: {
        DATABASE_CLIENT: "postgres",
        DATABASE_URL: dbUrl,
        DATABASE_SCHEMA: "public",
        DATABASE_POOL_MIN: "0",
        DATABASE_POOL_MAX: "5",
      },
      sql,
      async drop() {
        // The database itself goes in afterAll.
      },
    };

    /** Waits until no other client session is connected to the rehearsal database. */
    async function sessionsGone(): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = (await admin.raw(
          "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = ? AND backend_type = 'client backend'",
          [name],
        )) as { rows: Array<{ n: string }> };
        if (Number(result.rows[0].n) === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("sessions on the rehearsal database did not end");
    }

    function psql(script: string, args: string[] = []): PsqlRun {
      const command = psqlCommand(name) as string[];
      const res = spawnSync(
        command[0],
        [...command.slice(1), "-X", "-v", "ON_ERROR_STOP=1", ...args],
        { input: script, encoding: "utf8" },
      );
      return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
    }

    async function migrate(args: string[] = ["--single-transaction"]): Promise<PsqlRun> {
      await sessionsGone();
      return psql(MIGRATE, args);
    }

    /** The rows of one preflight section (after its "== <tag>" header, notes left out). */
    function preflight(): (tag: string) => string[] {
      const run = psql(PREFLIGHT, ["-q", "-A", "-t", "-F", "|"]);
      expect(run.status, run.stderr).toBe(0);
      const lines = run.stdout.replace(/\r\n/g, "\n").split("\n");
      return (tag) => {
        const start = lines.findIndex((line) => line.startsWith(`== ${tag} `));
        expect(start, `preflight section ${tag}`).toBeGreaterThanOrEqual(0);
        const out: string[] = [];
        for (const line of lines.slice(start + 1)) {
          if (line.startsWith("== ")) break;
          if (line === "" || line.startsWith("   ")) continue;
          out.push(line);
        }
        return out;
      };
    }

    const okLine = (run: PsqlRun) =>
      /NOTICE: {2}(revision-dp: OK - promoted=\d+, twins_deleted=\d+, orphans=\d+)/.exec(
        run.stderr,
      )?.[1];

    const count = async (where: string) => {
      const [row] = await sql<{ n: string }>(`SELECT count(*) AS n FROM wiki_revisions ${where}`);
      return Number(row.n);
    };

    /** Every revision: id, document, anchor, kind and content. */
    const snapshot = () =>
      sql<Record<string, unknown>>(
        `SELECT id, document_id, page_document_id, kind, title, body, page_summary, summary
           FROM wiki_revisions ORDER BY id`,
      );

    const pageRows = (documentId: string) =>
      sql<{ id: number; published_at: unknown; body: string }>(
        "SELECT id, published_at, body FROM wiki_pages WHERE document_id = ? ORDER BY id",
        [documentId],
      );
    const draftRowOf = async (documentId: string) =>
      (await pageRows(documentId)).find((row) => row.published_at === null)?.id as number;

    /** A revision row as batch 15.1's lifecycle writes it: the body before an edit, published. */
    async function beforeImage(pageDocumentId: string, body: string, editorId: number) {
      const [row] = await sql<{ id: number }>(
        `INSERT INTO wiki_revisions (document_id, body, summary, created_at, updated_at, published_at)
         VALUES (?, ?, NULL, now(), now(), now()) RETURNING id`,
        [`b151${Math.random().toString(36).slice(2, 12).padEnd(20, "0")}`, body],
      );
      await sql(
        "INSERT INTO wiki_revisions_page_lnk (wiki_revision_id, wiki_page_id, wiki_revision_ord) VALUES (?, ?, 1)",
        [row.id, await draftRowOf(pageDocumentId)],
      );
      await sql("INSERT INTO wiki_revisions_editor_lnk (wiki_revision_id, user_id) VALUES (?, ?)", [
        row.id,
        editorId,
      ]);
      return row.id;
    }

    /**
     * What batch 15.1's first boot does to every revision (C26, pinned in
     * framework-contract.test.ts): discardDraft through the old model, so a
     * draft row with the same document_id and content, its page link
     * re-resolved to the page's DRAFT row, the same editor, and NULL in
     * every column the old model does not know.
     */
    async function rollbackTwins(): Promise<number> {
      const published = await sql<{ id: number; document_id: string }>(
        "SELECT id, document_id FROM wiki_revisions WHERE published_at IS NOT NULL ORDER BY id",
      );
      for (const source of published) {
        const [twin] = await sql<{ id: number }>(
          `INSERT INTO wiki_revisions (document_id, body, summary, created_at, updated_at, published_at,
                                       created_by_id, updated_by_id, locale)
           SELECT document_id, body, summary, created_at, updated_at, NULL, created_by_id, updated_by_id, locale
             FROM wiki_revisions WHERE id = ? RETURNING id`,
          [source.id],
        );
        await sql(
          `INSERT INTO wiki_revisions_page_lnk (wiki_revision_id, wiki_page_id, wiki_revision_ord)
           SELECT DISTINCT ?::int, d.id, 1
             FROM wiki_revisions_page_lnk l
             JOIN wiki_pages p ON p.id = l.wiki_page_id
             JOIN wiki_pages d ON d.document_id = p.document_id AND d.published_at IS NULL
            WHERE l.wiki_revision_id = ?`,
          [twin.id, source.id],
        );
        await sql(
          `INSERT INTO wiki_revisions_editor_lnk (wiki_revision_id, user_id)
           SELECT ?::int, user_id FROM wiki_revisions_editor_lnk WHERE wiki_revision_id = ?`,
          [twin.id, source.id],
        );
      }
      return published.length;
    }

    /**
     * The bookkeeping a release before batch 16 leaves: Strapi's stored
     * content-type schemas say wiki-revision has draft & publish, so the next
     * batch-16 boot runs the real disable hook (DELETE ... WHERE published_at
     * IS NULL in beforeSync, after the guard); `forgetSchema` also drops the
     * stored database schema, as on a database that never ran batch 16 (its
     * sync then adds the batch-16 columns).
     */
    async function asBeforeBatch16({ forgetSchema }: { forgetSchema: boolean }) {
      const [stored] = await sql<{ value: string }>(
        "SELECT value FROM strapi_core_store_settings WHERE key = 'strapi_content_types_schema'",
      );
      const types = JSON.parse(stored.value) as Record<
        string,
        { options?: { draftAndPublish?: boolean } }
      >;
      const revision = types["api::wiki-revision.wiki-revision"];
      expect(revision?.options?.draftAndPublish).toBe(false);
      revision.options = { ...revision.options, draftAndPublish: true };
      await sql(
        "UPDATE strapi_core_store_settings SET value = ? WHERE key = 'strapi_content_types_schema'",
        [JSON.stringify(types)],
      );
      if (forgetSchema) await sql("DELETE FROM strapi_database_schema");
    }

    let t: TestStrapi | null = null;
    const boot = async () => {
      await sessionsGone();
      t = await createTestStrapi({ database, fixtures: false });
      return t;
    };
    const stop = async () => {
      if (t) await untilPoolIdle(t);
      await t?.stop();
      t = null;
    };

    let pageOne = "";
    let pageTwo = "";
    let editorId = 0;

    beforeAll(async () => {
      await admin.raw(`CREATE DATABASE "${name}"`);
      // The schema of batch 16, the fixtures, two pages with history.
      const first = await createTestStrapi({ database });
      editorId = first.fixtures.users.editor.id;
      const docs = (uid: string) => first.strapi.documents(uid);
      const space = await docs(SPACE).create({
        data: { name: "IT Rehearsal Space", slug: "it-rehearsal-space", visibility: "public" },
        status: "published",
      });
      const one = await docs(PAGE).create({
        data: { title: "One", slug: "it-one", body: "v1", space: space.documentId },
        status: "published",
      });
      await docs(PAGE).update({ documentId: one.documentId, data: { body: "v2" } });
      await docs(PAGE).publish({ documentId: one.documentId });
      await docs(PAGE).update({ documentId: one.documentId, data: { body: "v3 (draft)" } });
      const two = await docs(PAGE).create({
        data: { title: "Two", slug: "it-two", body: "w1", space: space.documentId },
        status: "published",
      });
      pageOne = one.documentId;
      pageTwo = two.documentId;
      await untilPoolIdle(first);
      await first.stop();
    }, BOOT_BUDGET);

    afterAll(async () => {
      await stop();
      try {
        await admin.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await admin.destroy();
      }
    });

    it(
      "1. the first upgrade from batch 15 (no batch-16 columns): a draft-only revision is promoted, then the backfill runs",
      async () => {
        // The database of batch 15: without the batch-16 columns, every row a
        // before-image; and a revision draft the panel made before 15.1 hid it.
        await sql(
          `ALTER TABLE wiki_revisions DROP COLUMN page_document_id, DROP COLUMN title,
             DROP COLUMN page_summary, DROP COLUMN kind, DROP COLUMN admin_editor_id,
             DROP COLUMN restored_from`,
        );
        await asBeforeBatch16({ forgetSchema: true });
        const [panelDraft] = await sql<{ id: number }>(
          `INSERT INTO wiki_revisions (document_id, body, created_at, updated_at, published_at)
           VALUES ('itpaneldraft000000000000', 'made in the panel', now(), now(), NULL) RETURNING id`,
        );
        await sql(
          "INSERT INTO wiki_revisions_page_lnk (wiki_revision_id, wiki_page_id, wiki_revision_ord) VALUES (?, ?, 1)",
          [panelDraft.id, await draftRowOf(pageOne)],
        );
        const before = await count("");

        const section = preflight();
        expect(section("R0")).toEqual([`1|${before - 1}|${before}`]);
        expect(section("R1")).toEqual(["draft-only|1"]);
        expect(section("R2")).toEqual([`one|${before}`]);
        expect(section("R4")).toEqual([]);

        const run = await migrate();
        expect(run.status, run.stderr).toBe(0);
        expect(okLine(run)).toBe("revision-dp: OK - promoted=1, twins_deleted=0, orphans=0");
        expect(await count("WHERE published_at IS NULL")).toBe(0);

        // The boot of batch 16: Strapi's disable hook finds nothing to delete,
        // the sync adds the columns, the backfill fills them.
        await boot();
        await stop();
        expect(await count("WHERE kind <> 'baseline'")).toBe(before);
        expect(await count("WHERE page_document_id IS NULL")).toBe(0);
        expect(await count("WHERE kind IS NULL")).toBe(0);
        expect(await count(`WHERE kind = 'before'`)).toBe(before);
        // One baseline per page state no after/baseline row holds: One's
        // draft and published bodies differ, Two's are equal.
        const baselines = await sql<{ page_document_id: string; body: string }>(
          "SELECT page_document_id, body FROM wiki_revisions WHERE kind = 'baseline' ORDER BY id",
        );
        expect(baselines).toEqual(
          expect.arrayContaining([
            { page_document_id: pageOne, body: "v2" },
            { page_document_id: pageOne, body: "v3 (draft)" },
            { page_document_id: pageTwo, body: "w1" },
          ]),
        );
        expect(baselines).toHaveLength(3);
      },
      BOOT_BUDGET,
    );

    it("2. the fast path: R0 = 0, and the deploy.sh probe counts no draft row", async () => {
      const section = preflight();
      const [r0] = section("R0");
      expect(r0.split("|")[0]).toBe("0");
      expect(section("R1")).toEqual([]);
      const probe = psql(DEPLOY_PROBE, ["-q", "-t", "-A"]);
      expect(probe.status, probe.stderr).toBe(0);
      expect(probe.stdout.trim()).toBe("0");
    });

    let beforeRollback: Record<string, unknown>[] = [];
    let twins = 0;
    let editsOn151: number[] = [];

    it(
      "3a. a rollback to 15.1: its twins make deploy.sh's probe refuse and the boot refuse",
      async () => {
        // On batch 16, a panel-style clone of Two: Strapi 5.57 moves the page
        // links of Two's revisions to the copy, their anchors stay (Codex
        // review, round 2). Their twins then link the copy.
        const live = await boot();
        const pages = live.strapi.documents(PAGE) as unknown as {
          clone(params: Record<string, unknown>): Promise<{ documentId: string }>;
        };
        const copy = await pages.clone({
          documentId: pageTwo,
          data: { title: "Two (copy)", slug: "it-two-copy" },
        });
        await stop();
        const [moved] = await sql<{ n: string }>(
          `SELECT count(*) AS n FROM wiki_revisions r
             JOIN wiki_revisions_page_lnk l ON l.wiki_revision_id = r.id
             JOIN wiki_pages p ON p.id = l.wiki_page_id
            WHERE r.page_document_id = ? AND p.document_id = ?`,
          [pageTwo, copy.documentId],
        );
        expect(Number(moved.n)).toBeGreaterThan(0);

        beforeRollback = await snapshot();
        await asBeforeBatch16({ forgetSchema: false });
        twins = await rollbackTwins();
        expect(twins).toBe(beforeRollback.length);
        // A discard and an unpublish of One on 15.1 (Codex review): its
        // published revisions lose their page links while their twins keep
        // the link to One's draft. And a twin whose page link went (its page
        // row was deleted). Both stay identical twins: the published row's
        // anchor is its page_document_id, and a twin without a page link
        // differs in nothing that is kept.
        await sql(
          `DELETE FROM wiki_revisions_page_lnk WHERE wiki_revision_id IN
             (SELECT id FROM wiki_revisions WHERE published_at IS NOT NULL AND page_document_id = ?)`,
          [pageOne],
        );
        await sql(
          `DELETE FROM wiki_revisions_page_lnk WHERE wiki_revision_id =
             (SELECT min(id) FROM wiki_revisions WHERE published_at IS NULL)`,
        );
        // Two edits on 15.1: a draft-only change of Two, each with its before-image.
        const twoDraft = await draftRowOf(pageTwo);
        editsOn151 = [await beforeImage(pageTwo, "w1", editorId)];
        await sql("UPDATE wiki_pages SET body = 'w2 (on 15.1)' WHERE id = ?", [twoDraft]);
        editsOn151.push(await beforeImage(pageTwo, "w2 (on 15.1)", editorId));
        await sql("UPDATE wiki_pages SET body = 'w3 (on 15.1)' WHERE id = ?", [twoDraft]);

        const probe = psql(DEPLOY_PROBE, ["-q", "-t", "-A"]);
        expect(probe.status, probe.stderr).toBe(0);
        expect(probe.stdout.trim()).toBe(String(twins));

        await sessionsGone();
        await expect(createTestStrapi({ database, fixtures: false })).rejects.toThrow(
          `[revision-dp] wiki_revisions still holds ${twins} draft row(s)`,
        );
        expect(await count("WHERE published_at IS NULL")).toBe(twins);
      },
      BOOT_BUDGET,
    );

    it("3b. the preflight lists one identical twin per revision and the 15.1 rows as plain published rows", () => {
      const section = preflight();
      const published = beforeRollback.length + editsOn151.length;
      expect(section("R0")).toEqual([`${twins}|${published}|${published}`]);
      expect(section("R1")).toEqual([`identical twin|${twins}`]);
      expect(section("R2")).toEqual([`one|${published}`]);
      expect(section("R4")).toEqual([]);
      const perPage = section("R3");
      expect(perPage).toEqual(
        expect.arrayContaining([expect.stringMatching(new RegExp(`^${pageTwo}\\|Two\\|`))]),
      );
    });

    it("3c. migrate.sql refuses outside one transaction and while another session is connected", async () => {
      const loose = await migrate([]);
      expect(loose.status).not.toBe(0);
      expect(loose.stderr).toContain("revision-dp: not inside one transaction");
      expect(await count("WHERE published_at IS NULL")).toBe(twins);

      const other = loadStrapiKnex()({
        client: "pg",
        connection: { connectionString: dbUrl },
        pool: { min: 1, max: 1 },
      });
      try {
        await other.raw("SELECT 1");
        const busy = psql(MIGRATE, ["--single-transaction"]);
        expect(busy.status).not.toBe(0);
        expect(busy.stderr).toMatch(/revision-dp: \d+ other session\(s\) are connected/);
      } finally {
        await other.destroy();
      }
      expect(await count("WHERE published_at IS NULL")).toBe(twins);
    });

    it(
      "3d. migrate.sql deletes the twins, twice; the boot records the 15.1 content as a baseline; ids, contents and anchors match",
      async () => {
        const run = await migrate();
        expect(run.status, run.stderr).toBe(0);
        expect(okLine(run)).toBe(`revision-dp: OK - promoted=0, twins_deleted=${twins}, orphans=0`);
        const again = await migrate();
        expect(again.status, again.stderr).toBe(0);
        expect(okLine(again)).toBe("revision-dp: OK - promoted=0, twins_deleted=0, orphans=0");
        expect(await count("WHERE published_at IS NULL")).toBe(0);

        await boot();
        await stop();
        const after = await snapshot();
        // Every revision from before the rollback is unchanged, id for id.
        expect(after.slice(0, beforeRollback.length)).toEqual(beforeRollback);
        const added = after.slice(beforeRollback.length);
        // The two before-images of 15.1, anchored and marked, then the baseline
        // of the content 15.1 wrote (Two's draft).
        expect(added.map((row) => [row.id, row.kind, row.page_document_id, row.body])).toEqual([
          [editsOn151[0], "before", pageTwo, "w1"],
          [editsOn151[1], "before", pageTwo, "w2 (on 15.1)"],
          [expect.any(Number), "baseline", pageTwo, "w3 (on 15.1)"],
        ]);
        const perPage = await sql<{ page_document_id: string; n: string }>(
          "SELECT page_document_id, count(*) AS n FROM wiki_revisions GROUP BY 1 ORDER BY 1",
        );
        const expected: Record<string, number> = {};
        for (const row of beforeRollback) {
          const page = String(row.page_document_id);
          expected[page] = (expected[page] ?? 0) + 1;
        }
        expected[pageTwo] += 3;
        expect(
          Object.fromEntries(perPage.map((row) => [row.page_document_id, Number(row.n)])),
        ).toEqual(expected);
      },
      BOOT_BUDGET,
    );

    it("4. divergent twins stop migrate.sql, which changes nothing; the README's two resolutions work", async () => {
      const sources = await sql<{ id: number; document_id: string }>(
        `SELECT id, document_id FROM wiki_revisions r
          WHERE EXISTS (SELECT 1 FROM wiki_revisions_page_lnk l WHERE l.wiki_revision_id = r.id)
          ORDER BY id LIMIT 2`,
      );
      const twins: number[] = [];
      for (const [index, source] of sources.entries()) {
        const [twin] = await sql<{ id: number }>(
          `INSERT INTO wiki_revisions (document_id, body, created_at, updated_at, published_at)
           VALUES (?, ?, now(), now(), NULL) RETURNING id`,
          [source.document_id, `edited by raw SQL ${index}`],
        );
        await sql(
          `INSERT INTO wiki_revisions_page_lnk (wiki_revision_id, wiki_page_id, wiki_revision_ord)
           SELECT ?::int, wiki_page_id, 1 FROM wiki_revisions_page_lnk WHERE wiki_revision_id = ?`,
          [twin.id, source.id],
        );
        twins.push(twin.id);
      }
      // A twin with the same content, moved by raw SQL to a page its
      // published row has nothing to do with: still divergent.
      const [anchored] = await sql<{ id: number; document_id: string; body: string }>(
        `SELECT id, document_id, body FROM wiki_revisions
          WHERE page_document_id = ? AND published_at IS NOT NULL ORDER BY id LIMIT 1`,
        [pageOne],
      );
      const [moved] = await sql<{ id: number }>(
        `INSERT INTO wiki_revisions (document_id, body, summary, created_at, updated_at, published_at)
         SELECT document_id, body, summary, created_at, updated_at, NULL FROM wiki_revisions WHERE id = ?
         RETURNING id`,
        [anchored.id],
      );
      await sql(
        "INSERT INTO wiki_revisions_page_lnk (wiki_revision_id, wiki_page_id, wiki_revision_ord) VALUES (?, ?, 1)",
        [moved.id, await draftRowOf(pageTwo)],
      );
      await sql(
        `INSERT INTO wiki_revisions_editor_lnk (wiki_revision_id, user_id)
         SELECT ?::int, user_id FROM wiki_revisions_editor_lnk WHERE wiki_revision_id = ?`,
        [moved.id, anchored.id],
      );
      const before = await snapshot();
      const section = preflight();
      expect(section("R1")).toEqual(["divergent twin|3"]);

      const stopped = await migrate();
      expect(stopped.status).not.toBe(0);
      expect(stopped.stderr).toContain("revision-dp: divergent twin(s) (preflight R1)");
      for (const [index, twin] of twins.entries()) {
        expect(stopped.stderr).toContain(
          `id ${twin} (document ${sources[index].document_id}, differs in body`,
        );
      }
      expect(stopped.stderr).toContain(
        `id ${moved.id} (document ${anchored.document_id}, differs in page)`,
      );
      expect(await snapshot()).toEqual(before);

      // The README's SQL, as the operator runs it: choice 1 for the first, choice 2 for the second.
      const run = (block: string, id: number) => {
        const res = psql(block.replace(/<draft id>/g, String(id)));
        expect(res.status, res.stderr).toBe(0);
      };
      await sessionsGone();
      run(readmeBlock("-- Choice 1"), twins[0]);
      run(readmeBlock("-- Choice 2"), twins[1]);
      run(readmeBlock("-- Choice 1"), moved.id);
      const kept = await sql<{ document_id: string; published: boolean; page: number | null }>(
        `SELECT r.document_id, r.published_at IS NOT NULL AS published,
                (SELECT count(*)::int FROM wiki_revisions_page_lnk l WHERE l.wiki_revision_id = r.id) AS page
           FROM wiki_revisions r WHERE r.body = 'edited by raw SQL 1'`,
      );
      expect(kept).toEqual([
        {
          document_id: expect.stringMatching(/^r[0-9a-f]{23}$/),
          published: true,
          page: expect.any(Number),
        },
      ]);
      expect(kept[0].page).toBeGreaterThan(0);
      expect(await count("WHERE body = 'edited by raw SQL 0'")).toBe(0);
      expect(await count("WHERE published_at IS NULL")).toBe(0);
      const ok = await migrate();
      expect(ok.status, ok.stderr).toBe(0);
      expect(okLine(ok)).toBe("revision-dp: OK - promoted=0, twins_deleted=0, orphans=0");
    });

    it(
      "5. an orphan is promoted and counted; a conflicting anchor stops migrate.sql",
      async () => {
        await sql(
          `INSERT INTO wiki_revisions (document_id, body, created_at, updated_at, published_at)
           VALUES ('itorphan0000000000000000', 'its page was deleted', now(), now(), NULL)`,
        );
        const [conflict] = await sql<{ id: number }>(
          `INSERT INTO wiki_revisions (document_id, body, created_at, updated_at, published_at)
           VALUES ('itconflict00000000000000', 'two pages', now(), now(), now()) RETURNING id`,
        );
        for (const page of [pageOne, pageTwo]) {
          await sql(
            "INSERT INTO wiki_revisions_page_lnk (wiki_revision_id, wiki_page_id, wiki_revision_ord) VALUES (?, ?, 1)",
            [conflict.id, await draftRowOf(page)],
          );
        }
        const section = preflight();
        expect(section("R2")).toEqual(
          expect.arrayContaining(["none (orphan)|1", "several (CONFLICT)|1"]),
        );
        const stopped = await migrate();
        expect(stopped.status).not.toBe(0);
        expect(stopped.stderr).toContain(
          "revision-dp: revision document(s) anchored to more than one page (preflight R2)",
        );
        expect(stopped.stderr).toContain("itconflict00000000000000 -> ");
        expect(await count("WHERE published_at IS NULL")).toBe(1);

        await sql(
          "DELETE FROM wiki_revisions_page_lnk WHERE wiki_revision_id = ? AND wiki_page_id = ?",
          [conflict.id, await draftRowOf(pageTwo)],
        );
        const run = await migrate();
        expect(run.status, run.stderr).toBe(0);
        expect(okLine(run)).toBe("revision-dp: OK - promoted=1, twins_deleted=0, orphans=1");

        // The boot anchors the conflict's remaining link, and leaves the orphan unanchored.
        await boot();
        await stop();
        const [orphan] = await sql<{ page_document_id: string | null; kind: string }>(
          "SELECT page_document_id, kind FROM wiki_revisions WHERE document_id = 'itorphan0000000000000000'",
        );
        expect(orphan).toEqual({ page_document_id: null, kind: "before" });
        const [fixed] = await sql<{ page_document_id: string }>(
          "SELECT page_document_id FROM wiki_revisions WHERE id = ?",
          [conflict.id],
        );
        expect(fixed.page_document_id).toBe(pageOne);
      },
      BOOT_BUDGET,
    );
  },
);
