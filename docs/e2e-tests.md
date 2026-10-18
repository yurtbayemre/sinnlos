# Browser E2E tests

The Teams pilot is being implemented in the [E2E plan](./plan-e2e-tests.md).
Step 1 provides tooling only. The isolated app/database runner, fixtures,
browser cases and automatic CI execution follow in steps 2–5.

## Tooling

Use the repository's Node and pnpm versions (Node 24 in CI and pnpm from
`packageManager`). From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @sinnlos/e2e typecheck
pnpm --filter @sinnlos/e2e lint
pnpm test:e2e
```

The last command currently exits with **No tests found** and a nonzero status.
There are deliberately no placeholder tests that would turn an empty suite green.
It does not yet start an application or database; no browser E2E pass is claimed.
Browser installation will be part of the isolated runner setup.

`pnpm lint` and `pnpm typecheck` already include this workspace, including
its configuration, future `*.spec.ts` files and `*.mjs` helpers. It reuses the
same TypeScript, ESLint and Node type versions as the web app. Existing Vitest
collection and app compilation stay separate.

`e2e/playwright.config.ts` selects Chromium, one worker, no retries, English,
a 1280×720 viewport and Europe/Berlin browser time. It limits each test to
30 seconds and the test run to five minutes, and rejects `test.only` in CI.
The future runner needs its own startup and cleanup budgets.

All generated data belongs under the ignored root `.e2e/` directory:
HTML reports in `report/`, test results in `results/`, and future private
runtime/session files alongside them. Screenshots and traces are retained
only on failure. These paths are outside E2E lint/typecheck inputs and are
excluded from Git, Prettier and Docker. To open a generated report:

```bash
pnpm --filter @sinnlos/e2e exec playwright show-report ../.e2e/report
```

## Production dependency boundary

Playwright is a development dependency of the separate `e2e` workspace.
The app Dockerfiles do not copy that workspace's manifest or sources. A root
devDependency would enter the CMS image because its filtered pnpm installation
also installs the root importer and the runtime copies that dependency tree.

The root override `next>@playwright/test: "-"` removes Next's optional
Playwright peer. Without it, pnpm resolves that peer from the E2E workspace
and adds Playwright to the web app's dependency graph. Our standalone test
runner does not use Next's integrated test mode. Keep this boundary when
upgrading Next, pnpm or Playwright.
