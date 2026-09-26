import { describe, expect, it, vi } from "vitest";

import {
  assertTimestamptzContract,
  convertNaiveColumns,
  prepareDatetimeContract,
  refuseNonUtcSchemaSync,
  registerTimestamptzGuard,
  type GuardHost,
} from "./ensure-timestamptz";

/**
 * Control flow of the timestamptz guard against a scripted database. The SQL
 * itself runs against a real Postgres 16 in ensure-timestamptz.pg.test.ts.
 */

interface FakeDbState {
  session: string;
  naive: { table: string; column: string }[];
  tables: Set<string>;
  repairRecorded: boolean;
  tablesWithData: Set<string>;
  schemaMarker: string;
  /** ALTERs on these tables fail (e.g. a lock timeout). */
  failingTables: Set<string>;
  /** Strapi's own view before schema sync: pending migrations, stored and current schema hash. */
  migrationsPending: boolean;
  storedHash: string | null;
  modelHash: string;
}

function fakeStrapi(overrides: Partial<FakeDbState> = {}, client = "postgres") {
  const state: FakeDbState = {
    session: "UTC",
    naive: [],
    tables: new Set(["strapi_database_schema", "strapi_migrations"]),
    repairRecorded: true,
    tablesWithData: new Set(),
    schemaMarker: "1:abc",
    failingTables: new Set(),
    migrationsPending: false,
    storedHash: "abc",
    modelHash: "abc",
    ...overrides,
  };
  const statements: string[] = [];
  const transactions: string[][] = [];

  const answer = (sql: string, bindings: readonly unknown[] = []): Record<string, unknown>[] => {
    statements.push(sql);
    if (sql.includes("current_setting('TimeZone')")) return [{ tz: state.session }];
    if (sql.includes("'timestamp without time zone'::regtype")) {
      return state.naive.map(({ table, column }) => ({ table_name: table, column_name: column }));
    }
    if (sql.includes("c.relkind IN ('r', 'p')") && sql.includes("AS found")) {
      return [{ found: state.tables.has(String(bindings[1])) }];
    }
    if (sql.includes("strapi_migrations") && sql.includes("WHERE name = ?")) {
      return [{ found: state.repairRecorded }];
    }
    if (sql.includes("AS marker")) return [{ marker: state.schemaMarker }];
    if (sql.includes("IS NOT NULL) AS found")) {
      const table = /FROM "public"\."([^"]+)"/.exec(sql)?.[1] ?? "";
      return [{ found: state.tablesWithData.has(table) }];
    }
    if (sql.startsWith("ALTER TABLE")) {
      const table = /ALTER TABLE "public"\."([^"]+)"/.exec(sql)?.[1] ?? "";
      if (state.failingTables.has(table)) throw new Error("canceling statement due to lock timeout");
      state.naive = state.naive.filter((col) => col.table !== table);
      return [];
    }
    return [];
  };

  const raw = async (sql: string, bindings?: readonly unknown[]) => ({ rows: answer(sql, bindings) });
  const connection = {
    raw,
    transaction: async <T>(handler: (trx: { raw: typeof raw }) => Promise<T>): Promise<T> => {
      const inTransaction: string[] = [];
      transactions.push(inTransaction);
      return handler({
        raw: async (sql: string, bindings?: readonly unknown[]) => {
          inTransaction.push(sql);
          return raw(sql, bindings);
        },
      });
    },
  };
  const handlers: Array<(context: unknown) => Promise<void>> = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const hooked: string[] = [];
  const syncCalls: string[] = [];
  const strapi: GuardHost = {
    db: {
      connection,
      dialect: { client },
      getSchemaName: () => "public",
      migrations: {
        shouldRun: async () => {
          syncCalls.push("shouldRun");
          return state.migrationsPending;
        },
      },
      schema: {
        schema: { tables: [] },
        schemaStorage: {
          read: async () => {
            syncCalls.push("read");
            return state.storedHash === null ? null : { hash: state.storedHash };
          },
          hashSchema: () => state.modelHash,
        },
      },
    },
    log,
    hook: (name: string) => ({
      register: (handler: (context: unknown) => Promise<void>) => {
        hooked.push(name);
        handlers.push(handler);
      },
    }),
  };
  return { strapi, state, statements, transactions, handlers, hooked, syncCalls, log };
}

const UTC = { processZone: "UTC", env: {} };
const BERLIN = { processZone: "Europe/Berlin", env: {} };

