/**
 * Post-commit side effects (LF02) against Strapi's real query engine
 * (@strapi/database 5.55.1): on SQLite always, on Postgres 16 with
 * SINNLOS_TEST_PG_URL set (CI job `postgres`; locally a throwaway
 * container, docs/DEPLOYMENT.md "Datetime contract").
 *
 * Pinned, with the real transaction context and lifecycles provider:
 *  - a fan-out scheduled inside the publish transaction writes nothing
 *    before the commit and everything after it; the live pings follow each
 *    row's commit; a rollback writes and pings nothing;
 *  - a failing notification INSERT (a lifecycle error on both engines, a
 *    real 22001 on Postgres) fails that row only: the publish is committed
 *    and the other recipients are notified;
 *  - Postgres only: the pre-LF02 pattern, an INSERT that fails INSIDE the
 *    publish transaction behind a try/catch, still aborts the publish
 *    (25P02) — the reason the fan-out moved after the commit;
 *  - the @strapi/database quirk afterCommit guards against: a transaction
 *    started after a commit in the same async context inherits the finished
 *    transaction's callback list, so sibling commits run earlier callbacks
 *    again (the raw count), while afterCommit's tasks run once each;
 *  - Postgres only: a failure AT COMMIT (deferred constraint) resolves the
 *    transaction and runs the commit callbacks anyway (knex 3.0.1), which is
 *    why post-commit tasks re-read committed state.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PG_URL, createTestKnex, uniqueSchema } from "../database/pg-test-db.test.helper";
import { type RawKnex } from "../database/strapi-knex.test.helper";
import { loadDatabase, openSqliteEngine } from "../test/sqlite-engine.test.helper";
import { afterCommit } from "./after-commit";
import {
  __flushLiveEventsForTest,
  registerLiveEventSubscriber,
  type LiveEvent,
} from "./live-events";
import {
  __fanoutsSettledForTest,
  buildNotification,
  scheduleSourceFanout,
  writeNotifications,
  type NotifyStrapi,
} from "./notify";

const USER_UID = "plugin::users-permissions.user";
const ANNOUNCEMENT_UID = "api::announcement.announcement";
const NOTIFICATION_UID = "api::notification.notification";

const MODELS = [
  {
    uid: USER_UID,
    singularName: "user",
    tableName: "up_users",
    attributes: {
      id: { type: "increments" },
      username: { type: "string" },
    },
  },
  {
    uid: ANNOUNCEMENT_UID,
    singularName: "announcement",
    tableName: "announcements",
    attributes: {
      id: { type: "increments" },
      documentId: { type: "string" },
      title: { type: "string" },
      publishedAt: { type: "datetime" },
    },
  },
  {
    uid: NOTIFICATION_UID,
    singularName: "notification",
    tableName: "notifications",
    attributes: {
      id: { type: "increments" },
      type: { type: "string" },
      title: { type: "string" },
      link: { type: "string" },
      sourceType: { type: "string" },
      sourceDocumentId: { type: "string" },
      recipient: { type: "relation", relation: "manyToOne", target: USER_UID },
      actor: { type: "relation", relation: "manyToOne", target: USER_UID },
    },
  },
];

type Row = Record<string, unknown>;

/** The engine calls this suite makes (@strapi/database 5.55.1 Database). */
interface Engine {
  query(uid: string): {
    create(params: { data: Row }): Promise<Row>;
    findOne(params: Record<string, unknown>): Promise<Row | null>;
    findMany(params: Record<string, unknown>): Promise<Row[]>;
    count(params?: Record<string, unknown>): Promise<number>;
  };
  inTransaction(): boolean;
  transaction(
    callback: (scope: {
      onCommit: (fn: () => unknown) => void;
      onRollback: (fn: () => unknown) => void;
    }) => unknown,
  ): Promise<unknown>;
  lifecycles: { subscribe(subscriber: unknown): () => void };
  destroy(): Promise<void>;
}

interface Opened {
  engine: Engine;
  /** Raw SQL on the test schema (Postgres only). */
  sql?: (text: string) => Promise<unknown>;
  schema?: string;
  close(): Promise<void>;
}

const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

async function openSqlite(): Promise<Opened> {
  const opened = await openSqliteEngine(MODELS);
  return { engine: opened.db as unknown as Engine, close: () => opened.close() };
}

