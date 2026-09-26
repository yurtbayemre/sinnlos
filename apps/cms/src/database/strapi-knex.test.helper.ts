/**
 * Test support: the knex and pg modules the cms really runs with, loaded
 * from the installed Strapi dependency tree (knex is not a direct cms
 * dependency; @strapi/database brings it). Named *.test.helper.ts so the
 * Strapi build skips it (tsconfig excludes **\/*.test.*) and Vitest does not
 * collect it as a suite.
 *
 * Only the few calls the tests use are typed; the code under test takes its
 * knex through Strapi's untyped `strapi.db.connection`.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

export interface RawKnex {
  (table: string): unknown;
  raw(sql: string, bindings?: readonly unknown[]): Promise<unknown>;
  transaction<T>(handler: (trx: RawKnex) => Promise<T>): Promise<T>;
  destroy(): Promise<void>;
}

export type KnexFactory = (config: Record<string, unknown>) => RawKnex;

const requireFromCms = createRequire(join(__dirname, "..", "..", "package.json"));

/** knex as @strapi/database resolves it (same version and dialects). */
export function loadStrapiKnex(): KnexFactory {
  const requireFromStrapi = createRequire(requireFromCms.resolve("@strapi/strapi/package.json"));
  const requireFromDatabase = createRequire(requireFromStrapi.resolve("@strapi/database/package.json"));
  return requireFromDatabase("knex") as KnexFactory;
}

/** A cms dependency by name (e.g. "pg"), as the cms resolves it. */
export function requireCmsDependency<T>(name: string): T {
  return requireFromCms(name) as T;
}
