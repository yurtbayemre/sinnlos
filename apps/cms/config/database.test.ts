import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import databaseConfig from "./database";

/**
 * Pins the #25 rollback guarantee: @strapi/database defaults
 * `settings.forceMigration` to TRUE, which makes Strapi DROP the DB columns
 * of removed attributes on the next boot (3-way diff against
 * `strapi_database_schema`). The orphaned `target_id` columns in
 * comments+reactions are the rollback anchor for pre-#25 images and MUST
 * survive boots, so config/database.ts has to keep destructive sync off by
 * default. If this test fails, the first CMS boot after a deploy will drop
 * `target_id` (and every other orphaned tracked column) — see
 * docs/architecture.md §5.27 before changing anything here.
 */

type EnvStore = Record<string, string>;

/** Minimal stand-in for Strapi's env helper (only what database.ts uses). */
const makeEnv = (store: EnvStore = {}) => {
  const env = (key: string, def?: unknown) => store[key] ?? def;
  env.int = (key: string, def?: number) =>
    key in store ? parseInt(store[key], 10) : (def as number);
  env.bool = (key: string, def?: boolean) =>
    key in store ? store[key] === "true" : (def as boolean);
  env.array = (key: string, def?: string[]) =>
    key in store ? store[key].split(",") : (def as string[]);
  return env;
};

describe("config/database", () => {
  it("disables destructive schema sync by default (forceMigration=false)", () => {
    const config = databaseConfig({ env: makeEnv() });
    expect(config.settings.forceMigration).toBe(false);
  });

  it("allows the deliberate one-off destructive sync via DATABASE_FORCE_MIGRATION=true", () => {
    const config = databaseConfig({
      env: makeEnv({ DATABASE_FORCE_MIGRATION: "true" }),
    });
    expect(config.settings.forceMigration).toBe(true);
  });

  it("does not treat other truthy-looking values as true", () => {
    const config = databaseConfig({
      env: makeEnv({ DATABASE_FORCE_MIGRATION: "false" }),
    });
    expect(config.settings.forceMigration).toBe(false);
  });

  it("keeps the connection config intact (postgres default client)", () => {
    const config = databaseConfig({ env: makeEnv() });
    expect(config.connection.client).toBe("postgres");
  });
});

/** pg's own parameter resolution, as the cms loads it (pg 8.13.1). */
type ConnectionParametersCtor = new (config: Record<string, unknown>) => { options?: string; host?: string };
function loadPgConnectionParameters(): ConnectionParametersCtor {
  const requireFromCms = createRequire(join(__dirname, "..", "package.json"));
  return requireFromCms("pg/lib/connection-parameters") as ConnectionParametersCtor;
}

describe("config/database: UTC session pin (datetime contract)", () => {
  it("sends -c TimeZone=UTC with every Postgres connection", () => {
    const config = databaseConfig({ env: makeEnv() });
    expect(config.connection.connection.options).toBe("-c TimeZone=UTC");
  });

  it("keeps the pin under a DATABASE_URL without its own options (pg merges only the URL's keys)", () => {
    const url = "postgres://sinnlos:secret@db:5432/sinnlos?sslmode=disable";
    const config = databaseConfig({ env: makeEnv({ DATABASE_URL: url }) });
    const ConnectionParameters = loadPgConnectionParameters();
    const params = new ConnectionParameters(config.connection.connection);
    expect(params.options).toBe("-c TimeZone=UTC");
    expect(params.host).toBe("db");
  });

  it("refuses a DATABASE_URL whose options would replace the pin", () => {
    const url = "postgres://u:p@db/sinnlos?options=-c%20search_path%3Dapp";
    // pg would indeed drop the pin: the URL's options win.
    const ConnectionParameters = loadPgConnectionParameters();
    expect(new ConnectionParameters({ options: "-c TimeZone=UTC", connectionString: url }).options).toBe(
      "-c search_path=app",
    );
    expect(() => databaseConfig({ env: makeEnv({ DATABASE_URL: url }) })).toThrow(/options/);
    expect(() =>
      databaseConfig({ env: makeEnv({ DATABASE_URL: "postgres://u:p@db/x?options=-c%20TimeZone%3DEurope%2FBerlin" }) }),
    ).toThrow(/TimeZone=UTC/);
  });

  it("accepts URL options that pin TimeZone=UTC themselves", () => {
    const url = "postgres://u:p@db/sinnlos?options=-c%20TimeZone%3DUTC%20-c%20statement_timeout%3D0";
    expect(() => databaseConfig({ env: makeEnv({ DATABASE_URL: url }) })).not.toThrow();
  });

  it("ignores DATABASE_URL entirely on SQLite", () => {
    const env = makeEnv({ DATABASE_CLIENT: "sqlite", DATABASE_URL: "postgres://u:p@db/x?options=-c%20x%3Dy" });
    expect(databaseConfig({ env }).connection.client).toBe("sqlite");
  });
});
