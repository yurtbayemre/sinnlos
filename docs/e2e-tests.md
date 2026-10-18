# Browser E2E tests

The suite covers team editing, member read-only access and quiz completion.
It uses one isolated runtime and three independent browser cases. The
[Teams pilot](./plan-e2e-tests.md#github-abnahme) passed local and hosted
acceptance and is merged into main. The
[quiz extension](./plan-e2e-quiz.md) records its separate implementation and
validation status. This suite is a focused browser check, not a complete
Batch 17 browser acceptance.

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

The `training-quiz-completion` case in `e2e/training.spec.ts` signs in as a
member and opens a published, optional `quizGate` course through Training.
Its two questions have different correct option indices. Missing and wrong
answers keep completion locked; correct feedback alone does not persist a
receipt. After explicitly completing the lesson, a full reload must show a
dated completion, and both the course detail and overview must show Completed.

The two Teams cases live in `e2e/teams.spec.ts`. All three cases reuse only
fixture reading and visible-form login from `e2e/helpers.ts`, including the
signed-in email assertion. They use fresh browser sessions and independent
mutable targets; the quiz case does not modify the teams.

To run any case alone against a new disposable stack:

```bash
pnpm test:e2e --grep teams-edit-description
pnpm test:e2e --grep teams-member-read-only
pnpm test:e2e --grep training-quiz-completion
```

`check:setup` is a runtime smoke check, not a browser E2E pass. An empty
browser test selection fails with a nonzero status and still cleans up.

`pnpm lint` and `pnpm typecheck` include configuration, `*.spec.ts` files
and `.mjs` helpers in this workspace. `pnpm test` includes the small Node
runner tests after Vitest. App compilation and Vitest collection stay separate.

## CI execution and scope

The `e2e · browser` job in `.github/workflows/ci.yml` runs on Ubuntu for
relevant pull requests, pushes to `main`, and every manual workflow run.
It installs the pinned dependencies and Chromium with its system libraries,
then runs the same `pnpm test:e2e` entry point. Typecheck and lint already
include the E2E workspace in the existing build job.

`scripts/ci-scope.mjs` emits an independent `e2e` flag. Its only exclusions
are `docs/**/*.md` and these two module-local files:

- `apps/web/src/app/(app)/polls/page.tsx`
- `apps/web/src/app/(app)/polls/loading.tsx`

Teams, Training, shared helpers, auth, layouts, UI, translations, dependencies,
CMS, E2E files and unknown paths run E2E. New Poll files are not automatically
excluded. Both sides of renames and the whole PR diff are considered.
A failed scope calculation fails the existing build check.

The existing `full` and `database` flags keep their meaning. A web-only
change can start the E2E job's private PostgreSQL without enabling the
separate integration or timezone database suites. A change containing only
`docs/**/*.md` starts neither E2E nor any database tests.

The job budget is 50 minutes, with at most five minutes each for dependency
and browser installation, 36 minutes for the runner and three minutes for
upload. Within the runner, builds have 15 minutes, startup has 210 seconds
(including a 180-second readiness limit), and Playwright has five minutes
with an outer six-minute limit. These limits leave time for normal failure
cleanup and diagnostics. A forced GitHub cancellation can kill the process
tree before cleanup finishes; canceled runs do not upload artifacts. The
GitHub-hosted VM is disposable. See the
[GitHub cancellation sequence](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation).

After success or failure, `e2e-browser-<run_id>-<run_attempt>` contains only
`.e2e/report/`, `.e2e/results/` and `.e2e/logs/`, retained for seven days.
`include-hidden-files` permits the `.e2e` parent, while the explicit paths
exclude `.e2e/runs/`, private env/fixture files and separate auth files.
Startup failures retain runner/service/build logs even without a browser
report. Test failures retain screenshots and traces; no retries or
`continue-on-error` turn them green.

This repository is public: artifacts are not a private storage boundary.
Traces may contain only disposable test credentials and sessions; production
credentials and real user data must never enter this stack or its artifacts.
Known generated secrets are redacted from the runner logs before upload.

As checked on 2026-10-18, `main` has no branch protection and no applicable
branch rules. This check therefore reports CI failures but is not an enforced
merge requirement. No repository protection settings were changed. Hosted
acceptance of the Teams pilot passed: full green pilot run, docs-only skip, deliberate red E2E
with downloaded and inspected artifacts, then green E2E after restoring the
test. The [pilot plan records each commit and CI run](./plan-e2e-tests.md#github-abnahme).
Its historical job/artifacts were named `e2e · teams` / `e2e-teams-…`.
The quiz extension's [hosted run](https://github.com/yurtbayemre/sinnlos/actions/runs/39120220734)
passed all three browser cases. Its downloaded `e2e-browser-39120220734-1`
artifact contains the report, results and redacted logs; private env and
fixture files are excluded, and cleanup succeeded. The
[quiz plan records the implementation and acceptance evidence](./plan-e2e-quiz.md#nachweise).

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
has a lead; the member belongs to both. A published optional `quizGate` course
contains one published lesson with two questions and no pre-created progress.
The starter asserts publication, course/lesson links, quiz contents and fixture
relationships before opening the HTTP listener. The runner then checks the web sign-in
page/providers and verifies both users' real CMS login and `/api/me` roles.
These preflight JWTs stay in memory; browser cases must log in through the UI.

Playwright receives `SINNLOS_E2E_BASE_URL` and `SINNLOS_E2E_FIXTURES` from
the runner. The private fixture JSON contains `runId`, `users.lead/member`
(email/password/documentId) and `teams.editable/readonly`
(slug/name/description/documentId), plus `training.course` (title/slug/documentId)
and `training.lesson` (title/documentId). The quiz answer key stays in the CMS
fixture setup and is not exported to that file. Tests must not print credentials.
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

To open a retained trace on its own:

```text
pnpm --filter @sinnlos/e2e exec playwright show-trace ../.e2e/results/TEST_DIRECTORY/trace.zip
```

Replace `TEST_DIRECTORY` with the directory printed for the failed test.
Screenshots are normal PNG files. Each run replaces `report/` and `results/`;
keep needed failure artifacts before starting another run. Run one E2E
command at a time in a checkout; log directories remain separate per run.

### Manual cleanup after a hard stop

First confirm that the runner is no longer active. From the repository root,
replace `RUN_ID` below with the exact printed `sinnlos-e2e-` ID followed by
24 hexadecimal characters. Use the same local Docker endpoint as the run:
replace `ENDPOINT` with its `unix://…` or `npipe://…` address, recorded in
`.e2e/logs/RUN_ID/docker-context.log` unless `DOCKER_HOST` was supplied
explicitly. Do not silently switch to another Docker context.

Inspect only this project:

```text
docker --host "ENDPOINT" ps -a --filter "label=com.docker.compose.project=RUN_ID"
docker --host "ENDPOINT" network ls --filter "label=com.docker.compose.project=RUN_ID"
```

Container names must start with `RUN_ID-`; the network must be
`RUN_ID_default`. If private files remain, verify that
`.e2e/runs/RUN_ID/compose.env` identifies this run and its directory, then:

```text
docker --host "ENDPOINT" compose --project-name RUN_ID --env-file ".e2e/runs/RUN_ID/compose.env" -f e2e/compose.yaml down --volumes --timeout 20
```

If private env files are missing, Compose may refuse to load. Do not recreate
them. Stop and remove only the exact container IDs verified above, then
remove the verified empty network. Replace `CONTAINER_IDS` with those IDs:

```text
docker --host "ENDPOINT" stop --timeout 20 CONTAINER_IDS
docker --host "ENDPOINT" rm CONTAINER_IDS
docker --host "ENDPOINT" network rm RUN_ID_default
```

Remove only the two run-specific image tags, if present:

```text
docker --host "ENDPOINT" image rm RUN_ID-cms RUN_ID-web
```

If the private directory remains, reuse the runner's checked path/owner
removal instead of a recursive shell delete:

```text
node --input-type=module -e "import { removePrivateRun } from './e2e/run.mjs'; await removePrivateRun('.e2e/runs', '.e2e/runs/RUN_ID', 'RUN_ID');"
```

Repeat the filtered listings to confirm cleanup. Keep diagnostic logs, the
shared PostgreSQL image and Docker build cache. Do not use `--rmi all` or a
global prune command.

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
