// Flat ESLint config for packages/domain (@sinnlos/domain).
// Runnable with `eslint .` from this directory.
import tseslint from "typescript-eslint";

// Datetime contract (deep-dive decision 04, C5): the same local-Date ban as
// apps/cms/eslint.config.mjs and apps/web/eslint.config.mjs (the package
// test eslint-config.test.ts pins the selectors to the cms config). Only
// src/plain-date.ts is exempt: it uses UTC Date fields alone.
const LOCAL_DATE_SYNTAX = [
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(getFullYear|getYear|getMonth|getDate|getDay|getHours|getMinutes|getSeconds|getMilliseconds|getTimezoneOffset|setFullYear|setYear|setMonth|setDate|setHours|setMinutes|setSeconds|setMilliseconds)$/]",
    message:
      "Local Date fields depend on the process time zone. Use src/plain-date.ts (zonedDateKey, zonedHour, zonedDayStart, addDaysToKey, ...) with an explicit zone.",
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length>1]",
    message:
      "new Date(y, m, d, ...) builds a local-time instant. Use plain-date.ts (zonedWallTimeToInstant, zonedDayStart) or an ISO-Z string.",
  },
  {
    selector: "CallExpression[callee.property.name=/^(toLocaleDateString|toLocaleTimeString)$/]",
    message: "Format calendar dates with plain-date.ts formatPlainDate (explicit zone).",
  },
  {
    selector:
      "CallExpression[callee.property.name=/^(slice|substring|substr|split)$/][callee.object.type='CallExpression'][callee.object.callee.property.name='toISOString']",
    message:
      "toISOString() gives the UTC day, not the business day. Use plain-date.ts zonedDateKey(instant, zone).",
  },
];

export default tseslint.config(
  {
    // Build output and deps are never linted.
    ignores: ["dist/**", "node_modules/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Pure shared rules: no escape hatch into untyped code.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["**/*.{ts,mjs}"],
    ignores: ["src/plain-date.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...LOCAL_DATE_SYNTAX],
    },
  },
  {
    // The package has no runtime dependencies: its modules import each
    // other and nothing else (tests and the build script may use Node and
    // vitest).
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!\\./)",
              message: "@sinnlos/domain has no dependencies: import sibling modules only (./x.js).",
            },
          ],
        },
      ],
    },
  },
);
