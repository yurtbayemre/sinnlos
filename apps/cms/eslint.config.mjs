// Flat ESLint config for apps/cms (Strapi v5 + TypeScript).
// Runnable with `eslint .` from this directory.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Generated/build output and caches are never linted.
    ignores: [
      "dist/**",
      "build/**",
      ".cache/**",
      ".tmp/**",
      ".strapi/**",
      "types/generated/**",
      "node_modules/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    // Strapi controllers/policies/lifecycles are loosely typed; `any` is
    // idiomatic. Keep these visible as warnings, not CI-breaking errors.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // Strapi user migrations are plain CommonJS: @strapi/database require()s
    // <app root>/database/migrations/*.js directly (no build step).
    files: ["database/migrations/**/*.js"],
    languageOptions: { sourceType: "commonjs" },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
