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
 *   - Budgets: a boot (schema sync, permission sync, fixtures) takes about
 *     15-40 s depending on the engine and the machine, in beforeAll.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["apps/cms/src/integration/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: ["apps/cms/src/integration/global-setup.test.helper.ts"],
    env: { TZ: "UTC" },
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 300_000,
    teardownTimeout: 60_000,
  },
});
