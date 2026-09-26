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
    // Datetime contract (deep-dive decision 04, C5): calendar math goes
    // through src/utils/time.ts (Temporal, APP_TIME_ZONE) and
    // src/utils/plain-date.ts (Intl). Elsewhere, tests included, the APIs
    // that silently use the process zone are errors: local Date getters and
    // setters, multi-argument `new Date(y, m, d)`, toLocale{Date,Time}String
    // without a zone, and cutting a day out of toISOString() (the UTC day,
    // not the business day).
    files: ["**/*.{ts,js,mjs,cjs}"],
    ignores: ["src/utils/time.ts", "src/utils/plain-date.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(getFullYear|getYear|getMonth|getDate|getDay|getHours|getMinutes|getSeconds|getMilliseconds|getTimezoneOffset|setFullYear|setYear|setMonth|setDate|setHours|setMinutes|setSeconds|setMilliseconds)$/]",
          message:
            "Local Date fields depend on the process time zone. Use src/utils/time.ts (todayIn, zonedDateOf, startOfDayInstant, ...) with APP_TIME_ZONE.",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length>1]",
          message:
            "new Date(y, m, d, ...) builds a local-time instant. Use time.ts (parsePlainDate, wallTimeToInstant) or an ISO-Z string.",
        },
        {
          selector: "CallExpression[callee.property.name=/^(toLocaleDateString|toLocaleTimeString)$/]",
          message: "Format with time.ts formatInstant (explicit zone) or plain-date.ts formatPlainDate.",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^(slice|substring|substr|split)$/][callee.object.type='CallExpression'][callee.object.callee.property.name='toISOString']",
          message:
            "toISOString() gives the UTC day, not the business day. Use time.ts todayIn/zonedDateOf(...).toString().",
        },
      ],
    },
  },
  {
    // temporal-polyfill is an implementation detail of time.ts (swappable
    // for native Temporal later).
    files: ["**/*.{ts,js,mjs,cjs}"],
    ignores: ["src/utils/time.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "temporal-polyfill", message: "Import calendar helpers from src/utils/time.ts instead." }],
          patterns: [{ group: ["temporal-polyfill/*"], message: "Import calendar helpers from src/utils/time.ts instead." }],
        },
      ],
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
