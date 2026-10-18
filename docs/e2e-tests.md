# Browser E2E tests

The Teams pilot follows the [E2E plan](./plan-e2e-tests.md). Tooling, the
isolated runtime and both browser cases are implemented. The CI job follows
in step 5.

## Prerequisites and commands

Use the repository's Node and pnpm versions (Node 24 in CI and pnpm from
`packageManager`), a **local Docker daemon with Linux containers**, and
Docker Compose v2 or newer. The same Linux production images run on a Linux
host or Docker Desktop; no native Windows app build is required.

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @sinnlos/e2e exec playwright install chromium
pnpm --filter @sinnlos/e2e test:runner  # small runner safety/readiness checks
pnpm --filter @sinnlos/e2e check:setup  # build, start, verify fixtures/auth, clean up
pnpm test:e2e                         # same stack, then Playwright
```

On Linux, use `playwright install --with-deps chromium` for the installation
command above to include Chromium's system libraries. Reinstall the browser
after upgrading Playwright.

The `teams-edit-description` case signs in through the visible form as a
team lead, navigates through the Teams overview, edits the description and
checks the save confirmation. It verifies the persisted text after a full
reload, on the detail page and as a member in a separate browser session.
No login or save API calls replace these browser actions.

The `teams-member-read-only` case uses its own team and a fresh member
session. It checks the original description and absence of an Edit link,
then directly opens the edit URL and requires the specific not-found view
without editor fields or a Save button. A new navigation to the detail page
must show the unchanged description. A generic error page does not pass;
the HTTP status alone is insufficient because Next.js can stream status 200
before rendering the not-found view.

Both cases live in `e2e/teams.spec.ts` and share only fixture reading and UI
login/navigation code. They assert the signed-in email and use separate
browser sessions and team data; neither depends on the other running first.

To run either case alone against a new disposable stack:

```bash
pnpm test:e2e --grep teams-edit-description
pnpm test:e2e --grep teams-member-read-only
```

`check:setup` is a runtime smoke check, not a browser E2E pass. An empty
browser test selection fails with a nonzero status and still cleans up.

`pnpm lint` and `pnpm typecheck` include configuration, `*.spec.ts` files
and `.mjs` helpers in this workspace. `pnpm test` includes the small Node
runner tests after Vitest. App compilation and Vitest collection stay separate.

## One disposable stack per run

`e2e/run.mjs` creates a random `sinnlos-e2e-…` Compose project and builds
both existing app Dockerfiles from the current checkout. Normal Docker layer
caching is allowed; existing running apps and databases are never adopted.
Builds have a 15-minute deadline; stack readiness has a 180-second deadline.

The stack owns PostgreSQL 16 with a fresh database in tmpfs, a CMS container,
a web container and a dedicated bridge network. Only CMS and web publish
ports, bound to `127.0.0.1`. Docker chooses the CMS port; the runner selects a
free web port and fails if it is taken before Docker binds it. `AUTH_URL`
matches that browser origin, and `STRAPI_URL` addresses CMS on the run's
own network.

The runner accepts no external app or database URL. It pins Docker to a local
Unix socket or Windows named pipe, supplies explicit environment files, and
removes inherited application settings and runtime overrides from child
processes. The existing `.dockerignore` excludes project `.env` files from
both builds. CMS also uses a deliberately absent `ENV_PATH`.

Demo seeding, Entra, registration, scheduled jobs, mail digests and live-event
pings are off. Local authentication, its rate limits, permissions and normal
Strapi bootstrap remain active. Process time is UTC, app/browser time is
Europe/Berlin, and the web locale is English.

`e2e/cms-start.mjs` refuses a nonempty database before loading Strapi. It uses
the normal User Service and Document Service to create one department, two
confirmed users (`team_lead`, `member`) and two teams. Only the editable team
has a lead; the member belongs to both. It asserts all fixture relationships
before opening the HTTP listener. The runner then checks the web sign-in
page/providers and verifies both users' real CMS login and `/api/me` roles.
These preflight JWTs stay in memory; browser cases must log in through the UI.

Playwright receives `SINNLOS_E2E_BASE_URL` and `SINNLOS_E2E_FIXTURES` from
the runner. The private fixture JSON contains `runId`, `users.lead/member`
(email/password/documentId) and `teams.editable/readonly`
(slug/name/description/documentId). Tests must not print those credentials.
The config selects Chromium, one worker, no retries, English, a 1280×720
viewport, a 30-second test timeout and a five-minute test-run deadline.
CI rejects `test.only`.

## Diagnostics and cleanup

Generated files live under the ignored root `.e2e/`:

- `runs/<runId>/`: private env and fixture files; removed in `finally`.
- `logs/<runId>/`: build, startup, service and cleanup diagnostics. Known
  generated secrets are redacted before writing logs; failure details are in
  `runner.log` or the named command log.
- `report/` and `results/`: Playwright report and failure-only screenshots/traces.

Success, startup failure and handled SIGINT/SIGTERM all perform cleanup.
The runner checks container/network ownership before stopping the stack,
removes only its own CMS/web image tags, and verifies the private directory's
resolved path and owner before deleting it. The shared PostgreSQL image and
Docker build cache remain available. Diagnostic files remain for inspection.

A hard kill, machine crash or unavailable Docker daemon cannot guarantee
cleanup. The printed run ID identifies the resources to inspect before
manual removal; never use a global Docker prune. Private `runs/` files must
never be uploaded with CI diagnostics. Traces may contain only the ephemeral
test credentials/sessions, as specified in plan step 5.

To open a generated browser report:

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
upgrading Next, pnpm or Playwright. The CMS test starter is mounted only into
the disposable test container and is absent from production images.
