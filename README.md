# Sinnlos Intranet

A self-hosted company intranet, gated by user roles. Local e-mail and
password sign-in works out of the box; **Microsoft Entra ID** single sign-on
is optional and off unless `ENTRA_ENABLED=1`. The UI is English by default,
with German as the second language.

- **Backend:** Strapi 5 (Postgres in production, SQLite for local
  development) in `apps/cms`
- **Frontend:** Next.js 16 + Tailwind CSS + shadcn/ui in `apps/web`
- **Shared rules:** `@sinnlos/domain` in `packages/domain`
- **Deployment:** Docker Compose in `infra/`, fronted by the bundled Caddy or
  by a host Traefik

Further reading:

- **[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)**: every deployment method
  (bare metal, Docker, VPS with Caddy or Traefik, Azure VM, Azure Container
  Apps), upgrades, backup and restore, rollback.
- **[docs/security.md](./docs/security.md)**: the security model: roles,
  the fine print of the permission matrix, route policies, global guards,
  upload hardening and the frontend's role gating.
- **[docs/architecture.md](./docs/architecture.md)** (German): topology,
  data model, request flow, the conventions to know before changing code,
  and the known open issues.

## Contents

- [Overview](#overview)
  - [Features](#features)
  - [Repository layout](#repository-layout)
  - [Content model](#content-model)
  - [Roles and permissions](#roles-and-permissions)
  - [Languages](#languages)
- [Quick start](#quick-start)
  - [Prerequisites](#prerequisites)
  - [Local development (SQLite)](#local-development-sqlite)
  - [Standalone mode (no Microsoft)](#standalone-mode-no-microsoft)
  - [Full stack with Docker Compose](#full-stack-with-docker-compose)
  - [Microsoft Entra ID sign-in (optional)](#microsoft-entra-id-sign-in-optional)
- [Environment reference](#environment-reference)
- [Deployment](#deployment)
- [Scripts](#scripts)
- [Verification checklist](#verification-checklist)

## Overview

### Features

- **Announcements** with targeting (department, team, roles), Markdown,
  optional read confirmation for mandatory news, and live comments and
  reactions: other sessions see a new comment in under two seconds over
  server-sent events, with polling as the fallback.
- **Wiki** spaces that are public or visible to selected roles, a
  department or a team. The cms keeps a snapshot of a page's previous text
  whenever an edit changes it; the web does not show these revisions yet.
- **Departments and teams**, a **people directory** with org chart and
  _Direct reports_, and **celebrations** of work anniversaries and opt-in
  birthdays.
- **Events** with ICS export, RSVP (list and month view) and attendance
  counts.
- **Polls** with department targeting and per-poll guest access, **kudos**,
  a **document library** and **quick links**.
- An **employee marketplace** (classified ads with up to four photos and a
  hardened upload).
- A **training platform**: courses with lessons, YouTube embeds,
  comprehension quizzes with an optional completion gate, and a per-user
  completion report.
- **Notifications** and opt-in **e-mail digests** (daily or weekly).
- **Global search (⌘K)** with anonymous search analytics.

### Repository layout

```
.
├── .github/
│   ├── workflows/ci.yml    CI (build, datetime, integration, infra, images)
│   └── dependabot.yml      weekly grouped version updates
├── apps/
│   ├── cms/                Strapi 5 backend
│   └── web/                Next.js 16 frontend
├── packages/
│   └── domain/             @sinnlos/domain: the pure rules both apps share
├── infra/
│   ├── docker-compose.yml          base stack (db, cms, web, caddy)
│   ├── docker-compose.traefik.yml  production override (host Traefik instead of Caddy; needs DOMAIN)
│   ├── deploy.sh                   production deploy (preflight, backup, build, smoke, SHA tags)
│   ├── live-smoke.sh               end-to-end SSE pipeline probe (run by deploy.sh)
│   ├── backup/pg-backup.sh         encrypted Postgres + uploads + .env backup
│   ├── backup/restore-drill.sh     off-box restore of the newest dump into a throwaway Postgres 16
│   ├── Caddyfile                   the bundled Caddy (standalone boxes, local full-stack runs)
│   ├── readme-permissions.test.ts  pins the permission tables of this README to the cms
│   └── .env.example
├── docs/                   DEPLOYMENT.md, security.md, architecture.md
├── pnpm-workspace.yaml
└── package.json
```

`packages/domain` holds the rules both apps apply (announcement audience,
comment and reaction anchors, entry-id checks, the YouTube parser and quiz
schema, the role vocabulary, the live-event contract, marketplace limits,
the poll close rule, calendar-date helpers). It has no runtime dependencies
and no I/O; both apps import it from its `dist`, so build it after
installing and after every change in `packages/domain/src`
(`pnpm build:domain`; `pnpm dev`, `pnpm typecheck`, `pnpm test:integration`
and `pnpm build` do that themselves). The old module paths in the apps are
thin re-exports, pinned by `domain-reexports.test.ts` in each app.

### Content model

Strapi has 22 collection types plus two routes-only APIs
(`apps/cms/src/api/`). Who may read or write what is in
[Roles and permissions](#roles-and-permissions) below; the per-type access
rules are in
[docs/security.md](./docs/security.md#content-types-and-their-access-rules).

| Type              | Purpose                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `department`      | Org unit with head, members, teams and wiki pages (no draft & publish: one row, a save is live)                 |
| `team`            | Belongs to a department, has a lead and members (no draft & publish)                                            |
| `announcement`    | Dashboard news, targeted by `department`, `team` and `audienceRoles`; optional read confirmation; expiry        |
| `acknowledgement` | Read receipt for a mandatory announcement, one per user, immutable                                              |
| `comment`         | Comments on announcements and wiki pages (the web shows them on announcements)                                  |
| `reaction`        | Emoji reactions on the same targets as comments                                                                 |
| `kudos`           | Peer recognition (from, to, message, company value)                                                             |
| `notification`    | Per-user notification rows, written by the cms only                                                             |
| `event`           | Calendar events with ICS export and optional RSVP                                                               |
| `event-rsvp`      | Attendance answer (`yes`/`no`/`maybe`) per user and event                                                       |
| `poll`            | Question with 2 to 10 options, deadline, anonymous flag, department targeting and guest access                  |
| `poll-vote`       | One vote per user and poll; the content API casts and counts votes through custom routes only                   |
| `document`        | File library entry, company-wide or for selected departments                                                    |
| `classified`      | Marketplace ad: 5 categories, up to 4 photos, listed for 30 days by default (at most 90)                        |
| `quick-link`      | Dashboard link, company-wide or for selected departments; maintained in the Strapi admin                        |
| `course`          | Training course with ordered lessons, `mandatory` flag and completion mode; maintained in the Strapi admin      |
| `lesson`          | One lesson: Markdown body, YouTube video, optional quiz                                                         |
| `lesson-progress` | Completion receipt per user and lesson                                                                          |
| `search-log`      | Anonymous search telemetry (term and result count, no user)                                                     |
| `wiki-space`      | Namespace for wiki pages with its own visibility                                                                |
| `wiki-page`       | Markdown page with tags, order, optional table of contents, parent page                                         |
| `wiki-revision`   | Snapshot of a page's previous text, written when an edit changes it                                             |
| _profile_         | Routes-only: `GET`/`PUT /api/me`, the self-service profile                                                      |
| _entra-auth_      | Routes-only: `POST /api/auth/entra/exchange`, the server-to-server step of the Microsoft sign-in (404 when off) |

**Draft & publish.** `announcement`, `course`, `document`, `event`,
`lesson`, `poll`, `quick-link`, `wiki-space`, `wiki-page` and
`wiki-revision` keep Strapi's draft & publish (pinned per type in
`apps/cms/src/content-type-flags.test.ts`): the admin panel edits a draft
row, readers get the published row. An entry with a published row but no
draft is given its draft at boot (`apps/cms/src/utils/draft-twins.ts`; see
[Upgrading to the draft-twin repair](./docs/DEPLOYMENT.md#upgrading-to-the-draft-twin-repair-fx38)).
Departments and teams have no drafts any more; a database from before that
change needs a one-time migration
([One-time: org draft/publish off](./docs/DEPLOYMENT.md#one-time-org-draftpublish-off)).

### Roles and permissions

Six intranet roles are created at every boot
(`apps/cms/src/bootstrap/roles.ts`): `admin_role`, `editor`,
`department_head`, `team_lead`, `member` and `guest`. `authenticated` is the
users-permissions plugin's built-in role; nobody lands there by default (new
local users get `member`, Entra users an intranet role), so it
only applies to accounts an admin put there. The five roles other than
`guest` are the **staff roles**.

The tables below are the content-API grants the cms bootstrap writes
(`PERMISSION_MATRIX` and `CUSTOM_ACTION_GRANTS` in
`apps/cms/src/bootstrap/permission-matrix.ts`).
`infra/readme-permissions.test.ts` fails when they and the code disagree,
so a grant change updates this README in the same commit. A grant only lets
a request reach the route: route policies, the field-level write allowlist
and the global guards then decide row by row
([docs/security.md](./docs/security.md)).

Content types: `C` = create, `R` = find + findOne, `U` = update,
`D` = delete, `—` = no grant.

<!-- permission-matrix:start -->

| Content type      | `admin_role` | `editor` | `department_head` | `team_lead` | `member` | `guest` | `authenticated` |
| ----------------- | ------------ | -------- | ----------------- | ----------- | -------- | ------- | --------------- |
| `acknowledgement` | CRUD         | CR       | CR                | CR          | CR       | —       | CR              |
| `announcement`    | CRUD         | CRUD     | R                 | R           | R        | —       | R               |
| `classified`      | CRUD         | CRUD     | CRUD              | CRUD        | CRUD     | —       | R               |
| `comment`         | CRD          | CRD      | CRD               | CRD         | CRD      | R       | CR              |
| `course`          | R            | R        | R                 | R           | R        | —       | R               |
| `department`      | CRUD         | R        | RU                | R           | R        | —       | R               |
| `document`        | CRUD         | CRUD     | R                 | R           | R        | R       | R               |
| `event`           | CRUD         | CRUD     | R                 | R           | R        | R       | R               |
| `event-rsvp`      | CRUD         | CRU      | CRU               | CRU         | CRU      | —       | CRU             |
| `kudos`           | CRD          | CRD      | CR                | CR          | CR       | —       | CR              |
| `lesson`          | R            | R        | R                 | R           | R        | —       | R               |
| `lesson-progress` | CR           | CR       | CR                | CR          | CR       | —       | CR              |
| `notification`    | RD           | RD       | RD                | RD          | RD       | R       | R               |
| `poll`            | CRUD         | CRUD     | R                 | R           | R        | R       | R               |
| `poll-vote`       | —            | —        | —                 | —           | —        | —       | —               |
| `quick-link`      | CRUD         | CRUD     | R                 | R           | R        | R       | R               |
| `reaction`        | CRD          | CRD      | CRD               | CRD         | CRD      | R       | CR              |
| `search-log`      | C            | C        | C                 | C           | C        | C       | C               |
| `team`            | CRUD         | R        | RU                | RU          | R        | —       | R               |
| `wiki-space`      | CRUD         | CRUD     | R                 | R           | R        | R       | R               |
| `wiki-page`       | CRUD         | CRUD     | CRU               | CRU         | RU       | R       | R               |
| `wiki-revision`   | CRUD         | CRUD     | R                 | R           | R        | —       | R               |

<!-- permission-matrix:end -->

Custom actions and plugin routes (`✓` = granted, `—` = not granted):

<!-- custom-action-grants:start -->

| Action                                          | Endpoint                                | `admin_role` | `editor` | `department_head` | `team_lead` | `member` | `guest` | `authenticated` |
| ----------------------------------------------- | --------------------------------------- | ------------ | -------- | ----------------- | ----------- | -------- | ------- | --------------- |
| `api::event.event.ics`                          | `GET /api/events/:id/ics`               | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `api::event-rsvp.event-rsvp.summary`            | `GET /api/event-rsvps/summary`          | ✓            | ✓        | ✓                 | ✓           | ✓        | —       | ✓               |
| `api::kudos.kudos.celebrations`                 | `GET /api/celebrations`                 | ✓            | ✓        | ✓                 | ✓           | ✓        | —       | —               |
| `api::notification.notification.markRead`       | `POST /api/notifications/mark-read`     | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `api::notification.notification.markAllRead`    | `POST /api/notifications/mark-all-read` | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `api::poll-vote.poll-vote.vote`                 | `POST /api/polls/:id/vote`              | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `api::poll-vote.poll-vote.results`              | `GET /api/polls/:id/results`            | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `api::poll.poll.batchResults`                   | `GET /api/poll-results`                 | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `api::search-log.search-log.summary`            | `GET /api/search-logs/summary`          | ✓            | —        | —                 | —           | —        | —       | —               |
| `api::profile.profile.me`                       | `GET /api/me`                           | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `api::profile.profile.updateMe`                 | `PUT /api/me`                           | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `plugin::users-permissions.auth.changePassword` | `POST /api/auth/change-password`        | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `plugin::users-permissions.role.find`           | `GET /api/users-permissions/roles`      | ✓            | —        | —                 | —           | —        | —       | —               |
| `plugin::upload.content-api.upload`             | `POST /api/upload`                      | ✓            | ✓        | ✓                 | ✓           | ✓        | —       | —               |
| `api::classified.classified.cleanupUploads`     | `POST /api/classifieds/cleanup-uploads` | ✓            | ✓        | ✓                 | ✓           | ✓        | —       | —               |
| `plugin::users-permissions.user.find`           | `GET /api/users`                        | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `plugin::users-permissions.user.findOne`        | `GET /api/users/:id`                    | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `plugin::users-permissions.user.me`             | `GET /api/users/me`                     | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |

<!-- custom-action-grants:end -->

The anonymous `public` role holds none of these, and the cms revokes the
users-permissions forgot/reset-password endpoints from it. What the grants
mean in practice (immutable read receipts, ownership gates, removed core
routes, the deliberate `guest` exceptions, why every role reads users, the
upload hardening) is in
[docs/security.md](./docs/security.md#permission-matrix-fine-print).

### Languages

The UI ships in English and German (`next-intl`). The language is a
cookie, not a URL segment: a visitor without one gets `DEFAULT_LOCALE`
(`en` when unset or invalid). The language switch sets the cookie and also
stores the choice on the user's profile, so the e-mail digests use it; a
user without a stored language gets digests in `DIGEST_DEFAULT_LOCALE`
(default `en`). The catalogs are `apps/web/messages/en.json` and
`de.json`; every user-visible string goes into both
(`apps/web/src/i18n/messages.test.ts` keeps them in step, and
`pnpm typecheck` rejects a key `en.json` lacks).

## Quick start

### Prerequisites

- Node.js 22.13+ or 24 (`engines`: `^22.13.0 || ^24.0.0`; CI and the
  Docker images use 24; Node 20 is end of life)
- pnpm 10: `corepack enable` gives you the exact version the root
  `packageManager` names (pnpm 9 is refused)
- `openssl` (Git Bash or WSL on Windows) for generating secrets
- Docker with Compose v2, only for the full stack
- A Microsoft Entra ID tenant where you can register an app and grant admin
  consent, only for the optional Microsoft sign-in

### Local development (SQLite)

Runs the cms and the web directly with Node on a SQLite file. No database
server, no Docker, no Microsoft account.

1. Clone and install:

   ```bash
   git clone https://github.com/yurtbayemre/sinnlos.git
   cd sinnlos
   corepack enable
   pnpm install
   pnpm build:domain
   ```

   `corepack enable` writes the `pnpm` shim next to Node.js, so it needs
   write access there (an administrator shell for a Windows install under
   `Program Files`). pnpm 10 runs install scripts only for the dependencies
   listed in the root `pnpm.onlyBuiltDependencies` (better-sqlite3,
   esbuild, sharp). A
   `node_modules` that pnpm 9 created is removed and rebuilt on the first
   pnpm 10 install; answer yes (without a terminal: `CI=true pnpm install`).

2. Create the env files:

   ```bash
   cp apps/cms/.env.example apps/cms/.env
   cp apps/web/.env.example apps/web/.env.local
   ```

   The cms example already selects SQLite (`DATABASE_CLIENT=sqlite`, file
   `apps/cms/.tmp/data.db`). Fill in the secrets:

   - in `apps/cms/.env`, replace each `toBeModified` value (`APP_KEYS` takes
     two values, comma-separated), and in `apps/web/.env.local` the
     `AUTH_SECRET` value, each with its own `openssl rand -base64 32`;
   - set `REVALIDATE_SECRET` and `INTERNAL_UPLOAD_TOKEN`, each to one
     `openssl rand -hex 32` value used in **both** files: the first
     authenticates the live-update pings from the cms to the web, the
     second the web's `/uploads` proxy.

   In development the cms only warns about a placeholder and runs without
   the two shared secrets (no live pings, no `/uploads` gate). With
   `NODE_ENV=production` it refuses to start while a secret holds a
   placeholder, but it does not check that the two shared secrets are set:
   without them it starts, sends no live pings and answers every `/uploads`
   request with 404 (Docker Compose refuses to start without them).

3. Optional, for a first look: in `apps/cms/.env`, set `SEED_DEMO_DATA=1`
   for demo data, and `STRAPI_ADMIN_EMAIL` / `STRAPI_ADMIN_PASSWORD` for the
   first Strapi admin (8+ characters with an upper-case letter, a lower-case
   letter and a digit; without them you register the first admin at
   `/admin`).

4. Start both apps, each in its own terminal:

   ```bash
   pnpm cms:dev    # Strapi on http://localhost:1337
   pnpm web:dev    # Next.js on http://localhost:3000
   ```

   `pnpm dev` starts both in one terminal (output interleaved). The cms is
   ready when it logs `Strapi started successfully` (about half a minute);
   before that it logs `[entra] disabled` while Microsoft sign-in is off,
   and with the demo data `[seed-demo] done — 10 users, …`. Until the web
   is up it also logs `[live-emit] keepalive failed: fetch failed` once,
   and `[live-emit] keepalive reaches the web again` when it is.

5. Open http://localhost:3000. You are sent to `/sign-in`; sign in with
   e-mail and password (with the demo data:
   `alex.morgan@sinnlos.local` / `demo1234`, an `admin_role`; see
   [Standalone mode](#standalone-mode-no-microsoft)). The Strapi admin is
   at http://localhost:1337/admin.

Notes:

- **Strapi admin vs intranet users.** `/admin` accounts (`admin_users`) are
  separate from the intranet's users (Content Manager → User). Strapi's
  community edition has no SSO for `/admin`; Entra ID only signs users into
  the web.
- **Keep the dev cms off the network.** The example sets `HOST=0.0.0.0`,
  and `strapi develop` serves the admin through Vite's dev server, which has
  open advisories. On a shared network set `HOST=127.0.0.1` in
  `apps/cms/.env`
  ([details](./docs/DEPLOYMENT.md#12-create-environment-files)).
- **Postgres locally:** set `DATABASE_CLIENT=postgres`, uncomment the
  Postgres block in `apps/cms/.env` with `DATABASE_HOST=localhost`, and add
  `TZ=UTC` (the cms must run in UTC on Postgres). A one-line Postgres
  container is in
  [DEPLOYMENT.md §1.2](./docs/DEPLOYMENT.md#12-create-environment-files).
- **An older dev database** can still hold department or team drafts; the
  cms then refuses to boot with `[org-dp] … still holds N draft row(s)`.
  Delete `apps/cms/.tmp/data.db` and boot again (with `SEED_DEMO_DATA=1` if
  you want the demo data back). Because that check runs in `register()`,
  Strapi CLI commands such as `strapi ts:generate-types` and
  `strapi content-types:list` need the configured database as well.

### Standalone mode (no Microsoft)

Without `ENTRA_ENABLED=1` (the default) both apps offer local e-mail and
password sign-in against Strapi; leftover `MS_*` or
`AUTH_MICROSOFT_ENTRA_ID_*` values are ignored. This is how the owner's
instance runs.

- **Accounts:** create users in the Strapi admin (**Content Manager →
  User**: e-mail, password, _confirmed_ on), or let people register on the
  sign-in page with `LOCAL_REGISTRATION=1` in **both** `apps/cms/.env` and
  `apps/web/.env.local`. New local users get the `member` role.
- **Passwords:** users change their own on `/profile`, which signs that
  account out of every other browser and device (the tab that changed it
  stays signed in). There is no e-mail reset: the forgot/reset-password
  endpoints are revoked, and an admin sets a new password in the Strapi
  admin, which signs that user out everywhere
  ([Local sign-in](./docs/security.md#local-sign-in)).
- **Demo data:** `SEED_DEMO_DATA=1` in `apps/cms/.env` seeds a database
  that has no department and no user yet (`apps/cms/src/seed-demo.ts`;
  later boots skip it). It writes **12 of the 22 collection types**:
  departments, teams, announcements, events, wiki spaces and pages, kudos,
  polls, poll votes, documents, comments and reactions, plus ten users
  (password `demo1234`): `alex.morgan@sinnlos.local` is `admin_role`;
  Sam Chen, Jordan Lee, Taylor Swift (`taylor.s@sinnlos.local`) and Riley
  Kim are `editor`; the other five are `member`. Publishing the seeded
  announcements and events, and the seeded kudos and comments, also writes
  their notifications. It seeds no acknowledgements, classifieds, quick
  links, RSVPs, courses, lessons, lesson progress, search logs or wiki
  revisions, and no `department_head`, `team_lead` or `guest` user.
- **`DEMO_MODE=1` (web only)** is a different thing: a best-effort UI
  preview without a cms (decision DM01-lite). `DEMO_MODE=1 pnpm web:dev`
  skips sign-in and answers reads from the in-memory fixtures in
  `apps/web/src/lib/demo.ts`, signed in as the fixture user Ada Lovelace (a
  `member` of Engineering). List reads apply their filters, sort and paging
  to the fixtures; writes are not stored, and a path without a fixture logs
  `[demo] no fixture for …` and answers an empty list. It is not a second
  backend, and a production server with `DEMO_MODE=1` answers every page
  with a 500
  ([details](./docs/DEPLOYMENT.md#16-demo-mode-no-microsoft-account-needed)).

To offer local sign-in **next to** Microsoft, set `AUTH_LOCAL_ENABLED=1` for
both apps as well as `ENTRA_ENABLED=1`; the cms mirrors it into its own
e-mail provider switch.

### Full stack with Docker Compose

The same images as production (Postgres, cms, web) behind the bundled Caddy,
on one box:

```bash
cd infra
cp .env.example .env
# set DOMAIN, WEB_PUBLIC_URL and CMS_PUBLIC_URL, fill in every empty secret
docker compose up -d --build
```

`docker compose` refuses to start while a required secret is empty
([Environment reference](#environment-reference)). For a local run set
`DOMAIN=http://localhost` (plain HTTP) and both URLs to `http://localhost`;
`DOMAIN=localhost` serves HTTPS from Caddy's internal CA, and a real host
name gets a Let's Encrypt certificate. Caddy sends `/api/*` (except
`/api/auth/*`), `/admin*`, `/upload*` and the other Strapi admin paths to
the cms and everything else to the web, including `/uploads/*`, which the
web serves through its session-gated proxy. The first build takes a few
minutes; then open the web URL and `/admin`. Step by step:
[DEPLOYMENT.md §2](./docs/DEPLOYMENT.md#2-docker-local-full-stack) (local)
and [§3](./docs/DEPLOYMENT.md#3-vps-deployment) (a server).

### Microsoft Entra ID sign-in (optional)

Microsoft sign-in is one codebase with the local sign-in: off unless
`ENTRA_ENABLED=1` is set for **both** apps, and every `MS_*` / `ENTRA_*`
value is ignored until then. Auth.js runs the OIDC code flow against one
tenant; the cms verifies the ID token itself, finds or creates the user by
tenant id + object id, applies the role of the user's **app role** to the
accounts Entra owns (an account that existed before, or whose role an admin
changed, keeps its role) and issues the intranet session (how it works:
[docs/security.md](./docs/security.md#microsoft-entra-id)). The full
runbook, with a staging dry run before roles are applied, is
[DEPLOYMENT.md, "Microsoft Entra ID sign-in"](./docs/DEPLOYMENT.md#microsoft-entra-id-sign-in).

**1. Set up the provider** in the
[Microsoft Entra admin center](https://entra.microsoft.com):

1. **App registrations → New registration**, _Accounts in this
   organizational directory only_ (single tenant). Note the **Directory
   (tenant) ID** and the **Application (client) ID** (both GUIDs; `common`,
   `organizations` and `consumers` are refused).
2. **Authentication**, platform _Web_, two redirect URIs:
   `<web URL>/api/auth/callback/microsoft-entra-id` (sign-in) and
   `<web URL>/sign-in` (where sign-out returns to), for example
   `http://localhost:3000/...` locally. There is no cms redirect URI:
   Strapi's own Microsoft provider is not used and is forced off at every
   boot. Leave the _Front-channel logout URL_ empty (single sign-out is not
   implemented).
3. **Certificates & secrets → New client secret**; copy the value
   (`MS_CLIENT_SECRET`, used by the web only) and note its expiry.
4. **API permissions → Microsoft Graph → Delegated**: `openid`, `profile`,
   `email`, `User.Read`; `User.Read.All` only with `ENTRA_SYNC_MANAGER=1`.
   **Grant admin consent.** (`GroupMember.Read.All` is not needed.)
5. **App roles** (allowed member types _Users/Groups_): `Intranet.Admin`,
   `Intranet.Editor`, `Intranet.DepartmentHead`, `Intranet.TeamLead`,
   `Intranet.Member`, `Intranet.Guest` (mapped to `admin_role`, `editor`,
   `department_head`, `team_lead`, `member`, `guest`). Then **Enterprise
   applications** → the app → _Assignment required_ = **Yes**, and assign
   the roles to users or security groups (Entra ID P1; nested groups are not
   expanded). Never assign public Microsoft 365 groups or Teams to a
   privileged role.

**2. Configure the apps.** With Docker Compose, in `infra/.env` (compose
hands each app the keys it reads):

```dotenv
ENTRA_ENABLED=1
MS_TENANT_ID=<directory-tenant-guid>
MS_CLIENT_ID=<application-client-guid>
MS_CLIENT_SECRET=<client-secret-value>
ENTRA_EXCHANGE_SECRET=<openssl rand -hex 32>
ENTRA_SYNC_MODE=dry-run
```

For local development the cms reads `ENTRA_ENABLED`, `MS_TENANT_ID`,
`MS_CLIENT_ID` and `ENTRA_EXCHANGE_SECRET` from `apps/cms/.env`; the web
reads `ENTRA_ENABLED`, `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID`,
`AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET` and the same
`ENTRA_EXCHANGE_SECRET` from `apps/web/.env.local` (both examples carry the
block, commented out). With `ENTRA_ENABLED=1` an invalid value stops the
cms at boot and makes the web answer every request with an error, both
naming the variable; `infra/deploy.sh --check` refuses the deploy first.
The remaining knobs are in the
[environment reference](#microsoft-entra-id).

**3. Check it.** The cms logs `[entra] enabled tenant=… mode=dry-run` at
boot, and the sign-in page shows _Sign in with Microsoft_ (local sign-in is
off next to it unless `AUTH_LOCAL_ENABLED=1`). Each sign-in writes one
`[entra] user=… result=…` line. `ENTRA_SYNC_MODE=dry-run` changes no
existing user (it logs the changes `on` would make) and creates new users at
most as `member`; refusals (no assignment, `deny`) apply in both modes.
Switch to `on` once the log looks right
([Staging dry-run, then on](./docs/DEPLOYMENT.md#staging-dry-run-then-on)).
Sign-in errors and the procedure for an e-mail address that already has an
account are in the runbook.

## Environment reference

Each app reads its own file in development (`apps/cms/.env`,
`apps/web/.env.local`); Docker Compose reads `infra/.env` and passes each
service the keys it needs, under the names below. "Default" is what the
code uses when the variable is unset; the `.env.example` files and compose
set some differently, as noted. `apps/cms/.env.example` lists every setting
`apps/cms/config` reads (`infra/env-examples.test.ts` keeps it complete).
More context on each: [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).

**Required values and placeholders.** Two different checks:

- **Docker Compose** refuses to start while one of `DATABASE_PASSWORD`,
  `APP_KEYS`, `API_TOKEN_SALT`, `ADMIN_JWT_SECRET`, `TRANSFER_TOKEN_SALT`,
  `JWT_SECRET`, `ENCRYPTION_KEY`, `AUTH_SECRET`, `REVALIDATE_SECRET` or
  `INTERNAL_UPLOAD_TOKEN` is empty (`${VAR:?}` in the compose file).
- **The cms** (`apps/cms/src/utils/env-guard.ts`) checks values, not
  presence: with `NODE_ENV=production` it refuses to start while a Strapi
  secret, `REVALIDATE_SECRET` or `INTERNAL_UPLOAD_TOKEN` holds a template
  placeholder (a `<…>` stand-in, or a value containing `change-me`,
  `changeme`, `toBeModified`, `generate-with-openssl` or `placeholder`);
  outside production it only warns. An **empty** `REVALIDATE_SECRET` or
  `INTERNAL_UPLOAD_TOKEN` passes: a cms started that way outside Compose
  boots, sends no live-event pings, and in production answers every
  `/uploads` request with 404.

`infra/deploy.sh --check` renders the compose file (so it fails on an empty
required value) and runs the placeholder check, plus `AUTH_SECRET`, before
anything is deployed.

### Shared by cms and web

| Variable                | Default         | Meaning                                                                                                                                                                                                                                                                                                            |
| ----------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `REVALIDATE_SECRET`     | (unset)         | Authenticates the cms's live-event pings to the web (`POST /api/live/emit`); the name is historical. Same value on both. Unset: no pings, the web polls.                                                                                                                                                           |
| `INTERNAL_UPLOAD_TOKEN` | (unset)         | The web's session-gated `/uploads` proxy presents it to the cms. Same value on both. Unset in production: every uploaded file answers 404; in development the gate is off.                                                                                                                                         |
| `LIVE_EVENTS_DISABLED`  | `0`             | `1` is the kill switch for live updates (SSE): the cms sends no pings, the web polls. Same value on both.                                                                                                                                                                                                          |
| `APP_TIME_ZONE`         | `Europe/Berlin` | IANA zone of every business date: "today", ad expiry, birthdays, digest days, the cron times, all-day events, poll deadlines. A UTC offset (`+02:00`) or unknown name stops the cms and makes the web answer every request with an error. See the [datetime contract](./docs/DEPLOYMENT.md#310-datetime-contract). |
| `LOCAL_REGISTRATION`    | off             | `1` in both apps shows a self-registration form on the sign-in page (only while local sign-in is on). New users get `member`.                                                                                                                                                                                      |
| `AUTH_LOCAL_ENABLED`    | off             | `1` keeps local sign-in next to Microsoft (break-glass). Without `ENTRA_ENABLED=1` local sign-in is always on.                                                                                                                                                                                                     |

### cms (`apps/cms/.env`)

| Variable                                                                                                       | Default                                                     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_KEYS`, `API_TOKEN_SALT`, `ADMIN_JWT_SECRET`, `TRANSFER_TOKEN_SALT`, `ENCRYPTION_KEY`                      | (none)                                                      | Strapi secrets, `openssl rand -base64 32` each (`APP_KEYS`: two, comma-separated).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `JWT_SECRET`                                                                                                   | (none)                                                      | Signs the users' Strapi JWTs (7 days for local sign-ins, `ENTRA_SESSION_TTL` for Microsoft). Rotating it signs everyone out once. An instance upgraded from a release before 2026-09-24 must rotate it once ([runbook](./docs/DEPLOYMENT.md#upgrading-from-a-release-before-2026-09-24)); `infra/deploy.sh` enforces it. A rollback of the cms to a release before batch 13 must rotate it as well, so that no JWT a password change revoked works again ([batch 13 rollback](./docs/DEPLOYMENT.md#deploying-batch-13-2026-10-12)); the rollback commands `infra/deploy.sh` prints say so. So must every restore of a database dump or of `infra/.env`, before the cms starts ([restore](./docs/DEPLOYMENT.md#restoring-a-database-dump)). |
| `HOST`, `PORT`                                                                                                 | `0.0.0.0`, `1337`                                           | Listen address and port. `HOST=127.0.0.1` keeps a dev cms off the network.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PUBLIC_URL`                                                                                                   | `http://localhost:1337`                                     | Public URL of the cms (admin panel, upload URLs, CSP). Compose: `CMS_PUBLIC_URL`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `CORS_ORIGIN`                                                                                                  | `http://localhost:3000`                                     | Browser origins that may call the cms API, comma-separated. Compose: `WEB_PUBLIC_URL`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `WEB_INTERNAL_URL`                                                                                             | (unset; example `http://localhost:3000`)                    | Where the cms sends live-event pings. Unset: no pings. Compose: `http://sinnlos-web:3000`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DATABASE_CLIENT`                                                                                              | `postgres` (example: `sqlite`)                              | `sqlite` or `postgres`. Compose always uses `postgres`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `DATABASE_FILENAME`                                                                                            | `.tmp/data.db`                                              | SQLite file, relative to `apps/cms` or absolute. Releases before batch 8 placed an absolute value under `apps/cms`; move such a file before upgrading ([note](./docs/DEPLOYMENT.md#upgrading-to-the-cms-bootstrap-split-batch-8-lane-3b)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USERNAME`, `DATABASE_PASSWORD`, `DATABASE_SCHEMA` | `localhost`, `5432`, `sinnlos`, `sinnlos`, (none), `public` | Postgres connection. Compose sets host `sinnlos-db` and port 5432, and passes `DATABASE_NAME`, `DATABASE_USERNAME` and `DATABASE_PASSWORD` from `infra/.env`, where they also create the database.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DATABASE_URL`                                                                                                 | (unset)                                                     | One Postgres connection URL; its values win over the keys above. An `options` parameter is refused unless it sets `-c TimeZone=UTC` itself (the cms pins every session to UTC).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `DATABASE_POOL_MIN`, `DATABASE_POOL_MAX`, `DATABASE_CONNECTION_TIMEOUT`                                        | `2`, `10`, `60000`                                          | Connection pool bounds, and how long (ms) a query waits for a free connection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `DATABASE_SSL`, `DATABASE_SSL_KEY`, `DATABASE_SSL_CERT`, `DATABASE_SSL_CA`, `DATABASE_SSL_REJECT_UNAUTHORIZED` | `false`, …, `true`                                          | TLS to Postgres (on only with the exact value `true`); key, certificate and CA take the PEM text. `DATABASE_SSL_CAPATH` and `DATABASE_SSL_CIPHER` are read too but ignored by the Postgres driver.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DATABASE_FORCE_MIGRATION`                                                                                     | `false`                                                     | Destructive: `true` lets the next boot drop columns, tables and indexes that removed attributes left behind. Only for a deliberate cleanup after a backup; compose does not pass it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `TZ`                                                                                                           | (unset)                                                     | On a local Postgres, set `TZ=UTC` (the cms must run in UTC). Never set it for the containers: compose and the images do.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DATETIME_LEGACY_ZONE`, `DATETIME_LEGACY_UTC_UNTIL`                                                            | (empty)                                                     | Only for a database written by a cms before the datetime contract: its first boot repairs the stored times once ([runbook](./docs/DEPLOYMENT.md#upgrading-an-existing-instance-to-this-release)). Empty on a fresh install.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `STRAPI_ADMIN_EMAIL`, `STRAPI_ADMIN_PASSWORD`                                                                  | (empty)                                                     | First Strapi super admin, created when `admin_users` is empty. Template placeholders and passwords failing the admin policy (8+ characters, upper case, lower case, digit) are refused with an error log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `STRAPI_ADMIN_FIRSTNAME`, `STRAPI_ADMIN_LASTNAME`                                                              | `Admin`, `User`                                             | Name of that admin. Compose does not pass them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SEED_DEMO_DATA`                                                                                               | off                                                         | `1` seeds demo data into a database without departments and users ([what it writes](#standalone-mode-no-microsoft)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `CRON_ENABLED`                                                                                                 | on                                                          | The five cms crons (03:30 uploads janitor, 03:35 search-log janitor, 03:40 notification janitor, 03:45 classified janitor, 07:30 digest mailer, in `APP_TIME_ZONE`). Unset, empty or a true value (`1`/`true`/`yes`/`on`) runs them; anything else, such as `false` or `0`, switches them off in that process.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `STRAPI_TELEMETRY_DISABLED`                                                                                    | (unset; example and compose: `true`)                        | `true` (or `1`) sends no usage telemetry to Strapi.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `FLAG_NPS`, `FLAG_PROMOTE_EE`                                                                                  | `false`                                                     | Strapi admin panel survey and Enterprise Edition promotion. Compose does not pass them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### E-mail digests (cms)

The digest cron is a logged no-op until `SMTP_HOST`, `SMTP_USER` and
`SMTP_PASS` are set.

| Variable                                           | Default                            | Meaning                                                                                                                                   |
| -------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | (empty), `587`                     | Authenticated SMTP submission; use a mailbox app password. Port 465 uses implicit TLS, any other port must offer STARTTLS.                |
| `DIGEST_FROM`                                      | (empty)                            | Sender. Required once SMTP is set: without it every run is skipped and `infra/deploy.sh` refuses to deploy (unless `DIGESTS_DISABLED=1`). |
| `DIGEST_REPLY_TO`                                  | (empty)                            | Optional reply-to address.                                                                                                                |
| `PUBLIC_WEB_URL`                                   | (empty; compose: `WEB_PUBLIC_URL`) | Base of the links in the digests; required once SMTP is set.                                                                              |
| `DIGESTS_DISABLED`                                 | `0`                                | `1` (also `true`, `yes`, `on`) switches the digests off.                                                                                  |
| `DIGEST_DEFAULT_LOCALE`                            | `en`                               | Digest language (`en` or `de`) of a user whose profile has none.                                                                          |

### web (`apps/web/.env.local`)

| Variable            | Default                            | Meaning                                                                                                                                 |
| ------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `STRAPI_URL`        | `http://localhost:1337`            | The cms as the web server reaches it. Compose: `http://sinnlos-cms:1337`.                                                               |
| `STRAPI_PUBLIC_URL` | `STRAPI_URL`                       | Public cms URL, the base of media URLs. Compose: `CMS_PUBLIC_URL`.                                                                      |
| `AUTH_SECRET`       | (none)                             | Auth.js session secret, `openssl rand -base64 32`.                                                                                      |
| `AUTH_URL`          | (example: `http://localhost:3000`) | Public URL of the web; its scheme also names the session cookie (`https` → `__Secure-authjs.session-token`). Compose: `WEB_PUBLIC_URL`. |
| `AUTH_TRUST_HOST`   | (example and compose: `true`)      | Auth.js trusts the request host (behind the reverse proxy).                                                                             |
| `DEFAULT_LOCALE`    | `en`                               | UI language (`en` or `de`) for a visitor who has not picked one.                                                                        |
| `DEMO_MODE`         | off                                | `1`: fixture preview without sign-in or cms ([what it is](#standalone-mode-no-microsoft)). Never in production.                         |

### Microsoft Entra ID

Read only with `ENTRA_ENABLED=1`; then an invalid value stops the cms at
boot and fails every web request.
In `infra/.env` the `MS_*` names feed both apps; locally the web uses the
`AUTH_MICROSOFT_ENTRA_ID_*` names.

| `infra/.env` / cms      | web                                 | Default   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENTRA_ENABLED`         | `ENTRA_ENABLED`                     | `0`       | The only switch. Anything but `1` turns Microsoft sign-in off in both apps.                                                                                                                                                                                                                                                                                                                                                         |
| `MS_TENANT_ID`          | `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID` | (none)    | Directory (tenant) GUID.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MS_CLIENT_ID`          | `AUTH_MICROSOFT_ENTRA_ID_ID`        | (none)    | Application (client) GUID; the cms checks the ID token's audience against it.                                                                                                                                                                                                                                                                                                                                                       |
| `MS_CLIENT_SECRET`      | `AUTH_MICROSOFT_ENTRA_ID_SECRET`    | (none)    | Client secret, web only.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ENTRA_EXCHANGE_SECRET` | `ENTRA_EXCHANGE_SECRET`             | (none)    | 32+ characters, the same for both apps (`openssl rand -hex 32`); authenticates the web's call to `POST /api/auth/entra/exchange`.                                                                                                                                                                                                                                                                                                   |
| `ENTRA_SYNC_MODE`       | —                                   | `dry-run` | `on` applies Entra's roles (to the accounts Entra owns), the profile, department and manager; `dry-run` changes no existing user (it logs what `on` would do) and creates new users at most as `member`. Refusals apply in both modes.                                                                                                                                                                                              |
| `ENTRA_DEFAULT_ROLE`    | —                                   | `member`  | Role of a new or Entra-owned tenant member with no recognised app role or group: `member`, `guest` or `deny`; such a B2B guest is refused. Neither applies to a **manual** account (one that existed before, was bound by an admin, or whose role an admin changed): it keeps its role and signs in, so block it in the Strapi admin to keep it out. With _Assignment required_ = Yes, Entra itself refuses unassigned users first. |
| `ENTRA_GROUP_ROLES`     | —                                   | (empty)   | `<roleType>:<groupObjectId>,…`, at most 20 groups, for nested groups or tenants without Entra ID P1.                                                                                                                                                                                                                                                                                                                                |
| `ENTRA_SYNC_DEPARTMENT` | —                                   | `0`       | `1` sets the user's department to the one department whose name equals Entra's `department` (case-insensitive); an empty value, no match or several matches clear it.                                                                                                                                                                                                                                                               |
| `ENTRA_SYNC_MANAGER`    | `ENTRA_SYNC_MANAGER`                | `0`       | `1` syncs the manager from Graph (`User.Read.All` with admin consent).                                                                                                                                                                                                                                                                                                                                                              |
| `ENTRA_SESSION_TTL`     | —                                   | `12h`     | Lifetime of a Microsoft sign-in's session, `<n>m`, `<n>h` or `<n>d`, at most `7d`.                                                                                                                                                                                                                                                                                                                                                  |

### Docker Compose only (`infra/.env`)

| Variable                                                  | Meaning                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOMAIN`                                                  | The bare public host name. The bundled Caddy uses it as its site address (unset: `localhost` with Caddy's internal CA; `http://localhost`: plain HTTP); the Traefik overlay requires it for every router's host rule, and `infra/deploy.sh` refuses a value that is not a bare host name, is a placeholder, or is not the host of both public URLs. |
| `WEB_PUBLIC_URL`, `CMS_PUBLIC_URL`                        | Public URLs of the web and the cms (`AUTH_URL`, `CORS_ORIGIN`, `PUBLIC_URL`, `STRAPI_PUBLIC_URL`, and the default of `PUBLIC_WEB_URL`).                                                                                                                                                                                                             |
| `DATABASE_NAME`, `DATABASE_USERNAME`, `DATABASE_PASSWORD` | The Postgres database, user and password (defaults `sinnlos`, `sinnlos`, required). The password is fixed on the first `up`; a later change also needs `ALTER ROLE`.                                                                                                                                                                                |

Compose sets the rest itself: `NODE_ENV=production`, `TZ=UTC`, the
internal URLs over the `sinnlos-db`, `sinnlos-cms` and `sinnlos-web`
aliases, `DATABASE_CLIENT=postgres` and `AUTH_TRUST_HOST=true`. It does not
pass `DATABASE_FORCE_MIGRATION`, `DATABASE_URL`, the pool and TLS settings,
`STRAPI_ADMIN_FIRSTNAME`/`LASTNAME`, the `FLAG_*` switches or `DEMO_MODE`.
The infra scripts take their own variables (`SMOKE_URL`, `COMPOSE_PROJECT`,
`SINNLOS_BACKUP_DIR`, …), listed in each script's header.

## Deployment

All deployment paths, upgrades and operations are in
**[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)**:

- **One box with the bundled Caddy** (any VPS or an Azure VM):
  [§3.6 A](./docs/DEPLOYMENT.md#a-bundled-caddy-standalone-vps), and
  [§4](./docs/DEPLOYMENT.md#4-azure-vm-deployment) for Azure.
- **Behind a host Traefik**, as the live production host runs it:
  `docker-compose.traefik.yml` on top of the base file
  ([§3.6 B](./docs/DEPLOYMENT.md#b-shared-traefik-live-production-layout)).
  The router names are fixed (`sinnlos-*`), so it is one Sinnlos stack per
  Traefik; a staging copy needs its own host or Traefik.
- **Azure Container Apps**:
  [§5](./docs/DEPLOYMENT.md#5-azure-container-apps-advanced).
- **Upgrading** an existing instance: the notes in
  [§3.8 Updates](./docs/DEPLOYMENT.md#38-updates), newest first, and the
  [production-safe update procedure](./docs/DEPLOYMENT.md#74-update-procedure-production-safe).
- **Backups and restore:**
  [Backup & Restore](./docs/DEPLOYMENT.md#backup--restore).
- **After a deploy:**
  [post-deployment verification](./docs/DEPLOYMENT.md#post-deployment-verification).

Production deploys run **`infra/deploy.sh`** in the checkout, as the user
that owns the checkout (from a root shell: `sudo -u <owner> -H
infra/deploy.sh`). It checks `infra/.env` against the env contract
(`--check` runs only that), takes a lock, requires a clean checkout and
reports the commit's CI result (the runs of this repository's CI;
Dependabot's own update jobs on the commit are left out;
`--require-green-ci` refuses a red one), takes a pre-deploy backup, builds
and restarts, smoke-checks the site, runs `infra/live-smoke.sh`, and only
then tags the images with the commit and records them as the last known
good; a failure prints the rollback commands, including the mandatory
`JWT_SECRET` rotation when the target cms image predates batch 13. `--dry-run` prints the plan and changes nothing. The cms trusts
the `X-Forwarded-For` the edge sets, so the edge must overwrite that header
from clients ([§3.9 Production hardening](./docs/DEPLOYMENT.md#39-production-hardening)).

## Scripts

From the repository root:

```bash
pnpm dev               # build packages/domain, then every workspace's dev server in parallel
pnpm cms:dev           # just Strapi (strapi develop)
pnpm web:dev           # just Next.js (next dev -p 3000)
pnpm build             # build every workspace, packages/domain first (the cms build deletes apps/cms/dist first)
pnpm build:domain      # build packages/domain into dist/cjs + dist/esm
pnpm start             # every workspace's start script in parallel (strapi start, next start -p 3000)
pnpm lint              # ESLint in every workspace
pnpm typecheck         # build:domain, tsc for the package and both apps, then typecheck:tests
pnpm typecheck:tests   # type-check every *.test.ts (tsconfig.test.json, tsconfig.test.cms.json)
pnpm test              # vitest unit tests (apps, packages, infra)
pnpm test:tz           # the same suite under TZ=UTC, Europe/Berlin and Pacific/Auckland
pnpm test:integration  # build:domain, then the real cms booted in process, per role, over HTTP
pnpm format            # prettier --write over the tree
pnpm format:check      # prettier --check (blocking in CI)
```

And in `infra/`:

```bash
infra/deploy.sh --check      # validate infra/.env against the env contract, deploy nothing
infra/deploy.sh --dry-run    # every deploy check, then the plan; changes nothing
infra/deploy.sh              # the production deploy (see Deployment)
infra/live-smoke.sh          # datetime check, then the SSE live pipeline end to end
infra/backup/restore-drill.sh --all <dir>  # off-box: restore the newest dump into a throwaway Postgres 16
```

**CI** (`.github/workflows/ci.yml`) runs on every pull request and on
pushes to `main` (other branches through "Run workflow"): `build`
(typecheck, lint, `format:check`, test, build, `pnpm audit --prod` blocking
at `critical`, advisory at `high`), `datetime` (`pnpm test:tz` with Postgres
16), `integration` (`pnpm test:integration` on SQLite and Postgres 16),
`infra` (shellcheck, `docker compose config` of every compose variant) and
`images` (both Dockerfiles built, not pushed). Actions are pinned by commit
SHA and the base image by digest (`infra/build-pins.test.ts`); Dependabot
opens weekly grouped updates. `docs/DEPLOYMENT.md` and
`docs/architecture.md` are hand-formatted and excluded from prettier.

**Tests.** Unit tests live next to their code as `*.test.ts` and run with
vitest from the root (`vitest.config.ts`, which resolves `@sinnlos/domain`
to its source). The Postgres suites (`*.pg.test.ts`) run only when
`SINNLOS_TEST_PG_URL` points at a Postgres 16 they may create schemas in,
for example a throwaway
`docker run --rm -d -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=test postgres:16-alpine`
with `SINNLOS_TEST_PG_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
`pnpm test:integration` boots the cms per suite
(`apps/cms/src/integration/`, harness in `harness.test.helper.ts`), signs
in one account per role and drives the API over HTTP; it needs no network
and reads no `.env`. The suites that pin security-relevant behaviour are
listed in [docs/security.md](./docs/security.md#tests-that-pin-these-rules).
Before a `@strapi/*` upgrade run
`pnpm vitest run apps/cms/src/framework-contract.test.ts`; after a
deliberate grant change rewrite the permission snapshots with
`pnpm vitest run apps/cms/src/bootstrap.permissions.test.ts apps/cms/src/prod-perm-diff.test.ts -u`
and update the tables in [Roles and permissions](#roles-and-permissions).

## Verification checklist

Setup:

- [ ] `pnpm install` completes without an "Ignored build scripts" warning,
      and `pnpm build:domain` writes `packages/domain/dist/cjs` and
      `dist/esm`
- [ ] Strapi admin loads at `:1337/admin`; the first admin exists
- [ ] Six intranet roles under _Settings → Users & Permissions → Roles_, next
      to the built-in _Authenticated_ and _Public_ (eight in total)
- [ ] With `SEED_DEMO_DATA=1` on a fresh database, the seeded
      announcements, events, wiki pages, polls and documents show in the
      Content Manager's default list as _Published_, and editing and
      publishing one keeps its relations (author, department, space, …)
- [ ] The dashboard at `:3000` shows stat cards and empty states
- [ ] Local sign-in returns to the dashboard with your display name in the
      topbar; `/api/auth/session` returns only `user`
      (name/email/image/id), `provider` and `expires`, no Strapi JWT, role
      or department
- [ ] Without `ENTRA_ENABLED=1`: no Microsoft button, the cms logs
      `[entra] disabled`, and `POST /api/auth/entra/exchange` answers 404
- [ ] With `ENTRA_ENABLED=1` (a test tenant): the Microsoft sign-in returns
      to the dashboard, the cms logs one `[entra] user=… result=created`
      line, the profile shows name, job title, phone and office as
      read-only, and sign-out goes through Microsoft back to `/sign-in`
- [ ] `docker compose up -d` brings the full stack up behind the reverse
      proxy (Caddy locally, Traefik on the production host)

Roles and access:

- [ ] Editing a wiki page as a `member` who is not its author answers 403
      (only the author, the head of the page's department, the lead of its
      team, `admin_role` and `editor` may edit it)
- [ ] Through the API, a team lead can change their team's description,
      and a payload with `members` (or any other field outside the write
      allowlist) answers 400 (probe in
      [DEPLOYMENT.md §6.4](./docs/DEPLOYMENT.md#64-role-enforcement-optional));
      a department head can change their own department's description; a
      department member sees the announcements and wiki spaces targeted at
      their department
- [ ] An admin sees the _Admin_ link and `/manage`; an editor sees
      _New poll_; a guest sees no RSVP controls and no _New ad_ button
- [ ] A guest's navigation has no Announcements, Departments, Teams, Kudos,
      Marketplace or Training; opening one of them by URL shows _Not
      available for your account_, and neither the web nor the cms logs a
      403 for it
- [ ] An editor sees _Moderation_ / _Delete ad_ on someone else's ad and no
      _Edit_ link; `/marketplace/<id>/edit` sends them back to the ad
- [ ] Poll targeting: a poll restricted to one department is listed for
      its members only; an editor outside it sees _Only for: …_, the
      results and disabled buttons
- [ ] Poll guest access: a guest sees no poll until an admin or editor
      turns on _Visible to guests_ (then results, disabled buttons and
      _Guests can't vote on this poll._); with _Guests can vote_ on as well
      the guest can vote
- [ ] ⌘K as a guest finds a colleague by name but not by e-mail; while a new
      term loads, the previous term's results are not shown (nor the old
      results of the same term typed again)
- [ ] A user blocked in the Strapi admin loses `/uploads` files within a
      minute (401) and is sent to sign-in on the next page load
- [ ] Changing the password on `/profile` in browser A keeps A signed in;
      the same account in browser B lands on `/sign-in?expired=1` with its
      next click; a new password set for that account in the Strapi admin
      (_Content Manager → User_, which shows no token version field) sends
      A there too
- [ ] `/events` shows each upcoming RSVP event's counts, the names of the
      "yes" answers and your own answer (never who answered maybe or no);
      as a member, `GET /api/event-rsvps` returns only your own answers,
      and a `filters[user]…` query or a `Strapi-Response-Format` header
      answers 400

Live updates, notifications and dates:

- [ ] A comment posted in session A appears in session B in under two
      seconds without a reload (SSE), or run `infra/live-smoke.sh` (it
      also requires the stream to report `"emitFresh":true`, i.e. the cms
      keepalive reaches the web); on `/announcements` the network panel
      shows one `POST /live/subscribe` with the page's full channel set for
      all cards, and a comment on one card refreshes that card only
- [ ] With the cms stopped, the header shows _Live updates delayed_
      within about 75 s, and the note goes away once the cms is back
- [ ] Publishing an announcement logs `[notifications] created <n>
notification(s) for announcement …` and rings the bell of its
      audience only (no guest, no blocked user)
- [ ] Digest opt-ins save on `/profile`; without SMTP env the 07:30 cron
      logs `[digest] skipped` (dark mode); a guest sees no digest options
- [ ] On Postgres the cms log shows `[datetime] process time zone UTC,
APP_TIME_ZONE …` and no column is left as `timestamp without time zone`
      (`infra/live-smoke.sh` checks both); an all-day event's `.ics`
      download is an all-day entry
- [ ] The web log shows `[datetime] web process time zone UTC, APP_TIME_ZONE …`;
      on `/events` an event that is running today is under _Upcoming_ and a
      multi-day event shows its end day; relative times say "yesterday"
      for something from late last night
- [ ] The `.ics` link on `/events` names the event's documentId, the file's
      `UID` is `event-<documentId>@sinnlos`, and `/events/abc/ics` answers 404

Pages and UI:

- [ ] `/training` lists published courses; on a `quizGate` course the
      completion button stays locked until every quiz answer is correct;
      `/manage/training` shows the completion report (admin)
- [ ] After a few ⌘K searches, `/manage/analytics` shows the search section
      (totals, zero-result rate, top terms)
- [ ] `/people/<id>` of a manager shows _Direct reports_
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
      first) and send no request to the cms; with the cms stopped,
      `/profile` shows the error banner and no editable profile form;
      stopping the cms after a page loaded, a reaction click or _Mark all
      read_ shows an inline error while the page stays
- [ ] With the cms stopped after a page loaded, the bell keeps its badge
      and list and the open panel says the intranet cannot be reached; a
      page loaded during the stop shows only that note
- [ ] At 360 px every section is reachable: five tabs plus _More_, whose
      sheet opens with Enter, keeps Tab inside, closes with Escape and lists
      _Admin_ for admins only
- [ ] With network throttling, a clicked nav link shows its pending dot
      until the route's skeleton (with the progress bar) appears
- [ ] The first Tab on an app page shows _Skip to content_; the theme
      toggle switches on the first click also for a user whose system theme
      is dark
- [ ] The language menu, the marketplace category and duration selects,
      the _/people_ department filter and the notification bell open with
      Enter, move with the arrow keys, jump by typing a letter, close with
      Escape and give focus back to their button; picking _Deutsch_
      with the keyboard (Enter, ArrowUp, Enter) leaves the focus on the
      language button once the page is German; ⌘K logs no "DialogTitle"
      error in the browser console
- [ ] _Delete ad_ and _Give kudos_ keep Tab inside the dialog, close with
      Escape or a click beside it and give focus back to their button;
      confirming a delete lands on `/marketplace` without a _Page not found_
      flash
- [ ] An announcement renders its Markdown (bold, lists, links, images);
      `<script>` or an `onerror` attribute in a body shows as text, a
      `javascript:` link as plain text; the dashboard's _Latest news_
      excerpts show no `**`, `#` or link targets; footnotes in two
      announcements each jump to their own card's notes
- [ ] With `DEMO_MODE=1 pnpm web:dev` (no cms running), the dashboard
      renders the fixtures signed in as Ada Lovelace, and the other pages
      answer from the fixtures without a `[demo] no fixture` warning