describe("prepareDatetimeContract (register)", () => {
  it("does nothing on SQLite but log the zones", async () => {
    const { strapi, statements, log } = fakeStrapi({}, "sqlite");
    await prepareDatetimeContract(strapi, BERLIN);
    expect(statements).toEqual([]);
    expect(log.info).toHaveBeenCalledWith("[datetime] process time zone Europe/Berlin, APP_TIME_ZONE Europe/Berlin");
  });

  it("refuses a database session that is not in UTC", async () => {
    const { strapi } = fakeStrapi({ session: "Europe/Berlin" });
    await expect(prepareDatetimeContract(strapi, UTC)).rejects.toThrow(/session runs in "Europe\/Berlin"/);
  });

  it("refuses a non-UTC process on a fresh database and while the repair is pending", async () => {
    const fresh = fakeStrapi({ tables: new Set() });
    await expect(prepareDatetimeContract(fresh.strapi, BERLIN)).rejects.toThrow(/creates the database schema/);
    const pending = fakeStrapi({ repairRecorded: false });
    await expect(prepareDatetimeContract(pending.strapi, BERLIN)).rejects.toThrow(/one-time datetime repair/);
  });

  it("only warns (production) for a non-UTC process on an ordinary boot", async () => {
    const { strapi, log } = fakeStrapi();
    await prepareDatetimeContract(strapi, { processZone: "Europe/Berlin", env: { NODE_ENV: "production" } });
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/runs in Europe\/Berlin, not UTC/));
    const quiet = fakeStrapi();
    await prepareDatetimeContract(quiet.strapi, BERLIN);
    expect(quiet.log.warn).not.toHaveBeenCalled();
  });

  it("validates APP_TIME_ZONE", async () => {
    const { strapi } = fakeStrapi();
    await expect(prepareDatetimeContract(strapi, { processZone: "UTC", env: { APP_TIME_ZONE: "Nowhere" } })).rejects.toThrow(
      /APP_TIME_ZONE/,
    );
  });
});

describe("convertNaiveColumns (afterSync)", () => {
  it("is a no-op without naive columns and on SQLite", async () => {
    expect(await convertNaiveColumns(fakeStrapi().strapi, UTC)).toEqual([]);
    const sqlite = fakeStrapi({ naive: [{ table: "events", column: "start" }] }, "sqlite");
    expect(await convertNaiveColumns(sqlite.strapi, UTC)).toEqual([]);
    expect(sqlite.statements).toEqual([]);
  });

  it("converts one table per transaction with lock and statement timeouts", async () => {
    const { strapi, transactions, log } = fakeStrapi({
      naive: [
        { table: "events", column: "start" },
        { table: "events", column: "end" },
        { table: "strapi_migrations", column: "time" },
      ],
    });
    const converted = await convertNaiveColumns(strapi, UTC);
    expect(converted).toHaveLength(3);
    expect(transactions).toEqual([
      [
        "SET LOCAL lock_timeout = '5s'",
        "SET LOCAL statement_timeout = '60s'",
        `ALTER TABLE "public"."events" ALTER COLUMN "start" TYPE timestamptz(6) USING "start" AT TIME ZONE 'UTC', ` +
          `ALTER COLUMN "end" TYPE timestamptz(6) USING "end" AT TIME ZONE 'UTC'`,
      ],
      [
        "SET LOCAL lock_timeout = '5s'",
        "SET LOCAL statement_timeout = '60s'",
        `ALTER TABLE "public"."strapi_migrations" ALTER COLUMN "time" TYPE timestamptz(6) USING "time" AT TIME ZONE 'UTC'`,
      ],
    ]);
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/converted 3 column\(s\) to timestamptz/));
  });

  it("refuses to convert in a non-UTC process", async () => {
    const { strapi } = fakeStrapi({ naive: [{ table: "events", column: "start" }] });
    await expect(convertNaiveColumns(strapi, BERLIN)).rejects.toThrow(/only correct in a UTC process/);
  });

  it("refuses to read unrepaired legacy data as UTC (interlock)", async () => {
    const { strapi, transactions } = fakeStrapi({
      naive: [{ table: "events", column: "start" }],
      repairRecorded: false,
      tablesWithData: new Set(["events"]),
    });
    await expect(convertNaiveColumns(strapi, UTC)).rejects.toThrow(/one-time datetime repair/);
    expect(transactions).toEqual([]);
  });

  it("lets bookkeeping rows and empty tables through before the repair is recorded", async () => {
    const { strapi } = fakeStrapi({
      naive: [
        { table: "strapi_migrations", column: "time" },
        { table: "events", column: "start" },
      ],
      repairRecorded: false,
      tablesWithData: new Set(["strapi_migrations"]),
    });
    expect(await convertNaiveColumns(strapi, UTC)).toHaveLength(2);
  });

  it("logs a table it cannot convert and carries on with the others", async () => {
    const { strapi, log } = fakeStrapi({
      naive: [
        { table: "events", column: "start" },
        { table: "polls", column: "closes_at" },
      ],
      failingTables: new Set(["events"]),
    });
    const converted = await convertNaiveColumns(strapi, UTC);
    expect(converted).toEqual([{ table: "polls", column: "closes_at" }]);
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/could not convert events \(start\).*lock timeout/));
  });

  it("refuses a schema-changing boot in a non-UTC process", async () => {
    const { strapi, state } = fakeStrapi();
    await prepareDatetimeContract(strapi, BERLIN);
    state.schemaMarker = "2:def";
    await expect(convertNaiveColumns(strapi, BERLIN)).rejects.toThrow(/changed the database schema/);
  });
});

