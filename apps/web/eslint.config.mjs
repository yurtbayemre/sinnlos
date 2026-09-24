// Flat ESLint config for apps/web (Next.js 16 + TypeScript).
// Runnable with `eslint .` from this directory.
//
// Uses the official eslint-config-next flat presets (issue #30): the
// earlier hand-wired setup composed only @next/eslint-plugin-next onto
// typescript-eslint and therefore never ran react/react-hooks rules —
// `rules-of-hooks` and `exhaustive-deps` silently did not exist. The
// presets bring react, react-hooks, jsx-a11y and import resolution on
// top of the Next rules; `/typescript` layers the TS-aware bits.
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Build artifacts and deps are never linted.
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
  ...nextVitals,
  ...nextTs,
  {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx}"],
    rules: {
      // CMS data is loosely typed; `any` is pervasive. Keep it a visible
      // warning rather than a CI-breaking error (true errors still fail).
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "warn",
    },
  },
  {
    // D-DC01 (deep-dive decisions/03-caching.md §6/§9): the web keeps NO
    // server-side copy of Strapi responses — every strapi() read is
    // no-store, see src/lib/strapi.ts. These rules block the ways back in:
    // the Next cache/invalidation APIs, per-fetch `next: { revalidate |
    // tags }` and the 'use cache' directive. `refresh()` from next/cache
    // stays allowed. Reintroducing a cache needs a new decision (re-entry
    // rule, §10), not an eslint-disable.
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "next/cache",
              importNames: [
                "unstable_cache",
                "revalidateTag",
                "updateTag",
                "revalidatePath",
                "cacheTag",
                "cacheLife",
              ],
              message:
                "No server-side Strapi cache (D-DC01): reads are no-store; use refresh() after a mutation.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Property[key.name='next'] > ObjectExpression > Property[key.name=/^(revalidate|tags)$/]",
          message: "No Next Data Cache options on fetch (D-DC01): Strapi reads are no-store.",
        },
        {
          selector: "ExpressionStatement[directive=/^use cache/]",
          message: "No 'use cache' (D-DC01): see the re-entry rule in the caching decision.",
        },
      ],
    },
  },
);
