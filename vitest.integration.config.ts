import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

/**
 * Strapi-in-process integration suite (roadmap S11): `pnpm test:integration`.
 *
 * Separate from vitest.config.ts (which excludes *.integration.test.ts), so
 * `pnpm test` and `pnpm test:tz` stay fast and pure. Here every suite boots
 * the real cms, compiled once by the global setup, against a fresh SQLite
 * file and, with SINNLOS_TEST_PG_URL set, a fresh Postgres schema (see
 * apps/cms/src/integration/harness.test.helper.ts).
 *
 *   - TZ=UTC: a boot on a fresh Postgres schema creates it, which the
 *     datetime contract allows only in a UTC process, as in the container
 *     (src/database/ensure-timestamptz.ts). Node applies a runtime TZ
 *     change to Date and Intl.
 *   - forks (vitest's default, pinned): each file gets its own process, so
 *     the `strapi` global, the compiled cms modules and the process
 *     listeners that `strapi.destroy()` removes (the harness puts them back)
 *     never leak between files.
 *   - maxWorkers at most 8: on Postgres every file holds up to 5 connections
 *     of its Strapi pool (the harness sets DATABASE_POOL_MIN=0 and
 *     DATABASE_POOL_MAX=5) plus one admin knex connection for its schema,
 *     so 18 files at once (one fork per core on a large machine) could pass
 *     Postgres' default max_connections=100 ("sorry, too many clients
 *     already"); 8 workers stay near 48. Fewer cores, fewer workers.
 *   - Budgets: a boot (schema sync, permission sync, fixtures) takes about
 *     15-40 s depending on the engine and the machine, in beforeAll
 *     (hookTimeout). A test that boots in its body (the harness contract,
 *     the restarts) passes its own budget as the third argument of `it`:
 *     vitest does not abort a timed-out body, the boot would run on into
 *     the next case.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["apps/cms/src/integration/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: ["apps/cms/src/integration/global-setup.test.helper.ts"],
    env: { TZ: "UTC" },
    pool: "forks",
    maxWorkers: Math.max(1, Math.min(8, availableParallelism())),
    testTimeout: 60_000,
    hookTimeout: 300_000,
    teardownTimeout: 60_000,
  },
});
