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
);
