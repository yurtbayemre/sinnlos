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