describe("refuseNonUtcSchemaSync (beforeSync)", () => {
  it("lets a non-UTC process through when schema sync has nothing to do", async () => {
    const { strapi, statements } = fakeStrapi();
    await expect(refuseNonUtcSchemaSync(strapi, BERLIN)).resolves.toBeUndefined();
    expect(statements).toEqual([]);
  });

  it("refuses a non-UTC process before pending migrations run", async () => {
    const { strapi } = fakeStrapi({ migrationsPending: true });
    await expect(refuseNonUtcSchemaSync(strapi, BERLIN)).rejects.toThrow(
      /runs database migrations and needs a UTC process, but this one runs in Europe\/Berlin.*before Strapi's migrations/,
    );
  });

  it("refuses a non-UTC process before a schema change or a first schema", async () => {
    const changed = fakeStrapi({ modelHash: "def" });
    await expect(refuseNonUtcSchemaSync(changed.strapi, BERLIN)).rejects.toThrow(/changes the database schema/);
    const first = fakeStrapi({ storedHash: null });
    await expect(refuseNonUtcSchemaSync(first.strapi, BERLIN)).rejects.toThrow(/creates the database schema/);
  });

  it("does not look in a UTC process or on SQLite", async () => {
    const utc = fakeStrapi({ migrationsPending: true, modelHash: "def" });
    await expect(refuseNonUtcSchemaSync(utc.strapi, UTC)).resolves.toBeUndefined();
    expect(utc.syncCalls).toEqual([]);
    const sqlite = fakeStrapi({ migrationsPending: true }, "sqlite");
    await expect(refuseNonUtcSchemaSync(sqlite.strapi, BERLIN)).resolves.toBeUndefined();
    expect(sqlite.syncCalls).toEqual([]);
  });

  it("fails closed when Strapi's migration or schema service is gone", async () => {
    const { strapi } = fakeStrapi();
    const bare: GuardHost = { ...strapi, db: { ...strapi.db, migrations: undefined } };
    await expect(refuseNonUtcSchemaSync(bare, BERLIN)).rejects.toThrow(/Cannot tell whether this boot changes/);
  });
});

describe("assertTimestamptzContract (bootstrap)", () => {
  it("retries what afterSync left and passes once nothing is naive", async () => {
    const { strapi, state } = fakeStrapi({ naive: [{ table: "events", column: "start" }] });
    await assertTimestamptzContract(strapi, UTC);
    expect(state.naive).toEqual([]);
  });

  it("fails the start while a column stays naive", async () => {
    const { strapi } = fakeStrapi({
      naive: [{ table: "events", column: "start" }],
      failingTables: new Set(["events"]),
    });
    await expect(assertTimestamptzContract(strapi, UTC)).rejects.toThrow(/still timestamp without time zone.*events\.start/);
  });

  it("is a no-op on SQLite", async () => {
    await expect(assertTimestamptzContract(fakeStrapi({}, "sqlite").strapi, UTC)).resolves.toBeUndefined();
  });
});

describe("registerTimestamptzGuard", () => {
  it("hooks the schema-change check into beforeSync and the conversion into afterSync", async () => {
    const { strapi, handlers, hooked, state } = fakeStrapi({ naive: [{ table: "events", column: "start" }] });
    registerTimestamptzGuard(strapi, UTC);
    expect(hooked).toEqual(["strapi::content-types.beforeSync", "strapi::content-types.afterSync"]);
    await handlers[0]({});
    await handlers[1]({});
    expect(state.naive).toEqual([]);
  });

  it("the beforeSync handler refuses a non-UTC schema change", async () => {
    const { strapi, handlers } = fakeStrapi({ modelHash: "def" });
    registerTimestamptzGuard(strapi, BERLIN);
    await expect(handlers[0]({})).rejects.toThrow(/changes the database schema/);
  });
});
