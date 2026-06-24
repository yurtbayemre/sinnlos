// Flat ESLint config for apps/web (Next.js 16 + TypeScript).
// Runnable with `eslint .` from this directory.
//
// Mirrors the legacy "next/core-web-vitals" preset by wiring the official
// @next/eslint-plugin-next recommended + core-web-vitals rule sets onto a
// typescript-eslint recommended base.
import tseslint from "typescript-eslint";
import nextPlugin from "@next/eslint-plugin-next";

export default tseslint.config(
  {
    // Build artifacts and deps are never linted.
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx}"],
    plugins: {
      "@next/next": nextPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      // CMS data is loosely typed; `any` is pervasive. Keep it a visible
      // warning rather than a CI-breaking error (true errors still fail).
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-require-imports": "warn",
    },
  },
);
