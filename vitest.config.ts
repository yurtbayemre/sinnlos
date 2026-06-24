import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Single root Vitest config for the monorepo.
 *
 * We test only pure, security-relevant logic (no Next.js / Strapi runtime),
 * so a Node environment with a couple of path aliases is all that is needed:
 *   - `@/*` mirrors apps/web's tsconfig path so apps/web modules that import
 *     `@/lib/types` (type-only) resolve during test collection.
 *
 * Tests live next to the code under test as `*.test.ts`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["apps/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/build/**"],
  },
});
