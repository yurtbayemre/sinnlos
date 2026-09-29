# Sinnlos Intranet

A self-hosted company intranet with optional **Microsoft Entra ID (Azure AD)** single sign-on,
all gated by **user roles**: announcements with **live comments & reactions**
(SSE push — other sessions see new comments in under two seconds, with
polling as the fallback) and **read confirmation** for mandatory news, a
**wiki** with revision history, **department/team pages**, a **people
directory + org chart** with **opt-in birthday celebrations**, **events with
ICS export & RSVP** (list + month view), **polls**, **kudos**, a **document
library**, an **employee marketplace** (classified ads with hardened photo
upload), **quick links**, a **training platform** (courses with lessons,
YouTube embeds, comprehension quizzes with an optional completion gate, and
per-user completion tracking incl. an admin report), **notifications** with
opt-in **e-mail digests** (daily/weekly), **global search (⌘K)** with
anonymous search analytics, and an **English/German UI**
(see [Internationalization](#internationalization-i18n)).

- **Backend** — Strapi v5 (Postgres) at `apps/cms`
- **Frontend** — Next.js 16 + TailwindCSS + shadcn/ui at `apps/web`
- **Auth** — local e-mail + password against Strapi (the default), and
  optionally **Microsoft Entra ID** (`ENTRA_ENABLED=1`, off by default):
  Auth.js signs the user in against one tenant, the cms verifies the ID
  token itself and provisions the user with the role of their Entra app
  role (`POST /api/auth/entra/exchange`), then issues a Strapi JWT (see
  [step 2](#2-optional-microsoft-entra-id-sign-in)).
- **Deployment** — Docker Compose in `infra/`. Local full-stack runs use the
  bundled **Caddy** (automatic TLS); the live production host (srv-prod-01)
  fronts the same compose stack with **Traefik** via a second override file.

**→ [Full deployment guide](./docs/DEPLOYMENT.md)** — bare-metal, Docker, VPS (Traefik), Azure VM, Azure Container Apps.

**→ [Architecture map](./docs/architecture.md)** — topology, data model, request/caching flow, the conventions you must know before changing code, and the known open issues.

## Repository layout

```
.
├── .github/
│   ├── workflows/ci.yml    CI (build, datetime, integration, infra, images)
│   └── dependabot.yml      weekly grouped version updates
├── apps/
│   ├── cms/                Strapi v5 backend
│   └── web/                Next.js 16 frontend
├── packages/
│   └── domain/             @sinnlos/domain: the pure rules both apps share (built to dist/cjs + dist/esm)
├── infra/
│   ├── docker-compose.yml          base stack (db, cms, web, caddy)
│   ├── docker-compose.traefik.yml  prod override (Traefik instead of Caddy; needs DOMAIN)
│   ├── deploy.sh                   direct prod deploy (env preflight → lock/clean-tree/CI checks → backup → build → smoke → live-smoke → SHA tags + last-known-good; --check = preflight only, --dry-run = plan)
│   ├── live-smoke.sh               end-to-end SSE pipeline probe (run by deploy.sh)
│   ├── backup/pg-backup.sh         nightly encrypted Postgres + uploads + .env backup
│   ├── backup/restore-drill.sh     off-box restore of the newest encrypted dump into a throwaway Postgres 16
│   ├── Caddyfile                   the bundled Caddy (standalone boxes, local full-stack runs)
│   └── .env.example
├── pnpm-workspace.yaml
└── package.json
```

## Prerequisites

- Node.js 22.13+ or 24 LTS (root and `apps/cms` `engines`:
  `^22.13.0 || ^24.0.0`; CI and the Docker images use Node 24; Node 20 is
  end-of-life)
- pnpm 10 (`corepack enable && corepack prepare pnpm@10.34.6 --activate`;
  the root `packageManager` names the exact version, `engines` refuses
  pnpm 9)
- Docker + Docker Compose (for production / full stack run)
- A Microsoft Entra ID tenant in which you may register an app and grant
  admin consent — only for the optional Microsoft sign-in
  ([step 2](#2-optional-microsoft-entra-id-sign-in)); without it the intranet
  runs in [standalone mode](#running-without-microsoft-standalone-mode)

## 1. Install dependencies

```bash
pnpm install
pnpm build:domain
```

Run `pnpm install` again after pulling a change to the lockfile (hardening
batch 2, for example, brought vitest 4.1.11 and Vite 7.3.6 for the root test
tooling). The first install with pnpm 10 over a `node_modules` that pnpm 9
created asks to remove and rebuild it; answer yes (without a terminal, run
it with `CI=true`). pnpm 10 runs dependency install scripts only for the
root `package.json`'s `pnpm.onlyBuiltDependencies` (better-sqlite3's native
binding, esbuild, sharp); the others it skips are listed under
`pnpm.ignoredBuiltDependencies`, so a new one shows up as a warning to
review.

`pnpm build:domain` builds the workspace package `packages/domain`
(`@sinnlos/domain`, see [Shared domain package](#shared-domain-package)),
which both apps import from its `dist`. Run it once after installing and
again after changing anything in `packages/domain/src`; `pnpm dev`,
`pnpm typecheck` and `pnpm test:integration` run it first on their own, and
`pnpm build` builds it before the apps.

### Shared domain package

`packages/domain` holds the pure rules the cms and the web both apply,
where each app used to keep its own copy (SH01): the announcement audience
predicate (no admin/editor bypass: the cms checks `MODERATORS` before it
asks), the comment/reaction anchor helpers, the entry-id checks, the YouTube
parser and the quiz schema, the role vocabulary, the live-event contract,
the marketplace limits, the poll close rule and the Intl-only calendar-date
helpers. No runtime dependencies and no I/O: it compiles against ES2020 plus
the URL parser only, so browser-only or Node-only APIs fail its typecheck,
and its ESLint config allows no imports but its own modules. Database
lookups stay in the cms.

- The old module paths are thin re-exports under their old names
  (`apps/cms/src/utils/plain-date.ts`, `apps/web/src/lib/plain-date.ts`,
  `apps/cms/src/bootstrap/roles.ts`, …), so importers did not change;
  `domain-reexports.test.ts` in both apps pins which names come from the
  package.
- `pnpm --filter @sinnlos/domain build` (`pnpm build:domain`) writes
  `dist/cjs` (CommonJS + `.d.ts`: `main`/`types` and `exports.require`, what
  the cms compiles and runs against) and `dist/esm` (ES modules + `.d.ts`:
  `exports.import`, what Next.js bundles into the web). `dist` is not
  committed.
- Tests: `vitest.config.ts` resolves `@sinnlos/domain` to the package
  source, so `pnpm test` needs no build and always sees the current rules;
  the package's own suites live next to its modules
  (`packages/domain/src/*.test.ts`), and `dist.test.ts` checks that both
  builds load and export exactly the source's names (skipped locally until
  `dist` exists, required in CI).
- Both Dockerfiles copy `packages/domain` and build it before the app; the
  cms image ships `dist/cjs` (its `node_modules/@sinnlos/domain` is a
  symlink to it), the web bundles the package into its standalone output.

## 2. Optional: Microsoft Entra ID sign-in

Skip this for local sign-in only: Microsoft sign-in is **off unless
`ENTRA_ENABLED=1`** is set for both apps, and every `MS_*` / `ENTRA_*` value
is ignored until then. The full runbook, including a dry-run on staging
before roles are applied, is in
[docs/DEPLOYMENT.md, "Microsoft Entra ID sign-in"](./docs/DEPLOYMENT.md#microsoft-entra-id-sign-in).

In the Microsoft Entra admin center:

1. **App registrations → New registration**, _Accounts in this organizational
   directory only_ (single tenant). Note the **Directory (tenant) ID** and the
   **Application (client) ID** (both GUIDs; `common`, `organizations` and
   `consumers` are refused).
2. **Authentication → Web redirect URI**:
   `http://localhost:3000/api/auth/callback/microsoft-entra-id` (and the
   production equivalent). No cms redirect URI: Strapi's own Microsoft
   provider is not used and stays disabled.
3. **A second Web redirect URI** (same blade): `http://localhost:3000/sign-in`
   (and the production equivalent). "Sign out" ends the intranet session and
   the Microsoft session and returns there; Microsoft only redirects to a
   registered redirect URI, so without it users end on Microsoft's "signed
   out" page. Leave the _Front-channel logout URL_ empty: single sign-out is
   not implemented.
4. **API permissions (delegated)**: `openid`, `profile`, `email`, `User.Read`;
   `User.Read.All` only with `ENTRA_SYNC_MANAGER=1`. Grant admin consent.
   (`GroupMember.Read.All` is not needed.)
5. **App roles** (allowed member types _Users/Groups_): `Intranet.Admin`,
   `Intranet.Editor`, `Intranet.DepartmentHead`, `Intranet.TeamLead`,
   `Intranet.Member`, `Intranet.Guest`. In **Enterprise applications**, set
   _Assignment required_ = Yes and assign the roles to users or security
   groups (see [Role flow](#role-flow-sign-in--strapi--frontend)).
6. **Certificates & secrets** → new client secret.

Then set, in `infra/.env` (or both apps' env files locally): `ENTRA_ENABLED=1`,
`MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` and a shared
`ENTRA_EXCHANGE_SECRET` (`openssl rand -hex 32`). With `ENTRA_ENABLED=1` an
invalid value refuses the start of both apps, naming the variable, and
`infra/deploy.sh --check` refuses the deploy first. Local sign-in is off next
to Microsoft unless `AUTH_LOCAL_ENABLED=1` (break-glass).

## Running without Microsoft (standalone mode)

No Entra ID tenant? Leave `ENTRA_ENABLED` unset (the default) and local
email+password sign-in (against Strapi) is on in both apps — no extra
configuration needed; leftover `MS_*` / `AUTH_MICROSOFT_*` values are
ignored. Accounts
are created in the Strapi admin (**Content Manager → User**) or via
self-registration when `LOCAL_REGISTRATION=1` is set in **both**
`apps/web/.env.local` and `apps/cms/.env`. New local users get the
`member` role; users manage their own display name, job title and phone
on **/profile**; password resets are done by an admin in the Strapi
panel (no SMTP required; the anonymous forgot/reset-password endpoints are
revoked). Changing one's own password on **/profile** signs the user out
of every other browser and device (their next request lands on the
sign-in page) while the tab that changed it stays signed in: the cms keeps
a token version per user and refuses older JWTs. A password an admin sets
in the Strapi panel does not do that yet.

Quick start:

1. Copy the env files (step 3 below) and leave `ENTRA_ENABLED` unset;
   generate `AUTH_SECRET` and the Strapi secrets as usual.
2. Optionally set `LOCAL_REGISTRATION=1` in both apps to enable the
   self-registration form on the sign-in page.
3. Start Strapi and Next.js (step 4 below).
4. Optional shortcut: set `SEED_DEMO_DATA=1` in `apps/cms/.env` for the
   FIRST boot — the built-in seed (`apps/cms/src/seed-demo.ts`, idempotent,
   skips itself once data exists) populates departments, teams, demo users
   and content for every module. Its draft & publish content (announcements,
   events, wiki, polls, documents) gets a draft and a published row per
   entry, like entries created in the admin panel. Otherwise create users
   in the Strapi admin under **Content Manager → User**
   (set email, password, and confirmed = true) — or let people register
   themselves if you enabled registration.
5. Sign in at http://localhost:3000/sign-in with email + password.

To offer local sign-in _alongside_ Microsoft, set `AUTH_LOCAL_ENABLED=1`
for both apps next to `ENTRA_ENABLED=1` (the cms mirrors it into its own
e-mail provider switch, so without it the cms refuses password sign-ins
too).

## 3. Environment files

```bash
cp apps/cms/.env.example apps/cms/.env
cp apps/web/.env.example apps/web/.env.local
cp infra/.env.example infra/.env
```

Leave the commented Entra block as it is unless you set up Microsoft sign-in
(step 2), and generate strong secrets for every empty secret in
`infra/.env` and every `toBeModified` placeholder in `apps/cms/.env`:

```bash
openssl rand -base64 32   # APP_KEYS (two, comma-separated), *_SALT, *_SECRET, ENCRYPTION_KEY
openssl rand -hex 32      # REVALIDATE_SECRET, INTERNAL_UPLOAD_TOKEN
```

Environment contract (details in [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)):

- **Required for Docker Compose** (`docker compose` refuses to start while one
  is empty): `DATABASE_PASSWORD`, `APP_KEYS`, `API_TOKEN_SALT`,
  `ADMIN_JWT_SECRET`, `TRANSFER_TOKEN_SALT`, `JWT_SECRET`, `ENCRYPTION_KEY`,
  `AUTH_SECRET`, `REVALIDATE_SECRET` (guards only the internal live-event
  ingest `/api/live/emit`; the name is historical, there is no cache
  webhook any more) and `INTERNAL_UPLOAD_TOKEN` (the web's `/uploads` proxy
  presents it to the cms; without it every uploaded file answers 404 in
  production). The last two must be identical on cms and web.
- **Placeholder guard:** with `NODE_ENV=production` the cms refuses to start
  while a Strapi secret, `REVALIDATE_SECRET` or `INTERNAL_UPLOAD_TOKEN` still
  holds a template placeholder (`change-me…`, `toBeModified…`, `<secret>`);
  in development it only warns. `infra/deploy.sh --check` runs the same
  check (plus `AUTH_SECRET`) against `infra/.env` before anything is
  deployed.
- **`JWT_SECRET`** signs the users' Strapi JWTs (7 days for local sign-ins,
  `ENTRA_SESSION_TTL`, 12 hours by default, for Microsoft sign-ins; the web
  session ends with the JWT). Rotating it signs everyone out once. An instance upgraded from a release before 2026-09-24
  must rotate it once (see
  [Upgrading from a release before 2026-09-24](./docs/DEPLOYMENT.md#upgrading-from-a-release-before-2026-09-24));
  `infra/deploy.sh` refuses to deploy until it is rotated. The Strapi 5.55.1
  upgrade needs no rotation: tokens issued by 5.49 stay valid.
- **Microsoft Entra ID** (optional): `ENTRA_ENABLED=1` is the only switch;
  without it every `MS_*` / `ENTRA_*` value is ignored (`infra/deploy.sh`
  notes leftover `MS_*` lines, and warns when they are a real app
  registration whose Microsoft sign-in goes off with the deploy). With it,
  `MS_TENANT_ID`,
  `MS_CLIENT_ID` (GUIDs), `MS_CLIENT_SECRET` (web only) and
  `ENTRA_EXCHANGE_SECRET` (32+ characters, same for both apps) are required;
  `ENTRA_SYNC_MODE` (`dry-run` by default, then `on`), `ENTRA_DEFAULT_ROLE`,
  `ENTRA_GROUP_ROLES`, `ENTRA_SYNC_DEPARTMENT`, `ENTRA_SYNC_MANAGER`,
  `ENTRA_SESSION_TTL` and `AUTH_LOCAL_ENABLED` tune it. An invalid value
  refuses the start of both apps and the deploy
  ([table](./docs/DEPLOYMENT.md#microsoft-entra-id-sign-in)).
- **Time zones** ([datetime contract](./docs/DEPLOYMENT.md#310-datetime-contract)):
  `APP_TIME_ZONE` (IANA name, default `Europe/Berlin`) is the business zone
  of every date the apps compute: "today", classified expiry, birthdays and
  anniversaries, digest days, the cron times, all-day events and poll
  deadlines. Spell it as the tz database does (`Europe/Berlin`; no UTC
  offset such as `+02:00`). With an unknown value or an offset the cms does
  not start and the web answers every request with an error (both log why).
  Both app processes and the database sessions run in UTC and every instant
  is stored as `timestamptz`; the web formats every date in `APP_TIME_ZONE`
  (next-intl for instants, `plain-date.ts` for calendar dates; ESLint rejects
  process-zone date APIs in both apps). Do not set `TZ` for the containers
  (the images and compose do). With a local Postgres, add `TZ=UTC` to
  `apps/cms/.env`; SQLite needs nothing.
  `DATETIME_LEGACY_ZONE` / `DATETIME_LEGACY_UTC_UNTIL` are only for a
  database written by a cms before this contract: its first boot repairs
  the stored times once
  ([runbook](./docs/DEPLOYMENT.md#upgrading-an-existing-instance-to-this-release));
  a fresh install leaves them empty.
- **cms network and storage:** `CORS_ORIGIN` lists the browser origins that
  may call the cms API, comma-separated (compose sets it to
  `WEB_PUBLIC_URL`; unset or empty means `http://localhost:3000`).
  `DATABASE_FILENAME` (SQLite only) is relative to `apps/cms`, or an
  absolute path. Releases before batch 8 placed an absolute value under
  `apps/cms` (`/data/x.db` became `apps/cms/data/x.db`); on an existing
  SQLite install, move that file to the absolute path, or switch to the
  equivalent relative value, before upgrading, otherwise the cms starts on a
  new, empty database. Relative values and Postgres are unaffected. The cms
  sends no `X-Powered-By` header. `apps/cms/.env.example` lists every setting
  `apps/cms/config` reads (Postgres connection, pool, TLS, the destructive
  `DATABASE_FORCE_MIGRATION`, the admin feature flags); a test keeps it
  complete.
- **Edge:** `DOMAIN` is the bare public host name. The bundled Caddy uses it
  as its site address (unset: `localhost` with Caddy's internal CA;
  `http://localhost`: plain HTTP); the Traefik overlay requires it for every
  router's host rule.
- **cms runtime:** `STRAPI_TELEMETRY_DISABLED=true` (compose default) sends
  no usage telemetry to Strapi. `CRON_ENABLED` (unset, empty or `true`, the
  default) runs the five cms crons (uploads and search-log janitors, the
  notification janitor that deletes read notifications 90 days after
  reading, the classified janitor that deletes ads 90 days after their last
  day, digest mailer); `false` (also `0`/`no`/`off`) switches them off in that
  process (Strapi's own metrics jobs are not among them). The cms reads it
  like its other on/off switches. Each run logs
  `[cron] <name> took <n>ms`, and a run that would overlap the previous one
  of the same task is skipped.
- **Optional:** `LIVE_EVENTS_DISABLED=1` switches the live SSE pipeline off
  (same value on cms and web). `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`
  enable the e-mail digests (dark without them); `SMTP_PORT` 465 uses
  implicit TLS, any other port (default 587) must offer STARTTLS. Once SMTP is set,
  `DIGEST_FROM` is required too (there is no built-in sender any more;
  without it every run is skipped and `infra/deploy.sh` refuses to deploy).
  Digest links use `PUBLIC_WEB_URL` (compose default: `WEB_PUBLIC_URL`), and
  `DIGESTS_DISABLED=1` is the kill switch (the cms also accepts `true`,
  `yes` and `on`, and so does `infra/deploy.sh --check`). A digest is
  written in the recipient's profile language; `DIGEST_DEFAULT_LOCALE`
  (`en` or `de`, default `en`) is the language for a user whose profile
  has none.

## 4. Run locally (two terminals)

```bash
# Once, and after every change in packages/domain (step 1)
pnpm build:domain

# Terminal A — Strapi
pnpm --filter @sinnlos/cms dev

# Terminal B — Next.js
pnpm --filter @sinnlos/web dev
```

- Strapi admin: http://localhost:1337/admin (see admin bootstrap note below)
- Web: http://localhost:3000 — redirects to `/sign-in`; sign in with e-mail +
  password ([standalone mode](#running-without-microsoft-standalone-mode)),
  or with Microsoft when `ENTRA_ENABLED=1` is set for both apps (step 2).
  The cms logs one `[entra] disabled` or `[entra] enabled tenant=… mode=…`
  line at boot.

> **Strapi admin account:** the first time Strapi boots with an empty
> `admin_users` table, `src/index.ts → bootstrap()` will auto-create a
> **Super Admin** from `STRAPI_ADMIN_EMAIL` / `STRAPI_ADMIN_PASSWORD`
> in `apps/cms/.env`. Set those before the first boot and you can log
> straight into `/admin` with no registration form. Leave them blank to
> keep the classic interactive flow. The seed refuses template placeholders
> and passwords failing the Strapi admin policy (8+ characters with an
> uppercase letter, a lowercase letter and a digit): it logs an error and
> creates no admin. Strapi CE does **not** support SSO
> for the admin panel — Entra ID SSO only applies to the Next.js
> frontend (i.e. `users-permissions` users, not `admin_users`). Admin
> SSO is a Strapi Enterprise Edition feature.

> **Database:** the default `apps/cms/.env.example` uses **SQLite** (file
> at `apps/cms/.tmp/data.db`) so local dev needs no database server. If
> you want Postgres locally, uncomment the `DATABASE_CLIENT=postgres`
> block and set `DATABASE_HOST=localhost`. The hostname `db` that appears
> in `infra/.env.example` is the Docker Compose service name and only
> resolves inside the Compose network.
>
> A dev database from before departments and teams lost draft & publish
> can still hold draft rows for them; Strapi refuses to boot with
> `[org-dp] … still holds N draft row(s)`. Delete `apps/cms/.tmp/data.db`
> and boot once with `SEED_DEMO_DATA=1` (the seed writes one live row per
> unit), or run the one-time migration on a Postgres dev database
> ([DEPLOYMENT.md](./docs/DEPLOYMENT.md#one-time-org-draftpublish-off)).
> That boot check runs in `register()`, so the Strapi CLI commands that
> only register the app (`strapi ts:generate-types`, `strapi report`,
> `strapi content-types:list` and the other `…:list` commands) now need the
> configured database to be reachable as well.

With `ENTRA_ENABLED=1`, a Microsoft sign-in works like this (D-ENTRA-01,
[`apps/cms/src/entra/`](./apps/cms/src/entra)):

1. Auth.js runs the OIDC code flow against the one configured tenant
   (scope `openid profile email User.Read`, no refresh token) and refuses an
   account of any other tenant.
2. The web POSTs the ID token and the Graph access token to the cms
   (`POST /api/auth/entra/exchange`, authenticated by
   `ENTRA_EXCHANGE_SECRET`). The cms verifies the ID token itself (the
   tenant's signing keys, issuer, audience, issued at most 10 minutes ago
   plus 5 minutes of clock tolerance, so effectively 15), reads
   Graph `/me`, and finds the user by **tenant id + object id** (never by
   e-mail), backed by a unique database index.
3. A new user is created on the spot (username `entra-<object id>`,
   independent of `LOCAL_REGISTRATION`) with the role of their Entra **app
   role**; a local account with the same e-mail is never taken over (the
   sign-in answers "account exists" until an admin who has confirmed the
   account is theirs binds it).
4. Display name, job title, phone and office location are synced from Entra
   at every sign-in and are read-only on `/profile`; the department
   (`ENTRA_SYNC_DEPARTMENT=1`) and the manager (`ENTRA_SYNC_MANAGER=1`)
   optionally too.
5. The cms issues a Strapi JWT for `ENTRA_SESSION_TTL` (12 hours by default);
   the web session ends with it, and every sign-in re-syncs roles and
   profile. Each exchange writes one `[entra] user=… result=…` audit line
   without tokens.

See [Role flow](#role-flow-sign-in--strapi--frontend) for the roles.

## 5. Content model + roles

Strapi ships 22 collection types plus two routes-only APIs
(`apps/cms/src/api/`):

| Type                | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **department**      | Top-level org unit with head, members, teams, pages. Master data **without draft & publish**: one row per department with a stable id; saving in the admin is live immediately (no Publish/Unpublish), hiding a unit means deleting it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **team**            | Belongs to a department, has a lead and members. Like department: **no draft & publish**, one row per team, a save is live                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **announcement**    | Dashboard news items, targeted via `audience` / `audienceRoles` / departments; optional read confirmation (`requiresAck` + `ackDeadline`); from its `expiresAt` instant it leaves lists, threads and digests for everyone but admins/editors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **acknowledgement** | Read receipt for a mandatory announcement — one per user, anchored to the target's **`targetDocumentId`** (stable across re-publish), immutable once created. Only the announcement's audience can acknowledge it; anyone else gets the same 400 as for a missing announcement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **comment**         | Comments on announcements and wiki pages (`targetType` + `targetDocumentId` — the target's documentId, stable across re-publishes; no FK). Reads and creates are filtered to targets the caller may see (#28); an unpublished announcement's thread answers like a missing target until it is published again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **reaction**        | Emoji reactions, same polymorphic `targetType`/`targetDocumentId` anchor and the same #28 target-visibility enforcement. `create` toggles; with the optional boolean `reacted` it sets that end state instead (a repeated request changes nothing). Two simultaneous creates can both store it; each create keeps the oldest copy and deletes the others right after its insert. Removing deletes every copy (also copies from an older release). Delete takes the documentId or the numeric id                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **kudos**           | Peer recognition (`from` → `to` user, message, company value); `from` is always the sender, `to` must be another user's id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **notification**    | Per-user notification rows (recipient, actor, link), written by the lifecycles through `apps/cms/src/utils/notify.ts` (one row per recipient, titles at most 255 characters, shortened with `…`). Publishing an announcement or event notifies its targeted users whose role holds the type's read grant (`announcement.find` / `event.find`, read from the permissions table at runtime) and who are not blocked, after the publish is saved, with the title and audience of the entry as saved at that moment; one failing row costs that recipient only, and the next publish delivers it. Admins and editors get strictly the targeted audience. Comment and kudos notifications are also written after the comment or kudos is saved, so a failing notification never discards it. Mark-read takes up to 200 ids and only ever changes the caller's own unread rows; delete takes the documentId or the numeric id |
| **event**           | Calendar events, ICS export via custom route (`/api/events/:documentId/ics`; the numeric id of the published row still works, anything else is a 404; the calendar `UID` is built from the documentId, so it survives a re-publish; the file name follows RFC 6266, so any title works, and the file carries `SEQUENCE`/`LAST-MODIFIED` from the last change; the description is exported as plain text, its first 10 000 characters); optional RSVP (`rsvpEnabled` + `capacity`). `departments` decide who is notified, not who can read: every role with `event.find` (guest included) sees all published events                                                                                                                                                                                                                                                                                                      |
| **event-rsvp**      | Attendance answer (`yes`/`no`/`maybe`) per user + event, anchored to the event's `documentId`; `create` is an **upsert**; the capacity gate, like the summary, counts each user's newest answer. Raw reads (`GET /api/event-rsvps`, `/:id`) return only the caller's own rows (admin: all); everyone else's answers come aggregated from `GET /api/event-rsvps/summary?targets=<documentIds>` (at most 50 published events per request: the yes/maybe/no counts, the names of the "yes" answers and the caller's own answer; who answered maybe or no never leaves the cms)                                                                                                                                                                                                                                                                                                                                             |
| **poll**            | Question + options (2 to 10 different, non-empty answers, checked for every writer including the admin panel), `closesAt`, `anonymous` flag, author (set to the caller on `POST /api/polls`), **department targeting** (`departments` + `audience`, see below): a poll without departments is company-wide (every signed-in role sees it, votes and sees its results; guests only as below); a poll with departments is visible, votable and has results only for the members of those departments, while admins and editors see every poll and its results but vote only in their own department's polls. **Guest access** (`visibleToGuests`, `guestsCanVote`, both off by default): hidden from guests unless an admin or editor opens the poll to them                                                                                                                                                              |
| **poll-vote**       | One vote per user per poll, cast and counted only via the custom `POST /api/polls/:id/vote` and `GET /api/polls/:id/results` routes; `:id` is the poll's documentId (what the web sends; it survives a republish) or its published row id. There are no generic `/api/poll-votes` routes. A vote cannot be changed, so the results count each voter's first ballot only (the lowest row id), in one SQL statement with a GROUP BY, and a vote removes the voter's later rows right after it is stored (parallel votes)                                                                                                                                                                                                                                                                                                                                                                                                  |
| **document**        | File library entry; `departments` m2m — no relation = company-wide; `audience` = `departments` (set on every row that links a department, by each write and a boot backfill) keeps it admin/editor-only once its departments are gone (deleted or removed) until re-targeted or set back to `all`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **classified**      | Employee marketplace ad (`/marketplace`): 5 categories (sale, giveaway, wanted, service-offer/-wanted), up to 4 photos, `expiresAt` auto-set to +30 days (max 90) — expired ads drop out of the list at once and are deleted, with their photos, 90 days after `expiresAt` (03:45 cron)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **quick-link**      | Central link gateway on the dashboard (label, URL, icon, category, order); `departments` m2m — no relation = company-wide; `audience` as for documents. No frontend editing UI — maintained in the Strapi admin panel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **course**          | Training course (draft & publish): ordered lessons, `mandatory` flag, `completionMode` (`confirm` \| `quizGate` — quiz must be passed before completion unlocks). Maintained in the Strapi admin panel; the content api is read-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **lesson**          | One lesson of a course: markdown body, `order`, YouTube-only `videoUrl` (validated in a lifecycle AND render-gated in the web player), `quiz` JSON self-check (quiz text typed in the admin panel is parsed and stored as the array; a cleared quiz is stored as null). First validating `beforeCreate`/`beforeUpdate` lifecycle in the repo (admin writes bypass content-api controllers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **lesson-progress** | Completion receipt per user + lesson, anchored on the lesson's `documentId` (survives re-publish); own-rows read policy, admin report at `/manage/training`. Course completion is derived at read time — a lesson added later re-opens the course                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **search-log**      | Anonymous search telemetry (term + result count, deliberately NO user relation): write-only content api, aggregated admin-only `/search-logs/summary`, 90-day retention cron. Feeds the Meilisearch go/no-go decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **wiki-space**      | Namespace for wiki pages with scoped visibility; `icon` takes an icon-map name (as quick links), else the book icon                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **wiki-page**       | Markdown body, tags (chips), `order` in the space's list, table of contents unless `tocEnabled` is false, parent/children, author, revisions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **wiki-revision**   | Auto-captured snapshot of a page before each update                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| _profile_           | Routes-only API (no schema): `GET`/`PUT /api/me` self-service profile (incl. the birthday fields and the e-mail digest opt-ins below). `PUT` trims display name, job title, phone and office location, answers 400 above 255 characters, stores an empty display name as null and accepts `locale` `en` or `de` only. For a user bound to Microsoft Entra those four fields belong to Entra: `PUT` ignores them and both answers list them in `entraManagedFields` (the form shows them read-only)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| _entra-auth_        | Routes-only API (no schema): `POST /api/auth/entra/exchange`, the server-to-server step of the Microsoft sign-in (`auth: false`; authenticated by `ENTRA_EXCHANGE_SECRET` and the cms's own ID-token check). 404 while `ENTRA_ENABLED` is not `1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Draft & publish.** announcement, course, document, event, lesson, poll,
quick-link, wiki-space, wiki-page and wiki-revision keep Strapi's draft &
publish (pinned per type in `apps/cms/src/content-type-flags.test.ts`): each
entry has a draft row, which the admin panel edits, and once published a
published row, which readers get. An entry with a published row but no draft
(the demo seed wrote its content that way until 2026-09-26) is hidden from
the Content Manager's default list and loses relations when edited and
published there. The cms therefore gives every such entry its draft twin at
boot, with Strapi's own "discard draft" copy of the published row
(`apps/cms/src/utils/draft-twins.ts`; the first boot logs
`[draft-twins] created N draft(s) for <type>`, later boots nothing). Wiki
revisions are published snapshots written by a lifecycle and stay that way.
Drafts that already exist are never replaced: a course, wiki space or page
whose lesson or child page has a saved, unpublished move elsewhere gets its
draft once that move is published or discarded (the log names the draft),
and a draft saved before the upgrade keeps any relations it already lacked,
so publishing it still drops them. The runbook lists both kinds up front:
[Upgrading to the draft-twin repair](./docs/DEPLOYMENT.md#upgrading-to-the-draft-twin-repair-fx38).

**Poll department targeting** (enforced by the cms, not only in the UI):

| Caller                                              | Poll without departments                                      | Poll whose departments include the caller's | Poll of other departments               |
| --------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------- | --------------------------------------- |
| member, team lead, department head, `authenticated` | see, vote, results                                            | see, vote, results                          | not found (list, detail, vote, results) |
| guest                                               | as the poll's guest access says (below); by default not found | the same                                    | not found                               |
| admin, editor                                       | see, vote, results                                            | see, vote, results                          | see and results; voting refused         |

- "The caller's department" is the `department` of their user record
  (Strapi admin → Content Manager → User). Role never adds membership; a
  user without a department sees company-wide polls only. A department
  change applies on the next request; votes already cast stay counted.
- A poll is restricted when its **Audience** field (`all` | `departments`)
  is `departments` **or** it has departments. Only the flag keeps a poll
  restricted after all its departments are deleted (then only admins and
  editors see it, and the card asks to re-select departments), so the cms
  sets it itself: every save of a poll that leaves departments selected
  (admin panel, content API and web form alike, draft and published row,
  in the same transaction) sets Audience = `departments`
  (`apps/cms/src/utils/poll-audience-guard.ts`), and deleting a department
  sets it on every poll that still has the department
  (`api/department/content-types/department/lifecycles.ts`, for rows
  written outside the cms, e.g. by a previous release during a rollback).
  To open a restricted poll to everyone, remove its departments **and** set
  Audience to `all`; Audience `all` with departments still selected is
  saved as `departments`.
- Where it is enforced: the `poll-visibility` read policy (list and
  detail), the custom `vote`/`results` actions and the batched
  `GET /api/poll-results`, all through
  `apps/cms/src/utils/poll-audience.ts`. Departments are compared by
  documentId. `results` also tells the web whether the caller may vote
  (`canVote`) and which departments a poll targets.
- Existing polls get their Audience on the first boot of this release
  (`[poll-audience] set the audience of N existing poll row(s) …`), in one
  transaction: if it fails, nothing is changed and the cms does not start
  (a poll row without the flag could leave a restricted poll open):
  [Upgrading to poll department targeting](./docs/DEPLOYMENT.md#upgrading-to-poll-department-targeting).

**Poll guest access** (owner decision 2026-09-27; enforced by the cms, in
the same rules module): polls are **hidden from guests** (role type exactly
`guest`) unless an admin or editor opens them, per poll, with two fields
(admin panel and the `/polls/new` form):

| Visible to guests | Guests can vote | A guest in the poll's audience                                                                                                          |
| ----------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| off (default)     | any             | not found: not listed, not in search, 404 on results and vote                                                                           |
| on                | off             | sees the poll and its results; a vote answers 403 "Guests cannot vote on this poll" and the card says "Guests can't vote on this poll." |
| on                | on              | sees, votes, results                                                                                                                    |

- The department rule still applies: a guest never gets a poll of another
  department. "Guests can vote" without "Visible to guests" does nothing.
  NULL (a poll from before the fields) counts as off; nothing is
  backfilled. Every other role is unaffected by the two fields.
- `canSeePoll` and `canVoteOnPoll` in `apps/cms/src/utils/poll-audience.ts`
  decide for the list/detail policy and the vote/results actions alike;
  results return both fields and `canVote`. Admins and editors see
  "Visible to guests" / "Guests can vote" on the cards that have them; a
  guest with no poll open to them sees "No polls for you yet" instead of
  the generic empty state. Both fields apply once the poll is published
  (the admin-panel descriptions say so).
- Rolling back to a cms from before guest access: that cms ignores both
  fields and never removes the guest vote permission, so it goes first,
  with the cms stopped and before the retag, and once more after the
  start, whatever the database shows at the time
  (`infra/rollback/revoke-guest-poll-vote.sql`; `infra/deploy.sh` prints
  the steps when a deploy fails; see
  [Upgrading to poll department targeting](./docs/DEPLOYMENT.md#upgrading-to-poll-department-targeting),
  Rollback).
- No other path hands a poll to a guest: notifications, live pings,
  e-mail digests, comments and reactions never concern polls, the search
  goes through the filtered `/api/polls`, and relations into polls are cut
  by the relation guard (`apps/cms/src/poll-exposure.test.ts` pins this and
  fails when a new module starts reading polls).

The users-permissions **User** is extended with `department`, `teams`,
`manager` (self-relation, drives the org chart; paired with its inverse
`directReports`, which the person page shows as _Direct reports_), the
schema-`private` Entra columns `microsoftOid` and `entraTenantId` (the
identity of a Microsoft user; an admin sets both, lower-case, to bind an
existing account once its owner is confirmed), `roleSource` (`entra` |
`manual`, empty = manual: who owns the role), `entraAppliedRole` and
`entraManagerOid` (all read only by the
Entra exchange; like `digestFrequency` also `searchable: false`, so no `_q`
finds them), and the
schema-`private` pair `birthday` / `birthdayVisible`: birthdays are strictly
**opt-in** (maintained via `/api/me`, never exposed through user reads) and
only surface — without the year of birth — in the celebrations feed when
`birthdayVisible` is set. Since the e-mail digests (#18) the user also
carries `digestAnnouncements` / `digestMentions` / `digestKudos` (booleans),
`digestFrequency` (`daily` | `weekly`, default weekly) and the cron-owned
`lastDigestAt`, all schema-`private` — the opt-ins are maintained on the
profile page via the same `/api/me` whitelist. Digests go only to users
whose role holds `announcement.find`, never to guests or blocked users (the
kudos section also needs `kudos.find`); guests see no digest options, and
`PUT /api/me` ignores theirs. A digest lists at most 25 announcements the
user may read, then "+N more"; an announcement that was edited and
published again is not repeated for users its bell reached before their
digest window, nor for its author. A weekly digest is due whenever the last
one is older than this week's Monday, so a missed Monday is caught up the
next morning.

Six roles are created automatically on Strapi boot (see
[`apps/cms/src/bootstrap/roles.ts`](./apps/cms/src/bootstrap/roles.ts), the
one role vocabulary the cms code decides by):
`admin_role`, `editor`, `department_head`, `team_lead`, `member`, `guest`.
The same bootstrap grants each role sensible default REST permissions on
every intranet content type (broad reads, writes scoped per role — with the
deliberate `guest` exceptions listed under the permission matrix below).
Writes are then further gated by the route-level policies listed below.
The boot refuses to start when a granted action matches no controller
action it loaded (a typo or a renamed action, listed in the error), writes
all missing grants and revocations in one transaction, and logs one
`[bootstrap] permission drift` line: `none`, or the grants on actions the
code manages that it does not want (report-only, e.g. added in the admin
panel).

Policies at `apps/cms/src/policies/` enforce scoped access.

Write-side guards:

- `is-admin-or-editor` — global write guard
- `can-edit-department` — department update only by the `department_head`
  of that department, and only `description` and `color` (`#rrggbb`);
  `admin_role`/`editor` bypass
- `can-edit-team` — team update only by the team's lead or the head of its
  department, and only `description`; plain team members get 403 (the
  former `is-team-member-or-lead` let them through); `admin_role`/`editor`
  bypass
- `can-edit-wiki` — wiki page create (any non-guest holding the grant, i.e.
  `department_head` and `team_lead`) only into a space the author can read;
  update by the page's author, the head of its department or the lead of its
  team, and only while the page sits in a space the caller can read (403
  otherwise); fields limited as described below; `admin_role`/`editor`
  bypass
- `is-classified-author` — marketplace ad update/delete only by its author
  (update: `admin_role` bypass only; delete: `admin_role`/`editor` bypass
  for moderation)
- `is-event-rsvp-owner` — RSVP update only by the responding user (admin
  bypass; deliberately **no** editor bypass — an RSVP is a personal statement,
  not content)
- `is-reaction-author` — reaction delete only by its author (admin/editor bypass)
- `is-notification-recipient` — notification delete only by its recipient (or admin)

**Field-level write allowlist (FX07).** The three write policies above
decide _whether_ a caller may write a row and in which role class (head,
lead, author, …); `apps/cms/src/utils/write-allowlist.ts` decides _what_ a
caller without the `admin_role`/`editor` bypass may send. It is the single
place those payload rules live and the extension point for frontend
authoring (v2, see [architecture.md §5.34](./docs/architecture.md)):

- A department head may write `description` and `color` of their own
  department; a team lead, or the head of the team's department, the team's
  `description`. Wiki pages: `title`, `body`, `summary`, `tags`,
  `tocEnabled`, `order` and `parent`, plus `space` on create and
  `revisionSummary` on update.
- Everything else (`pages`/`members`/`teams`/`head`/`lead` connects, `name`,
  `slug`, media, `space` on update, `children`, `revisions`, `author`,
  Strapi's own keys) and every refused value answer one generic
  `400 Invalid or disallowed data field(s): <keys>`. A hidden, missing,
  draft-only or wrong-space target gets the same answer, so the response
  never reveals whether a hidden row exists.
- Relations are rewritten to documentIds. A page's `space` must be a space
  the author can read, its `parent` a readable page of the same space (not
  the page itself or a descendant). `author`/`lastEditor` are set to the
  caller, a new page's `slug` is derived from its title plus a random
  suffix, and these writes always publish (`?status=draft` is pinned away).
- `routes.matrix.test.ts` fails when a write route that a non-bypass role
  holds on these types, or on any relation into the wiki, skips the
  allowlist.

The web has no write path for wiki pages, departments or teams; these rules
govern direct API calls. Department-head and team-lead rights compare
department and team row ids. That is valid because departments and teams
have no draft & publish (one row each, stable id; see
[architecture.md §5.35](./docs/architecture.md)). An instance that ran an
earlier release with org drafts runs the one-time migration first
([One-time: org draft/publish off](./docs/DEPLOYMENT.md#one-time-org-draftpublish-off));
the cms refuses to boot until then.

Read-side filters:

- `wiki-visibility` — read filter based on `space.visibility` (public / role /
  department / team)
- `document-visibility` — read filter: documents without a `departments`
  relation are company-wide, otherwise only the owning departments see them
  (admins/editors always pass)
- `quick-link-visibility` — same `departments`-relation scheme as documents
- `notification-visibility` — reads restricted to the caller's own rows
  (recipient = caller)
- `published-only` — pins reads without a row filter (event, department,
  team) to `status=published`, so `?status=draft` no longer
  returns unpublished entries; admin/editor bypass and keep draft reads.
  department and team have no drafts of their own any more, but `status`
  still decides which rows of their populated draft & publish relations
  come back. The custom ICS, vote and results actions read published rows
  only as well
- `poll-visibility` — poll department targeting and guest access (see
  above): the published polls the caller may see (audience, and for a guest
  "Visible to guests"), resolved to a non-relational id filter; pins
  `status=published`; admin/editor bypass (drafts included)
- `acknowledgement-visibility` — reads restricted to the caller's own read
  receipts; `admin_role` bypasses for the `/manage/acknowledgements` report
- `event-rsvp-own-rows` — raw RSVP reads restricted to the caller's own
  answers (`$and`-ed onto the request, so a client filter only narrows);
  a client filter on the `user` relation answers 400. `admin_role`
  bypasses (corrections); editors do not. The event-rsvp controller also
  answers 400 to a `Strapi-Response-Format` header from anyone but
  `admin_role`. The events page reads everyone else's answers only through
  the aggregated `summary` action
- `announcement-visibility` — server-side audience targeting (#9):
  department AND team AND audienceRoles, resolved to a non-relational id
  filter; pins `status=published`
- `comment-target-visibility` — comment/reaction reads filtered to targets
  the caller may see (#28; the create counterpart lives in the controllers
  via `isTargetVisible`). A read that pins exactly one
  `{targetType, targetDocumentId}` with `$eq` (the web's comment sections)
  checks only that target; any other filter resolves every visible target.
  Both judge a target by its published row when it has one, so a wiki space
  widened or a page moved only in an unpublished draft, or a published page
  whose space was never published, opens no threads
- `training-visibility` — courses/lessons pinned to `status=published`;
  lessons only visible when their owning course is published (fail-closed);
  admin/editor bypass for draft preview (#29)
- `lesson-progress-visibility` — reads restricted to the caller's own
  completion receipts; `admin_role` bypasses for the `/manage/training`
  report (#29)

The read-side policies share helpers in `apps/cms/src/utils/`:
`policy-query.ts` provides `getMutableQuery` (policies must mutate the real
Koa `request.query` — `policyContext.query` is a copy the core controllers
never read), `narrowFilters` (a policy's clause is always `$and`-composed
with the client filter, never spread-merged, so a client filter can only
narrow the result) and `restrictiveIdFilter` (an empty id allow-list is
injected as `{ id: { $eq: -1 } }` because Strapi's query sanitizer strips an
empty `$in: []`, which would fail **open**), `boundedIdFilter` (the same for
a list longer than the guard admits — one SQL statement binds at most 65535
parameters on Postgres and 32766 on SQLite, and the guard keeps 1000 of
them as headroom for the rest of the statement: the policy answers with
nothing and logs a `[policy]` error line; past the engine limit that
replaces a 500, and in the headroom window just below it the list is now
empty where it used to be served. It covers the loaders that bind only an
id list: wiki pages and revisions, lessons and the comment and reaction
wiki anchors. The announcement, document, quick-link, poll, wiki-space and
team loaders read whole tables with `populate` and still fail with a 500
past the engine limit, with no data returned and no `[policy]` line; see
[architecture.md §5.63](./docs/architecture.md)), and
`forcePublishedStatus` (after the `admin_role`/`editor` bypass: pins
`status=published` and drops the
publication-cohort keys `publicationFilter`/`hasPublishedVersion` and the
v4 `publicationState`, so a reader can neither fetch drafts nor learn which
published entries have pending edits). `policy-factories.ts` builds the
policies from those steps, so each policy file only states its rules:
`ownRowsFilter` (own rows: acknowledgements, notifications, lesson
progress, RSVPs), `visibleIdsPolicy` (ids resolved server-side:
announcements, documents, quick links, wiki, polls, lessons) and
`ownerGate` (write/delete only by the row's owner: classifieds, RSVPs,
notifications, reactions); it also holds `findByRef`, the id lookup the
ownership gates and the classified, comment and RSVP controllers share. The
role check everywhere is `hasRole(user, roles)` from `bootstrap/roles.ts`
(exact role types; a caller without a numeric user id owns nothing).
`visible-ids.ts` (`loadUserScope`, read once per request and user;
`visibleWikiSpaceIds`) resolves per-user wiki-space visibility,
`target-visibility.ts` (`visibleTargetAnchors`, `isTargetVisible`) decides
comment/reaction target visibility for #28, and
`wiki-edit-context.ts` carries the authenticated editor from the wiki-page
controller into the revision-snapshot lifecycle via `AsyncLocalStorage`, so
revisions written through the REST API record who actually edited (edits in
the Strapi admin panel have no such context).

Every custom handler and policy that looks an entry up by an id from the
request (a route `:id`, or ids in a request body) checks it first with
`apps/cms/src/utils/entry-id.ts` (poll vote/results take either form,
the documentId from the web): a positive row id within the int4
range, or a documentId in the shape Strapi generates (the FX07 write policies keep
their own, wider documentId rule). Anything else answers like an unknown
entry (404, or `false` in an ownership policy) or, for a body, 400. Postgres
used to fail such a lookup, which Strapi answered with a 500. The web's ICS
route applies the same check (`apps/web/src/lib/entry-id.ts`; both files
re-export it from `@sinnlos/domain`).

Global guards that apply to **every** content-API route, not per route:

- **Relation guard** (`registerRestrictedRelationGuard` in
  `src/bootstrap/restricted-relation-guard.ts`,
  rules in `utils/restricted-relations.ts`) — a relation into a
  visibility-filtered type is only followed from that type's own filter
  domain. Today this protects wiki pages: `department.pages`/`team.pages`
  (and any chain that reaches them, e.g. `/api/users?populate[department]…`)
  are dropped from `populate`, rejected with a 400 in `filters`/`sort`, and
  deleted from responses. Polls are guarded the same way, with no trusted
  source at all (the one relation into them, `poll-vote.poll`, has no
  content-API route). `admin_role`/`editor` bypass it. It wraps
  `strapi.contentAPI.sanitize.query`, so it covers core, users-permissions
  and upload routes, reads and writes. Boot fails if that hook point
  disappears after a Strapi upgrade.
- **Root query-key allowlist** (`utils/rest-query-params.ts`, same wrapper,
  every role) — keys outside Strapi's REST parameters (`where`, `orderBy`,
  `select`, `groupBy`, `offset`, …) are dropped before any service sees
  them. Without it they reached `strapi.db.query` unchecked on
  `/api/users`. Strapi 5.55.1's user service now applies the same pick
  itself; the wrapper stays as defence in depth and for the upload routes.
- **Contact-field sanitizer** (`registerUserContactSanitizer`, #10) —
  removes email/phone/hireDate/officeLocation/microsoftOid from every
  response to callers outside the five staff roles (guest, the
  `authenticated` fallback, unknown roles).
- **`global::sensitive-query-guard`** (FX22) — the query side of the same
  rule: for those callers a filter, sort, nested populate filter/sort or
  users `_q` on one of these fields answers 400 `Invalid key`, on
  `/api/users*` and through every user relation. Staff roles and the admin
  panel are unaffected. Its factory wraps `strapi.contentAPI.validate.query`
  at boot (global middlewares run before authentication); each refusal is
  logged as `[sensitive-query-guard] 400 …`.
- **`global::uploads-auth`** middleware — `/uploads/*` file bytes only for
  requests carrying `INTERNAL_UPLOAD_TOKEN` (i.e. the web's session-gated
  proxy); everything else gets 404, whatever the encoding of the path. The
  web proxy itself also asks Strapi whether the session's JWT is still
  accepted (a blocked account loses the files within 60 s, FX41).
- **`global::auth-path-guard`** middleware — any spelling of `/api/auth/*`
  other than the literal lowercase one (`/api/Auth/local`, `%61uth`, `//`,
  `..`) gets 404. Traefik's `/api/auth` rule is case-sensitive but Strapi's
  router is not, so such paths used to reach Strapi's local login past the
  web's login rate limiter.

### Role flow: sign-in → Strapi → frontend

A user's role lives in Strapi (`user.role`) and is read **per request**.
Nothing role-related is stored in the web session, so a role change in the
Strapi admin applies on the user's next page load, without a new sign-in:

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Sign-in (web/src/auth.ts, Auth.js)                          │
│     local:     POST /api/auth/local → Strapi JWT                │
│     Microsoft: ID token + Graph token (ENTRA_ENABLED=1) →       │
│                POST /api/auth/entra/exchange → Strapi JWT       │
│                (the cms verifies, provisions, sets the role)    │
│     The JWT stays in the encrypted session cookie only          │
│     (never on /api/auth/session); the session ends when         │
│     that JWT expires                                            │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼ every request
┌─────────────────────────────────────────────────────────────────┐
│  2. getViewer() (web/src/lib/viewer.ts)                         │
│     GET /api/me with the caller's JWT → role.type, department   │
│     once per render; 401 → /sign-in?expired=1;                  │
│     any other error → no role (every gate denies)               │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼ viewer.role (string | null)
┌─────────────────────────────────────────────────────────────────┐
│  3. Frontend UI gating (web/src/lib/roles.ts, fail-closed)      │
│     isAdmin / canCreatePolls / canRsvp / canPostAds             │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼ Server Action / fetch with the caller's JWT
┌─────────────────────────────────────────────────────────────────┐
│  4. Strapi decides: permission matrix + route policies          │
│     + the write allowlist + the global guards above             │
└─────────────────────────────────────────────────────────────────┘
```

When the session has ended (its Strapi JWT expired, or the cms rejects
it), every path ends on the sign-in page with the "session expired"
notice: `web/src/proxy.ts` sends a page load to `/sign-in?expired=1&from=…`
and answers a Server Action (a button or form on an open page) with the
redirect Next's action client follows, instead of a 307 it cannot use;
a form posted without JavaScript gets a 303, so the browser loads the
sign-in page with a GET instead of posting the form to it again;
a Strapi 401 inside a render or an action redirects the same way.

**Microsoft Entra ID → Strapi role** (only with `ENTRA_ENABLED=1`;
[`apps/cms/src/entra/roles.ts`](./apps/cms/src/entra/roles.ts)). The app
roles come from the signed ID token; the highest privilege wins:

| Entra app role (or `ENTRA_GROUP_ROLES` group) | Strapi `role.type`                                                    |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `Intranet.Admin`                              | `admin_role`                                                          |
| `Intranet.Editor`                             | `editor`                                                              |
| `Intranet.DepartmentHead`                     | `department_head`                                                     |
| `Intranet.TeamLead`                           | `team_lead`                                                           |
| `Intranet.Member`                             | `member`                                                              |
| `Intranet.Guest`                              | `guest`                                                               |
| _(tenant member, no match)_                   | `ENTRA_DEFAULT_ROLE`: `member` (default), `guest` or refused (`deny`) |
| _(B2B guest, no match)_                       | refused                                                               |

`ENTRA_GROUP_ROLES` (optional, `<roleType>:<groupObjectId>,…`, at most 20
groups) adds group **object ids** checked through Graph
`/me/checkMemberGroups`, for nested groups or tenants without Entra ID P1;
group names are never matched. Who owns a user's role is stored per user
(`roleSource`): users the sign-in created are `entra` and follow Entra at
every sign-in; every account that existed before, and every account whose
role an admin changes in the Strapi admin, is `manual` and keeps its role.
A Graph failure never changes a role. `ENTRA_SYNC_MODE=dry-run` (the
default) only logs what Entra would change and creates new users as
`member` at most; `on` applies it.

`guest` is otherwise assigned by an admin in Strapi.
`authenticated` is the users-permissions plugin's built-in role. The
bootstrap forces `default_role = member` on every boot, so new local users
start as `member`, and the Entra sign-in creates its users with an intranet
role; `authenticated` only applies to accounts an admin (or an older
version) put there. Its permissions mirror `member`-level read access so the
dashboard still works for such accounts.

**Strapi role capabilities** (REST API permissions seeded by
`PERMISSION_MATRIX` in `apps/cms/src/bootstrap/permission-matrix.ts`, further gated by the policies
above; `R` = find + findOne, `C` = create, `U` = update, `D` = delete):

| Role                         | Announcements | Acks · RSVPs | Depts / Teams | Docs · Events · Polls | Classifieds | Quick-links | Wiki spaces · pages · revisions | Comments · Reactions | Kudos | Notifications | Courses · Lessons / Progress | Search-log |
| ---------------------------- | ------------- | ------------ | ------------- | --------------------- | ----------- | ----------- | ------------------------------- | -------------------- | ----- | ------------- | ---------------------------- | ---------- |
| `admin_role`                 | CRUD          | CRUD         | CRUD / CRUD   | CRUD                  | CRUD        | CRUD        | CRUD                            | R+C+D                | R+C+D | R+D           | R / R+C                      | C          |
| `editor`                     | CRUD          | R+C · R+C+U  | R / R         | CRUD                  | CRUD        | CRUD        | CRUD                            | R+C+D                | R+C+D | R+D           | R / R+C                      | C          |
| `department_head`            | R             | R+C · R+C+U  | R+U / R+U     | R                     | CRUD        | R           | R · R+C+U · R                   | R+C+D                | R+C   | R+D           | R / R+C                      | C          |
| `team_lead`                  | R             | R+C · R+C+U  | R / R+U       | R                     | CRUD        | R           | R · R+C+U · R                   | R+C+D                | R+C   | R+D           | R / R+C                      | C          |
| `member`                     | R             | R+C · R+C+U  | R / R         | R                     | CRUD        | R           | R · R+U · R                     | R+C+D                | R+C   | R+D           | R / R+C                      | C          |
| `guest`                      | —             | — · —        | — / —         | R                     | —           | R           | R · R · —                       | R                    | —     | R             | — / —                        | C          |
| `authenticated` _(fallback)_ | R             | R+C · R+C+U  | R / R         | R                     | R           | R           | R                               | R+C                  | R+C   | R             | R / R+C                      | C          |

No role holds any `poll-vote` CRUD grant: votes are cast and counted only
through the custom `vote`/`results` actions below, which every role holds
(guest included), and the batched `GET /api/poll-results?ids=` (poll
`batchResults`, every role, the `/polls` page's one results request);
whether a caller may see or vote on a given poll is decided per poll by
the department targeting and the guest access above.

Fine print encoded in the matrix (and enforced by the policies/controllers):
acknowledgements are **immutable read receipts** — only `admin_role` may
update/delete them; RSVP `delete` is admin-only across all roles (removing
someone else's RSVP is an admin correction) and `update` is ownership-gated;
classified `CRUD` for non-admins is ownership-gated by `is-classified-author`;
department/team `U` for department heads and team leads is gated by
`can-edit-department`/`can-edit-team` and limited to the write allowlist
above (description, plus colour on the head's own department), and wiki
page `C`/`U` by `can-edit-wiki` and the same allowlist;
course/lesson content-api **write routes do not exist at all** (`only:
["find", "findOne"]` routers — authoring happens in the Strapi admin);
`search-log` is write-only telemetry — nobody lists raw rows, aggregates come
from the admin-only `summary` route.
Generic core routes the web never calls are **removed** from the routers
(`only:`), not merely left ungranted: all of `/api/poll-votes`, notification
create/update (rows are written by CMS lifecycles only), comment, kudos and
reaction update, and lesson-progress update/delete (receipts are immutable).
Corrections of those rows happen in the Strapi admin panel. Their permission
rows are revoked for every role on boot (`REMOVED_CORE_ACTIONS` →
`REVOKED_PERMISSIONS`); the first boot after an upgrade logs
`[bootstrap] revoked N obsolete permission(s)`. `routes.matrix.test.ts`
pins every content-API route to its policies and cross-checks the grants
against the routes that exist.
`guest` is a deliberate exception on five modules: **no kudos** (celebrations
leak hire dates), **no classifieds** (the flea market is internal and ads
populate author contact data), **no announcements and therefore no
acknowledgements** (a guest can never see a mandatory announcement, so ack
grants were dead attack surface), **no event-rsvp** (guests read the
calendar but neither respond nor see attendee names, and hold no RSVP
`summary` grant either), and **no training**
(no course/lesson/lesson-progress grants at all — while `search-log.create`
IS granted to guest: search telemetry is anonymous by design). Guests hold
the poll read, results and vote grants, but see and vote only on the polls
an admin or editor opened to them (poll guest access above, in the poll's
audience like everyone else; a rollback to a cms from before guest access
removes the vote grant first). Grants that older
bootstrap versions handed to `guest` are actively removed again via the
`REVOKED_PERMISSIONS` mechanism in the same file (the boot sync only ever
_adds_ rows, so revocations must be listed explicitly to take effect on
existing databases; any other grant the code does not want is only reported
by the boot's `[bootstrap] permission drift` line).

Every role in the matrix — **including `guest`** — additionally gets
`user.find`/`findOne`/`me` (so populated relations like author/lead/head
survive); this also powers the people directory. No role is excluded:
an earlier audit attempt to revoke the grant from `guest` turned every guest
read that populates a user relation (and the notification visibility
filter) into a 400, because Strapi's core controllers run
`validateQuery` → `throwRestrictedRelations` _before_ the sanitize pass.
(On Strapi 5.55.1 such a populate is dropped silently instead of failing,
which would still strip every author and uploader name from guest pages;
filters through a user relation still answer 400.)
The contact fields a guest could read that way (email, phone, hireDate,
officeLocation, microsoftOid) are removed output-side by the contact-field
sanitizer (#10), and filtering or sorting by them is refused query-side
(`global::sensitive-query-guard`, FX22; see the global guards above). Custom (non-CRUD) route
actions (ICS export, celebrations — staff roles only, not `guest` or
`authenticated` —, poll `vote`, `results` and the batched poll
`batchResults` (`GET /api/poll-results?ids=`, up to 50 polls) — every
role, `guest` included, narrowed per poll by the department targeting and
the guest access: a poll the caller may not see is simply left out of the
batched answer —, the RSVP `summary` behind `/events` — exactly the roles that
hold event-rsvp `find` (the staff roles and `authenticated`), never
`guest`; `routes.matrix.test.ts` pins that —,
mark-read/mark-all-read, `/api/me`, `changePassword`,
`role.find` for the admin ack
report, the classified `cleanupUploads` endpoint, the admin-only
search-log `summary` aggregate behind `/manage/analytics`, and the upload
grant below) are seeded via `CUSTOM_ACTION_GRANTS` in the same file.

### Upload hardening

The only content-API upload route, `POST /api/upload` (used for marketplace
ad photos), is wrapped by `apps/cms/src/extensions/upload/strapi-server.ts`
on top of the permission grant — the admin panel's media library uses the
separate admin routes and is unaffected:

- **Create-only** — the core action's `?id=` replace/update path is rejected
  (it would let any uploader overwrite arbitrary existing media).
- **Body allowlist** — the only accepted multipart text field is
  `fileInfo`. Anything else (`ref`/`refId`/`field`, which core would turn
  into a link on _any_ entry — someone else's ad, an avatar, a document —
  or `path`) is rejected with 400.
- **Max 4 files per request, 5 MB per file** (with an `fs.stat` fallback when
  the reported size is missing — never waved through).
- **Strict image allowlist verified by magic bytes** of the temp file, not
  the client-declared mimetype: JPEG/PNG/WebP only. **No SVG** (stored-XSS
  vector) and no GIF (decompression-bomb surface) on purpose.
- **Canonical filename** — the stored name becomes `<stem>.<extension of
the sniffed type>` (core stores and serves by extension, so a JPEG named
  `x.pdf` was served as `application/pdf`). A stem core cannot turn into a
  slug (CJK, emoji or punctuation only) becomes `image`.
- **Uploader attribution** — every stored file is stamped with the caller's
  user id in `provider_metadata.uploadedBy`, also the files already stored
  when a later file of the same request fails (so the orphan janitor can
  collect them); the classified controller only accepts image ids whose
  `uploadedBy` matches the caller (admin/editor bypass), so nobody can
  attach foreign media — avatars, documents, other people's photos — to
  their own ad.
- **Upgrade tripwire** — the wrapper depends on Strapi internals; if a
  Strapi upgrade changes them, the cms fails at boot instead of silently
  serving an unhardened endpoint.

The grant itself (`plugin::upload.content-api.upload`) is only handed to
`member`/`team_lead`/`department_head`/`editor`/`admin_role` — never `guest`
or the `authenticated` fallback — and there are deliberately no
`find`/`findOne`/`destroy` grants on the upload content-API (no browsing or
deleting the media library from outside the admin panel).

**The frontend has no roles of its own.** It reads the viewer's role per
request with `getViewer()` (`apps/web/src/lib/viewer.ts`, `GET /api/me`) and
gates the UI with the fail-closed allowlist helpers in
`apps/web/src/lib/roles.ts` — `null`, unknown or differently-cased roles
never pass, and exclusion checks such as `role !== "guest"` are not allowed:

| Helper           | Roles                                  | Used for                                                                                                                                                                                  |
| ---------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isAdmin`        | `admin_role`                           | sidebar _Admin_ link; `/manage`, `/manage/acknowledgements`, `/manage/analytics`, `/manage/training` (redirect non-admins to `/`); marketplace detail/edit controls for someone else's ad |
| `canCreatePolls` | `admin_role`, `editor`                 | _New poll_ button, `/polls/new`, the create-poll action; the "Visible to guests" / "Guests can vote" notes on poll cards                                                                  |
| `canRsvp`        | the five staff roles + `authenticated` | RSVP controls and the RSVP summary fetch on `/events` (the same roles hold the `summary` grant)                                                                                           |
| `canPostAds`     | the five staff roles                   | _New ad_ button, `/marketplace/new`                                                                                                                                                       |
| `isGuest`        | `guest`                                | wording only, never a gate: the poll card's "Guests can't vote on this poll." instead of the department hint                                                                              |

Poll voting has no role helper: the poll card renders what the cms answers
per poll in `GET /api/polls/:id/results` (`canVote`, the targeted
departments, the guest-access fields), so an admin or editor outside a
poll's departments, and a guest on a poll without guest voting, see its
results with the vote buttons disabled. The page and the card address each
poll by its documentId, so a republish while the page is open does not
break the vote, unless it changed the options: the card also sends the
answer text it showed, and when a reorder or replacement moved that text
the cms refuses the vote ("Poll options changed") and the card reloads,
instead of recording whatever answer now sits at that position.

The marketplace detail/edit pages show the edit/delete controls to the ad's
owner and to `admin_role` (editors can still delete through the API, but the
web shows them no controls). Note the admin area lives under **`/manage`** —
`/admin` is reserved for the Strapi admin panel by the reverse proxy. Every
authorization decision is still made server-side by Strapi's permission
matrix + route policies; the helpers only keep the UI from offering what
Strapi would refuse.

## Internationalization (i18n)

The UI ships in **English and German** via `next-intl`. Locale selection is
**cookie-based** (no locale segment in URLs): `apps/web/src/i18n/locale.ts`
reads the `locale` cookie and falls back to the `DEFAULT_LOCALE` env var
(built-in default `en` when the var is unset or invalid; supported values
`en`, `de`). Users switch languages with the
locale switcher in the UI, which sets the cookie through a Server Action
(`apps/web/src/lib/locale-actions.ts`) and also stores the choice on the
user's profile (`PUT /api/me { locale }`, best-effort, at most 3 s), so
the e-mail digests use it; a user without a stored language gets their
digest in `DIGEST_DEFAULT_LOCALE` (cms env, default `en`). Message
catalogs live in `apps/web/messages/en.json` and
`apps/web/messages/de.json` — new user-visible strings must be added to
**both** files.

The catalogs are typed: `apps/web/src/global.d.ts` declares next-intl's
`AppConfig` with the shape of `en.json`, so `pnpm typecheck` rejects a
`t("key")` or `useTranslations("namespace")` that `en.json` lacks. ICU
arguments are not type-checked (a JSON import types every message as a
plain string), so pass them as the message says;
`apps/web/src/i18n/messages.test.ts` keeps `de.json` in step (same keys,
same arguments). A key built at runtime needs a map typed against the
catalog (`satisfies Record<…, keyof Messages["namespace"]>`), not a cast.

Server Actions never return display text. The mutations behind buttons
answer an `ActionResult` (`apps/web/src/lib/action-result.ts`):
`{ ok: true }` or `{ ok: false, code }`, where `code` is the action's own
code (for example `full` for a booked-out event) or one of `forbidden`,
`notFound`, `invalid`, `conflict`, `unavailable`, `failed`. Wrap the
`strapi()` call in `runCmsAction` (it lets the expired-session redirect
through and maps the CMS answer by status), call the action from a
component through `startCmsAction`, and translate the code there; the
shared texts of `forbidden`, `notFound`, `conflict` and `unavailable` live
in the `actionErrors` namespace. Form actions (`useActionState`) answer
`{ error?, success?, values? }` with codes too; the sign-in, register,
profile and password forms translate theirs through
`apps/web/src/lib/auth/form-messages.ts`.

## 6. Production deployment

The base `infra/docker-compose.yml` ships a **Caddy** reverse proxy so a fresh
self-hosted box works with one command:

```bash
cd infra
cp .env.example .env
# fill in DOMAIN and the secrets; leave the Entra block commented out unless
# you set up Microsoft sign-in (step 2)
docker compose up -d --build
```

Caddy obtains a Let's Encrypt certificate for `$DOMAIN` (a real host name;
without `DOMAIN` it serves only `localhost`, with a certificate from its
internal CA), proxies `/api/*`
(except `/api/auth/*`, which is Auth.js on Next.js), `/admin*`, `/upload*`
(the media-library API) and the other Strapi admin paths to Strapi, and
everything else to Next.js — including `/uploads/*`, the file bytes, which
Next.js serves through its session-gated proxy route. It sends the same
security headers as the production Traefik (HSTS only for a real host name).
Point your DNS A/AAAA record at the host and the stack is live.

### Live production (srv-prod-01, Traefik)

The hosted instance at <https://sinnlos.yurtbay.dev> runs the **same stack
behind the host's shared Traefik** instead of Caddy. A second compose file
(`docker-compose.traefik.yml`) disables the bundled Caddy and attaches `web` +
`cms` to the external `frontend` Docker network with Traefik routing labels:

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
  up -d --build          # compose project name must stay 'infra'
```

Every Traefik router matches the host in `DOMAIN` (`infra/.env`, the bare
host name), so the overlay file is the same for every instance; compose
refuses to render it without `DOMAIN`, and `infra/deploy.sh` (also
`--check`) refuses a value the routers cannot match before anything is
touched: not a bare host name (a scheme, a port), a placeholder such as the
example host, or not the host of `WEB_PUBLIC_URL` and `CMS_PUBLIC_URL`
([docs/DEPLOYMENT.md §3.6 B](./docs/DEPLOYMENT.md#b-shared-traefik-live-production-layout)).
It is one Sinnlos stack per Traefik, though: the router, service and
middleware names are fixed (`sinnlos-*`), so a second instance (employer,
staging) needs its own host or Traefik. Behind the production Traefik it
would delete production's routers (different `DOMAIN`) or share its
services (same `DOMAIN`). The cms router brings its own middlewares, so
`/admin` and `/api` stay up while the web container restarts, and `/live/*`
(the SSE stream) has its own router without compression. The containers
reach each other by the aliases `sinnlos-db`, `sinnlos-cms` and
`sinnlos-web` on the project network, and every container's log is rotated
(5 × 10 MB).

`infra/deploy.sh` wraps this end to end: env preflight (`infra/.env` against
the env contract, and `DATETIME_LEGACY_ZONE` while the running database
still holds pre-contract datetime columns; `infra/deploy.sh --check` runs
only this step) → one deploy at a time (`flock`), a clean checkout and the
GitHub CI result of the commit (a warning; `--require-green-ci` refuses) →
pre-deploy DB backup → build + restart → curl smoke-check → datetime and
live-pipeline smoke (against `SMOKE_URL`, by default `https://$DOMAIN`,
which live-smoke gets as `BASE_URL`) → only then the images are tagged
`infra-{web,cms}:<commit>` and recorded as last-known-good
(`.git/sinnlos-deploy/infra.state`; the newest five SHA tags stay). A failed
deploy prints the rollback commands to the last-known-good tags (the first
run without a state falls back to `:rollback`, the running images it
tagged); `--dry-run` prints the plan and changes nothing. Rolling back to a cms image
from before the datetime contract needs `infra/docker-compose.cms-legacy-tz.yml`
on top (it runs that cms in `DATETIME_LEGACY_ZONE`), and rolling back to a web
image from before the web datetime port needs
`infra/docker-compose.web-legacy-tz.yml` (it runs that web in `APP_TIME_ZONE`,
the zone it renders dates in; in UTC a web from 2026-09-27 on answers 500,
an older one shows UTC times); the rollback commands `deploy.sh` prints
include whichever is needed. TLS, the security
response headers, and the edge rate limits all live at the Traefik layer
(see the override labels). The cms trusts the `X-Forwarded-For` the edge
sets (its sign-in throttles count per client IP), so the host Traefik must
not accept that header from clients. The web and cms containers run
**non-root** with `no-new-privileges` and no Linux capabilities
(`cap_drop: ALL`). Neither needs pnpm or registry access
to start: the web runs `node apps/web/server.js`, the cms Strapi's own
`node_modules/.bin/strapi start` under docker-init (`init: true`). A cms
image from before the ICS and cms start fixes, whose
`docker image inspect -f '{{json .Config.Cmd}}'` shows `["pnpm","start"]`
(including `infra-cms:rollback` right after deploying that release), still
runs `pnpm start` and downloads pnpm at every start, which matters when
rolling back to one. The cms image keeps its dependency tree in its own
layer, copied straight from the install stage, and the app (compiled
`dist`, the migrations, `public/`, the built `@sinnlos/domain`) in another:
while the lockfile is unchanged and the build cache still holds the install
stage, a rebuild for a code change reuses the ~850 MB dependency layer and
writes only the ~15 MB app layer, and the SHA-tagged images of successive
deploys share that layer on disk. Full details — upgrading an existing
instance, backup/restore, rollback, hardening — are in
**[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)**.

## 7. Useful scripts

```bash
pnpm dev               # build packages/domain, then run every workspace in parallel
pnpm build             # build every workspace, packages/domain first (the cms build
                       # deletes apps/cms/dist first)
pnpm build:domain      # build packages/domain (@sinnlos/domain) into dist/cjs + dist/esm
pnpm typecheck         # build:domain, tsc for the package and both apps + typecheck:tests
                       # (also run in CI)
pnpm typecheck:tests   # type-check every *.test.ts: tsconfig.test.json (web + infra,
                       # strict) and tsconfig.test.cms.json (cms, Strapi's settings)
pnpm test              # vitest 4 unit tests from the repo root (also run in CI)
pnpm test:tz           # the same suite under TZ=UTC, Europe/Berlin and Pacific/Auckland
                       # (CI job `datetime`, with Postgres 16 for the *.pg.test.ts suites)
pnpm test:integration  # build:domain, then the real cms booted in process, driven over HTTP
                       # per role, on SQLite (+ Postgres 16 with SINNLOS_TEST_PG_URL); CI job
                       # `integration`
pnpm format:check      # prettier over the tree (CI, blocking)
pnpm cms:dev           # just Strapi
pnpm web:dev           # just Next.js
infra/deploy.sh --check  # validate infra/.env against the env contract, deploy nothing
infra/deploy.sh --dry-run  # every deploy check, then the plan (rollback target, tags); changes nothing
infra/live-smoke.sh    # datetime contract check, then the SSE live pipeline end to end
infra/backup/restore-drill.sh --all <dir>  # off-box: restore the newest encrypted dump into a throwaway Postgres 16
# read-only report of the one-time datetime repair (in the cms container)
node dist/scripts/datetime-migration-report.js [--around <ISO>] [--all] [--baseline <url>]
```

CI (`.github/workflows/ci.yml`) runs on every pull request and on pushes to
`main` (any other branch through "Run workflow"), with a read-only token and
a timeout per job: `build` (typecheck, lint, `format:check`, test, build, a
blocking `pnpm audit --prod --audit-level=critical` and an advisory one at
`high`), `datetime` (`pnpm test:tz` with Postgres 16), `integration`,
`infra` (shellcheck over every shell script; `docker compose config` of
Caddy mode, Traefik mode, which must refuse to render without `DOMAIN`, and
the rollback overrides) and `images · cms`/`images · web` (both Dockerfiles
built with buildx, not pushed). `format:check` and shellcheck block since
the one-time format sweep after batch 10 (the two long hand-formatted docs,
`docs/DEPLOYMENT.md` and `docs/architecture.md`, are in `.prettierignore`). The
`build`, `datetime` and `integration` jobs build `packages/domain` right
after the install. Every action runs at a full commit SHA with its release
tag in a trailing comment (`uses: actions/checkout@<sha> # v4.4.0`), and
each Dockerfile pulls `node:24-alpine` by digest in one `FROM` line (the
stage `node-base` every other stage builds on); `infra/build-pins.test.ts`
refuses an unpinned action, a second base image and a pnpm version that
differs between `packageManager`, CI and the images. Dependabot
(`.github/dependabot.yml`) opens weekly grouped update pull requests for the
npm workspace, the Dockerfiles' base image and the GitHub Actions (it
updates a pinned SHA and its version comment together).
`.gitattributes` stores and checks out every text file with LF.

The Postgres integration suites (`apps/cms/src/database/*.pg.test.ts`: the
timestamptz guard, the one-time repair through Strapi's own migration
runner, the report; `apps/cms/src/utils/entry-id.pg.test.ts`: the request id
checks against an int4 column) run when `SINNLOS_TEST_PG_URL` points at a Postgres 16
they may create schemas in, e.g. a throwaway
`docker run --rm -d -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=test postgres:16-alpine`
with `SINNLOS_TEST_PG_URL=postgres://postgres:test@127.0.0.1:55432/postgres`;
without it they are skipped.

`strapi build` never cleans `apps/cms/dist` (only `strapi develop` does),
and `strapi start` loads every compiled file there. The cms `build` script
therefore deletes `dist` first, so running `pnpm build && pnpm start` from a
working checkout no longer loads compiled files whose sources were removed;
no manual `rm -rf dist` is needed. Do not build the cms while `strapi start`
serves from the same checkout. The Docker build is unchanged (it starts from
a fresh tree).

Tests run on vitest 4.1.11 with an explicit root `vite` 7.3.6: vitest 4
declares Vite as a peer, and without the root devDependency pnpm would reuse
Strapi's Vite 5. File snapshots (`toMatchFileSnapshot`, e.g.
`infra/diagnostics/prod-perm-diff.sql`) are compared verbatim, with no
trimming.

`pnpm test:integration` (roadmap S11, `vitest.integration.config.ts`) is kept
out of `pnpm test`. It compiles the cms once into a temp directory, then each
suite in `apps/cms/src/integration/*.integration.test.ts` boots the real cms
in the test process: `createStrapi` without the admin panel, the real
`register()`/`bootstrap()`, a fresh SQLite file and, when
`SINNLOS_TEST_PG_URL` is set, also a fresh Postgres 16 schema (same
throwaway container as above). One account per role signs in through
`/api/auth/local`, and the suites call the API over HTTP. They cover the
demo seed's draft/published pairs, restarts and the org draft/publish boot
guard, the removed generic routes, `?status=draft` on every draft & publish
type, relation side channels, contact-field filters, guest polls, RSVP
privacy, publish cycles (comment/reaction anchors, votes, RSVPs,
notifications after the commit) and concurrent votes, RSVPs and reactions.
The run needs no network: `fetch` to anything but loopback is refused while a
cms runs, no `.env` file is read (the harness points Strapi's `ENV_PATH` at a
file that does not exist), temp files and schemas are removed, and the
process is pinned to `TZ=UTC` like the container. A run on both engines takes
about one and a half minutes on a fast local machine and about 2.5-4 minutes
(plus about 45 s install) on a 4-vCPU CI-sized machine, most of it the
per-suite boots. New suites use
the harness in `apps/cms/src/integration/harness.test.helper.ts`
(`createTestStrapi`, `loginAs`, `api`, `stop`; its header documents the
fixtures and the stub seam for outbound calls).

Safety nets for refactors (roadmap S03–S06, S09):

- `apps/cms/src/test/strapi-stub.test.helper.ts` is the shared, typed Strapi
  stub for cms unit tests: `db.query` with a where evaluator, select and
  populate like the query engine, a `documents()` service with draft and
  published twins, stubbed services, log spies and transactions with
  `onCommit`. `strapi-stub.test.ts` checks it against the real
  `@strapi/database` on SQLite. What it does not model throws: an unknown
  operator, an `orderBy` on an unknown column or through a relation, a
  Document Service param such as `locale` or `pagination`.
- `apps/cms/src/policies/policies.contract.test.ts` holds every policy in
  `src/policies` to strict booleans, its bypass table and the
  `request.query` rules, and fails for a policy without a table entry.
- `apps/cms/src/framework-contract.test.ts` pins the Strapi behaviour the
  cms relies on, against the installed packages, `@strapi/upload`'s
  `/uploads/(.*)` route included. **Run it before every `@strapi/*` bump**
  (`pnpm vitest run apps/cms/src/framework-contract.test.ts`); its version
  pin fails first on purpose.
- `apps/cms/src/bootstrap.permissions.test.ts` runs the real permission
  sync against the stub: the role|action set it writes on a fresh database
  is a file snapshot (`src/__snapshots__/bootstrap.permissions.txt`), a
  second run writes nothing, revocations, the one-transaction rollback, the
  unknown-action refusal and the advanced settings are pinned.
  `index.lifecycle.test.ts` pins the order of `register()` and
  `bootstrap()`. After a deliberate grant change, rewrite both snapshots:
  `pnpm vitest run apps/cms/src/bootstrap.permissions.test.ts apps/cms/src/prod-perm-diff.test.ts -u`.
- `apps/cms/src/middlewares/sensitive-query-guard.test.ts` also reads
  `apps/cms/config/middlewares.ts`: it fails when the list loses one of the
  global guards (`sensitive-query-guard`, `uploads-auth`, `auth-path-guard`)
  or names a `global::` middleware without its file in `src/middlewares`.
- `infra/contracts.test.ts` pins what the cms and the web both state: the
  announcement audience rule, the YouTube parser, comment anchors, schema
  enums against the web unions and constants (the live channel pattern from
  `apps/web/src/lib/live-contract.ts`), relation pairs, and the web
  role sets against the permission matrix. The live contract itself (event,
  frame and channel shapes of the SSE pipeline), like the audience rule, the
  YouTube parser and the anchors, now lives once in `@sinnlos/domain`
  (`packages/domain`, see [Shared domain package](#shared-domain-package));
  both apps re-export it. Known gaps are listed in the file
  and asserted as they are, so closing one means removing its entry. A web
  union is checked against its list in the file only by `pnpm typecheck`
  (the `typecheck:tests` step); `pnpm test` checks that list against the
  schema. After changing a union in `apps/web/src/lib/types.ts`, run both.
- `infra/sensitive-queries.test.ts` runs the web's user and search query
  builders through the cms's own `sensitive-query-guard` walk (real schemas,
  Strapi's query parser) for guest, the `authenticated` fallback and a
  role-less caller, and scans `apps/web/src` for any other filter or sort
  on a contact field (or a `_q`): a web query that the guard would refuse
  for guests fails here, not on a guest's page.
- The server actions in `apps/web/src/lib` have tests next to them: the
  event, classified, acknowledgement, kudos, training and notification
  actions (S09), and the auth, comment, poll, profile and locale actions;
  every mutation that answers an `ActionResult` is tested for success, a
  specific refusal, the expired-session redirect and a network error.
  `lib/auth/credentials.ts` (the sign-in's verification with the login
  limiter) and `lib/auth/callbacks.ts` are tested without Auth.js.
  `announcement-live-actions.ts` has none yet. The ⌘K search is no Server Action any more: it runs through
  `GET /search` (`apps/web/src/app/search/route.ts`), covered by
  `apps/web/src/lib/search.test.ts`.
  `/api/live/emit` is covered by `apps/web/src/lib/live-emit.test.ts`; its
  logic lives in `live-emit.ts`.

## 8. Verification checklist

- [ ] `pnpm install` completes cleanly (no "Ignored build scripts" warning)
- [ ] `pnpm build:domain` writes `packages/domain/dist/cjs` and `dist/esm`
- [ ] Strapi admin loads at `:1337/admin`, first admin created
- [ ] The six intranet roles visible under _Settings → Users & Permissions →
      Roles_ (next to the built-in _Authenticated_ and _Public_)
- [ ] Create a department, a team, a wiki space + page via the admin
- [ ] With `SEED_DEMO_DATA=1`, the seeded announcements, events, wiki pages
      and the rest show in the Content Manager's default list as
      _Published_, and editing and publishing one keeps its relations
      (author, department, space, …)
- [ ] Next.js dashboard at `:3000` shows stat cards and empty states
- [ ] Local sign-in (e-mail + password) completes and returns to the
      dashboard with your display name in the topbar
- [ ] Without `ENTRA_ENABLED=1`: no Microsoft button, the cms logs
      `[entra] disabled`, and `POST /api/auth/entra/exchange` answers 404
- [ ] With `ENTRA_ENABLED=1` (a test tenant): the Microsoft sign-in returns
      to the dashboard, the cms logs one `[entra] user=… result=created`
      line, the profile shows name, job title, phone and office as
      read-only, and sign-out goes through Microsoft back to `/sign-in`
- [ ] Editing a wiki page as a non-author member is blocked (403)
- [ ] Through the API, a team lead can change their team's description, and
      a payload with `members` (or any other field outside the write
      allowlist) answers 400 (probe in
      [DEPLOYMENT.md §6.4](./docs/DEPLOYMENT.md#64-role-enforcement-optional));
      a department head can change their own department's description, and
      a department member sees announcements and wiki spaces targeted at
      their department
- [ ] While signed in, `/api/auth/session` returns only `user`
      (name/email/image/id), `provider` and `expires` — no Strapi JWT, role
      or department
- [ ] An admin sees the _Admin_ link and `/manage`; an editor sees
      _New poll_; a guest sees no RSVP controls and no _New ad_ button
- [ ] Poll targeting: a poll restricted to one department is listed for
      its members only; an editor outside it sees _Only for: …_, the
      results and disabled buttons
- [ ] Poll guest access: a guest sees no poll until an admin or editor
      turns on _Visible to guests_ (then results, disabled buttons and
      _Guests can't vote on this poll._); with _Guests can vote_ on as well
      the guest can vote
- [ ] `docker compose up -d` brings the full stack up behind the reverse proxy
      (Caddy locally / Traefik on srv-prod-01)
- [ ] A comment posted in session A appears in session B in under two
      seconds without a reload (SSE) — or run `infra/live-smoke.sh` (it
      also requires the stream to report `"emitFresh":true`, i.e. the cms
      keepalive reaches the web); on `/announcements` the network panel
      shows one `POST /live/subscribe` with the page's full channel set for
      all cards, and a comment on one card refreshes that card only
- [ ] Changing the password on `/profile` in browser A keeps A signed in;
      the same account in browser B lands on `/sign-in?expired=1` with its
      next click
- [ ] `/training` lists published courses; on a `quizGate` course the
      completion button stays locked until every quiz answer is correct;
      `/manage/training` shows the completion report (admin)
- [ ] After a few ⌘K searches, `/manage/analytics` shows the search section
      (totals, zero-result rate, top terms)
- [ ] ⌘K as a guest finds a colleague by name but not by e-mail; while a new
      term loads, the previous term's results are not shown (nor the old
      results of the same term typed again)
- [ ] `/people/<id>` of a manager shows _Direct reports_
- [ ] A user blocked in the Strapi admin loses `/uploads` files within a
      minute (401) and is sent to sign-in on the next page load
- [ ] Digest opt-ins save on `/profile`; without SMTP env the 07:30 cron
      logs `[digest] skipped` (dark mode); a guest sees no digest options
- [ ] Publishing an announcement logs `[notifications] created <n>
notification(s) for announcement …` and rings the bell of its
      audience only (no guest, no blocked user)
- [ ] On Postgres the cms log shows `[datetime] process time zone UTC,
APP_TIME_ZONE …` and no column is left as `timestamp without time zone`
      (`infra/live-smoke.sh` checks both); an all-day event's `.ics` download
      is an all-day entry
- [ ] The web log shows `[datetime] web process time zone UTC, APP_TIME_ZONE …`;
      on `/events` an event that is running today is under _Upcoming_ and a
      multi-day event shows its end day; relative times say "yesterday"
      for something from late last night
- [ ] The `.ics` link on `/events` names the event's documentId, the file's
      `UID` is `event-<documentId>@sinnlos`, and `/events/abc/ics` answers 404
- [ ] `/events` shows each upcoming RSVP event's counts, the names of the
      "yes" answers and your own answer (never who answered maybe or no);
      as a member, `GET /api/event-rsvps` returns only your own answers,
      and a `filters[user]…` query or a `Strapi-Response-Format` header
      answers 400
- [ ] `/manage/acknowledgements` shows a percentage per mandatory
      announcement (not "–") while the directory is complete, also with
      more than 2000 confirmations in total
- [ ] The kudos picker lists neither you nor blocked accounts; `/people`
      renders 48 cards and a _+ N people_ button when more match; the bell
      badge counts every unread notification (99+ above 99), not only the
      20 in the panel
- [ ] A lesson with a YouTube video plays (no player "Error 153"); on a
      real domain, since localhost can hide the Referer effect
- [ ] `/people/abc`, `/marketplace/abc` and `/marketplace/2147483648`
      show the _Page not found_ card (like every `notFound()` page here
      with HTTP status 200 and `noindex`: `loading.tsx` streams the shell
      first) and send no request to the cms; with the cms stopped, `/profile` shows the error banner
      and no editable profile form; stopping the cms after a page loaded, a
      reaction click or _Mark all read_ shows an inline error while the
      page stays
- [ ] The first Tab on an app page shows _Skip to content_; the theme
      toggle switches on the first click also for a user whose system theme
      is dark
