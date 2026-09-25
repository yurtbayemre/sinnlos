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
    // tags }`, a fetch `cache` mode other than no-store/no-cache, a
    // route-segment `fetchCache` outside the *-no-store family and the
    // 'use cache' directive. `fetchCache` matters because it wins inside
    // Next's patched fetch: with "force-cache" an explicit cache: "no-store"
    // (revalidate 0) becomes an INFINITE_CACHE entry per JWT (next 16.3.4
    // server/lib/patch-fetch.js, `case 'force-cache'`), so strapi() cannot
    // defend against it. `refresh()` from next/cache stays allowed.
    // Reintroducing a cache needs a new decision (re-entry rule, §10), not
    // an eslint-disable.
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
          // Identifier and quoted-string keys alike.
          selector:
            "Property:matches([key.name='next'], [key.value='next']) > ObjectExpression > Property:matches([key.name=/^(revalidate|tags)$/], [key.value=/^(revalidate|tags)$/])",
          message: "No Next Data Cache options on fetch (D-DC01): Strapi reads are no-store.",
        },
        {
          // Allow-list rather than deny-list: besides "force-cache", the other
          // literal modes ("only-if-cached", "reload", "default") fall through
          // to Next's auto-cache path, which can still write a Data Cache
          // entry (build-time prerender, a segment fetchCache default).
          selector:
            "Property:matches([key.name='cache'], [key.value='cache'])[value.type='Literal']:not([value.value=/^no-(store|cache)$/])",
          message:
            "Fetch cache mode must be no-store or no-cache (D-DC01): Strapi reads are no-store.",
        },
        {
          // Segment config `export const fetchCache = ...` (pages, layouts,
          // route handlers). Only force-/default-/only-no-store are allowed;
          // a non-literal value is flagged too.
          selector:
            "VariableDeclarator[id.name='fetchCache']:not([init.value=/^(force|default|only)-no-store$/])",
          message:
            "Segment fetchCache must be a *-no-store value (D-DC01): 'force-cache' overrides strapi()'s no-store and caches per JWT.",
        },
        {
          selector: "ExpressionStatement[directive=/^use cache/]",
          message: "No 'use cache' (D-DC01): see the re-entry rule in the caching decision.",
        },
      ],
    },
  },
);