async function openPostgres(): Promise<Opened> {
  const knex: RawKnex = createTestKnex();
  const schema = uniqueSchema("after_commit");
  await knex.raw(`CREATE SCHEMA "${schema}"`);
  const dir = mkdtempSync(join(tmpdir(), "sinnlos-after-commit-"));
  const Database = loadDatabase();
  const db = new Database({
    connection: {
      client: "postgres",
      connection: { connectionString: PG_URL, options: "-c TimeZone=UTC", schema },
      pool: { min: 0, max: 4 },
    },
    settings: { migrations: { dir }, forceMigration: false },
    logger: quiet,
  });
  await db.init({ models: MODELS });
  await db.schema.create();
  vi.stubGlobal("strapi", { db });
  return {
    engine: db as unknown as Engine,
    sql: (text) => knex.raw(text),
    schema,
    async close() {
      await db.destroy();
      vi.unstubAllGlobals();
      await knex.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await knex.destroy();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const fetchMock = vi.fn();

function suite(name: string, open: () => Promise<Opened>, postgres: boolean) {
  describe(name, () => {
    let opened: Opened;
    let engine: Engine;
    let host: NotifyStrapi;
    const errors: string[] = [];

    beforeEach(async () => {
      vi.stubGlobal("fetch", fetchMock);
      fetchMock.mockReset();
      fetchMock.mockResolvedValue({ ok: true, status: 204 });
      process.env.WEB_INTERNAL_URL = "http://web:3000";
      process.env.REVALIDATE_SECRET = "test-secret";
      delete process.env.LIVE_EVENTS_DISABLED;
      errors.length = 0;

      opened = await open();
      engine = opened.engine;
      const log = {
        info: () => undefined,
        warn: (message: string) => errors.push(message),
        error: (message: string) => errors.push(message),
      };
      host = { db: engine, log } as unknown as NotifyStrapi;
      registerLiveEventSubscriber({
        db: engine,
        log,
      } as unknown as Parameters<typeof registerLiveEventSubscriber>[0]);
      for (const username of ["ada", "grace", "linus"]) {
        await engine.query(USER_UID).create({ data: { username } });
      }
    }, 30_000);

    afterEach(async () => {
      await __fanoutsSettledForTest();
      await __flushLiveEventsForTest();
      await opened.close();
      delete process.env.WEB_INTERNAL_URL;
      delete process.env.REVALIDATE_SECRET;
    });

    /** Flushes the live batch and returns every event POSTed so far. */
    const pings = async (): Promise<LiveEvent[]> => {
      await __flushLiveEventsForTest();
      return fetchMock.mock.calls.flatMap(
        ([, init]) =>
          (JSON.parse((init as { body: string }).body) as { events: LiveEvent[] }).events,
      );
    };

    const notificationCount = () => engine.query(NOTIFICATION_UID).count();

    /** A publish: the published row created and its fan-out scheduled, in one transaction. */
    async function publish(title: string, afterSchedule?: () => Promise<void>) {
      let published: Row | null = null;
      await engine.transaction(async () => {
        published = await engine.query(ANNOUNCEMENT_UID).create({
          data: { documentId: `doc-${title}`, title, publishedAt: new Date().toISOString() },
        });
        const row = published;
        await scheduleSourceFanout({
          strapi: host,
          sourceType: "announcement",
          row,
          loadAudience: async () => ({ source: row, recipients: [1, 2, 3], actorId: null }),
          titleParts: () => ["New announcement: ", { value: title, fallback: "Untitled" }],
          link: "/announcements",
        });
        await afterSchedule?.();
      });
      await __fanoutsSettledForTest();
      return published;
    }

    it("writes nothing before the commit, everything after it, then pings", async () => {
      let before = -1;
      await publish("Town hall", async () => {
        before = await notificationCount();
        expect(await pings()).toEqual([]);
      });
      expect(before).toBe(0);
      expect(await notificationCount()).toBe(3);
      const rows = await engine.query(NOTIFICATION_UID).findMany({
        populate: { recipient: { select: ["id"] } },
        orderBy: { id: "asc" },
      });
      expect(rows.map((row) => (row.recipient as { id: number }).id)).toEqual([1, 2, 3]);
      // The list ping from the publish's own commit, then one per row.
      expect(await pings()).toEqual([
        { kind: "announcements" },
        ...[1, 2, 3].map((recipientId) => ({ kind: "notification", recipientId })),
      ]);
      expect(errors).toEqual([]);
    }, 30_000);

    it("a rolled back publish writes and pings nothing", async () => {
      await expect(
        engine.transaction(async () => {
          const row = await engine.query(ANNOUNCEMENT_UID).create({
            data: { documentId: "doc-x", title: "x", publishedAt: new Date().toISOString() },
          });
          await scheduleSourceFanout({
            strapi: host,
            sourceType: "announcement",
            row,
            loadAudience: async () => ({ source: row, recipients: [1, 2, 3], actorId: null }),
            titleParts: () => ["x"],
            link: "/announcements",
          });
          throw new Error("relation sync failed");
        }),
      ).rejects.toThrow("relation sync failed");
      await __fanoutsSettledForTest();
      expect(await engine.query(ANNOUNCEMENT_UID).count()).toBe(0);
      expect(await notificationCount()).toBe(0);
      expect(await pings()).toEqual([]);
    }, 30_000);

    it("a failing INSERT fails that row only; the publish stays committed", async () => {
      const unsubscribe = engine.lifecycles.subscribe({
        models: [NOTIFICATION_UID],
        beforeCreate(event: { params: { data: Row } }) {
          if (event.params.data.recipient === 2) throw new Error("row 2 refused");
        },
      });
      try {
        await publish("Rota");
      } finally {
        unsubscribe();
      }
      expect(await engine.query(ANNOUNCEMENT_UID).count()).toBe(1);
      const rows = await engine.query(NOTIFICATION_UID).findMany({
        populate: { recipient: { select: ["id"] } },
        orderBy: { id: "asc" },
      });
      expect(rows.map((row) => (row.recipient as { id: number }).id)).toEqual([1, 3]);
      expect(errors).toEqual([
        expect.stringContaining("could not create the notification for user 2"),
      ]);
    }, 30_000);

    it("afterCommit tasks run once although @strapi/database re-runs sibling callbacks", async () => {
      let raw = 0;
      let guarded = 0;
      await engine.transaction(async ({ onCommit }) => {
        onCommit(async () => {
          for (let i = 0; i < 3; i += 1) {
            await engine.transaction(async ({ onCommit: inner }) => {
              inner(() => {
                raw += 1;
              });
              await afterCommit(
                engine,
                () => {
                  guarded += 1;
                },
                () => undefined,
              );
            });
          }
        });
      });
      await vi.waitFor(() => expect(guarded).toBe(3));
      // Sibling i's commit runs the callbacks of siblings 0..i: 1 + 2 + 3.
      expect(raw).toBe(6);
      expect(guarded).toBe(3);
    }, 30_000);

    it("a nested transaction defers the task to the OUTER commit", async () => {
      const task = vi.fn();
      await engine.transaction(async () => {
        await engine.transaction(async () => {
          await afterCommit(engine, task, () => undefined);
        });
        expect(task).not.toHaveBeenCalled();
      });
      await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(1));
    }, 30_000);

    if (postgres) {
      it("Postgres: an overlong value fails its own row only (22001)", async () => {
        const rows = [1, 2, 3].map((recipient) => ({
          ...buildNotification({
            type: "announcement",
            titleParts: ["New announcement: x"],
            link: "/announcements",
            recipient,
          }),
          ...(recipient === 2 ? { link: "l".repeat(300) } : {}),
        }));
        await expect(writeNotifications(host, rows, "announcement 1 (source d)")).resolves.toBe(2);
        expect(errors).toEqual([expect.stringContaining("value too long")]);
        expect(await notificationCount()).toBe(2);
      }, 30_000);

      it("Postgres: the same failure INSIDE the publish transaction aborts the publish (pre-LF02)", async () => {
        await expect(
          engine.transaction(async () => {
            await engine.query(ANNOUNCEMENT_UID).create({
              data: { documentId: "doc-y", title: "y", publishedAt: new Date().toISOString() },
            });
            try {
              await engine.query(NOTIFICATION_UID).create({
                data: { type: "announcement", title: "t".repeat(300), recipient: 1 },
              });
            } catch {
              // The old fan-out caught and logged the error ...
            }
            // ... but the next statement of the publish fails anyway.
            await engine.query(ANNOUNCEMENT_UID).findOne({ where: { documentId: "doc-y" } });
          }),
        ).rejects.toMatchObject({ code: "25P02" });
        expect(await engine.query(ANNOUNCEMENT_UID).count()).toBe(0);
      }, 30_000);

      it("Postgres: a failure AT COMMIT is not surfaced and still runs the commit callbacks", async () => {
        // knex 3.0.1 resolves trx.commit() when COMMIT fails (the error goes
        // to the transaction's own promise), so @strapi/database resolves the
        // transaction and runs onCommit although nothing was committed. A
        // post-commit task therefore re-reads committed state: the fan-out
        // re-reads its source and notifies nobody when it is gone.
        const { sql, schema } = opened;
        if (!sql || !schema) throw new Error("no raw SQL on this engine");
        await sql(`CREATE FUNCTION "${schema}".refuse_at_commit() RETURNS trigger AS $$
          BEGIN RAISE EXCEPTION 'refused at commit'; END $$ LANGUAGE plpgsql`);
        await sql(`CREATE CONSTRAINT TRIGGER refuse_at_commit AFTER INSERT ON "${schema}".announcements
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${schema}".refuse_at_commit()`);
        const task = vi.fn();
        await expect(
          engine.transaction(async () => {
            await engine.query(ANNOUNCEMENT_UID).create({
              data: { documentId: "doc-z", title: "z", publishedAt: new Date().toISOString() },
            });
            await afterCommit(engine, task, () => undefined);
          }),
        ).resolves.toBeUndefined();
        await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(1));
        expect(await engine.query(ANNOUNCEMENT_UID).count()).toBe(0);
        await sql(`DROP TRIGGER refuse_at_commit ON "${schema}".announcements`);
      }, 30_000);
    }
  });
}

suite("post-commit side effects on SQLite (@strapi/database 5.55.1)", openSqlite, false);

if (PG_URL) {
  suite("post-commit side effects on Postgres 16 (@strapi/database 5.55.1)", openPostgres, true);
} else {
  describe.skip("post-commit side effects on Postgres 16 (SINNLOS_TEST_PG_URL unset)", () => {
    it("needs SINNLOS_TEST_PG_URL", () => undefined);
  });
}
