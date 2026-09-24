import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Single root Vitest config for the monorepo.
 *
 * We test only pure, security-relevant logic (no Next.js / Strapi runtime),
 * so a Node environment with a couple of path aliases is all that is needed:
 *   - `@/*` mirrors apps/web's tsconfig path so apps/web modules that import
 *     `@/lib/types` (type-only) resolve during test collection.
 *   - `server-only` resolves to Next's own empty module, exactly what Next's
 *     server compilers alias it to (next/dist/build/create-compiler-aliases.js
 *     createServerOnlyClientOnlyAliases). The marker is not a dependency:
 *     Next implements it at compiler level.
 *
 * next-auth and @auth/core are inlined (transformed by Vite instead of
 * loaded by Node): next-auth imports `next/server` / `next/headers` without
 * a file extension, which Node's ESM resolver rejects for the exports-less
 * `next` package. Only auth.test.ts loads them for real (the D-SESSION-01
 * regression suite drives the actual Auth.js handlers); other suites mock
 * `@/auth`.
 *
 * Tests live next to the code under test as `*.test.ts`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
      "server-only": fileURLToPath(
        new URL("./apps/web/node_modules/next/dist/compiled/server-only/empty.js", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["apps/**/*.test.ts", "infra/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/build/**"],
    server: { deps: { inline: [/[\\/]next-auth[\\/]/, /[\\/]@auth[\\/]core[\\/]/] } },
  },
});
