# Sinnlos Intranet

A self-hosted company intranet, gated by user roles. Local e-mail and
password sign-in works out of the box; **Microsoft Entra ID** single sign-on
is optional and off unless `ENTRA_ENABLED=1`, and so is sign-in through
**Keycloak, authentik or Zitadel** (OIDC, `OIDC_ENABLED=1`; one of the two
at a time). The UI is English by default,
with German as the second language.

- **Backend:** Strapi 5 (Postgres in production, SQLite for local
  development) in `apps/cms`
- **Frontend:** Next.js 16 + Tailwind CSS + shadcn/ui in `apps/web`
- **Shared rules:** `@sinnlos/domain` in `packages/domain`
- **Deployment:** Docker Compose in `infra/`, fronted by the bundled Caddy or
  by a host Traefik

Further reading:

**Running an instance**

- **[docs/INSTALL.md](./docs/INSTALL.md):** a new installation on one host, step by step: configuration and branding, backups, the first admin, the admin panel through an SSH tunnel, and running behind your own Traefik.
- **[docs/UPGRADE.md](./docs/UPGRADE.md):** the supported upgrade path from v0.25.x, the release notes, and rollback.
- **[docs/OPERATIONS.md](./docs/OPERATIONS.md):** monitoring, restore behind closed doors, backups, hardening, the datetime contract, Meilisearch and troubleshooting.
- **[docs/SSO.md](./docs/SSO.md):** sign-in with Microsoft Entra ID, Keycloak, authentik or Zitadel, AD/LDAP through the identity provider, and the second factor for SSO users.

**How it works**

- **[docs/security.md](./docs/security.md):** the security model: roles, the fine print of the permission matrix, route policies, global guards, upload hardening and the frontend's role gating.
- **[docs/architecture.md](./docs/architecture.md)** (German): topology, data model, request flow, the conventions to know before changing code (in [docs/architecture/](./docs/architecture/)), and the known open issues.
- **[docs/data-protection.md](./docs/data-protection.md)** (German): the data inventory for the data-protection officer and the works council. It covers every data class, who sees it and when it is deleted, the switches, export and anonymisation, and what restoring a backup means for them.

**Project**

- **[CONTRIBUTING.md](./CONTRIBUTING.md):** local development and the checks before a pull request.
- **[docs/v1-release-plan.md](./docs/v1-release-plan.md):** everything that still has to be done before v1.0.0, with the owner's decisions.

## Contents

- [Overview](#overview)
  - [Features](#features)
  - [Repository layout](#repository-layout)
  - [Content model](#content-model)
  - [Roles and permissions](#roles-and-permissions)
  - [Languages](#languages)
- [Quick start](#quick-start)
- [Environment reference](#environment-reference)
- [Deployment](#deployment)
- [Accessibility](#accessibility)
- [Scripts](#scripts)

## Overview

### Features

- **Announcements** with targeting (department, team, roles), Markdown,
  optional read confirmation for mandatory news, and live comments and
  reactions: other sessions see a new comment in under two seconds over
  server-sent events, with polling as the fallback.
- **Wiki** spaces that are public or visible to selected roles, a
  department or a team. Every save that changes a page's draft records a
  revision of the state it leads to; the page's _History_ in the web shows
  them with a preview and a restore, read through the wiki-page routes only
  (the revision type itself has no API route).
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
- **Authoring in the web** at `/manage`: editors and admins write
  announcements, events, polls, quick links and documents (with the file
  upload) with drafts, a preview, scheduled publishing and a check for
  concurrent changes; department heads write announcements, events and
  documents for their own department. Admins, editors, department heads and
  team leads write wiki pages in the wiki itself, with drafts and a page
  history; admins and editors manage the spaces at `/manage/wiki`. Admins
  also create, rename and delete departments and teams and set heads, team
  leads and members, and manage users at `/manage/users` (invite by e-mail,
  one or several at once; role, department, manager, block; send a
  set-password link; reset a user's second factor). Every change
  advances a per-document revision and lands in an append-only activity
  trail that the admin panel lists.
- **Global search (⌘K)** with anonymous search analytics.
- **Accounts and sign-in security** for local accounts: invitations by
  e-mail with a set-password link, forgot-password links, passwords of at
  least 12 characters checked against a list of common passwords, and
  two-factor sign-in with an authenticator app (TOTP) and recovery codes,
  mandatory for admins and editors (`MFA_REQUIRED_ROLES`). Single sign-on
  users get their second factor from their identity provider.
- **Data protection:** admins export one person's data (Art. 15) and
  anonymise a blocked person (Art. 17) at `/manage/users`; training
  receipts keep a snapshot of what was completed and survive the
  anonymisation for `TRAINING_EVIDENCE_RETENTION_YEARS`; blocked people
  leave the directory; nightly jobs apply the retention rules. Every module
  outside the base (events, training, marketplace, kudos, celebrations,
  polls, duty plans, KPIs) and the read confirmations, named training
  reports and search logging can be switched off with `FEATURES_OFF`.
  The German inventory is [docs/data-protection.md](./docs/data-protection.md).

### Repository layout

```
.
├── .github/
│   ├── workflows/ci.yml    CI (build, datetime, integration, E2E, infra, images)
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
│   ├── restore-db.sh               database restore in steps (clean database, new JWT_SECRET)
│   ├── backup/pg-backup.sh         encrypted Postgres + uploads + .env backup
│   ├── backup/restore-drill.sh     off-box restore of a backup into a throwaway Postgres 16 (GPG or age)
│   ├── Caddyfile                   the bundled Caddy (standalone boxes, local full-stack runs)
│   ├── readme-permissions.test.ts  pins the permission tables of this README to the cms
│   └── .env.example
├── docs/                   DEPLOYMENT.md, security.md, architecture.md, ROADMAP.md, screenshots/
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

Strapi has 24 collection types plus two routes-only APIs
(`apps/cms/src/api/`). Who may read or write what is in
[Roles and permissions](#roles-and-permissions) below; the per-type access
rules are in
[docs/security.md](./docs/security.md#content-types-and-their-access-rules).

| Type              | Purpose                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `department`      | Org unit with head, members, teams and wiki pages (no draft & publish: one row, a save is live)                        |
| `team`            | Belongs to a department, has a lead and members (no draft & publish)                                                   |
| `announcement`    | Dashboard news, targeted by `department`, `team` and `audienceRoles`; optional read confirmation; expiry               |
| `acknowledgement` | Read receipt for a mandatory announcement, one per user, immutable                                                     |
| `comment`         | Comments on announcements and wiki pages (the web shows them on announcements)                                         |
| `reaction`        | Emoji reactions on the same targets as comments                                                                        |
| `kudos`           | Peer recognition (from, to, message, company value)                                                                    |
| `notification`    | Per-user notification rows, written by the cms only                                                                    |
| `event`           | Calendar events with ICS export and optional RSVP                                                                      |
| `event-rsvp`      | Attendance answer (`yes`/`no`/`maybe`) per user and event                                                              |
| `poll`            | Question with 2 to 10 options, deadline, anonymous flag, department targeting and guest access                         |
| `poll-vote`       | One vote per user and poll; the content API casts and counts votes through custom routes only                          |
| `document`        | File library entry, company-wide or for selected departments                                                           |
| `classified`      | Marketplace ad: 5 categories, up to 4 photos, listed for 30 days by default (at most 90)                               |
| `quick-link`      | Dashboard link, company-wide or for selected departments; written at `/manage/quick-links` or in the admin             |
| `duty-plan`       | Duty plan: who is on duty when (shift templates and shifts); written at `/manage/duty-plans`                           |
| `kpi`             | Department KPI: name, unit, rhythm (month, quarter, year), values entered by hand; written at `/manage/kpis`           |
| `course`          | Training course with ordered lessons, `mandatory` flag and completion mode; authoring API and Strapi panel             |
| `lesson`          | One lesson: Markdown body, YouTube video, optional quiz                                                                |
| `lesson-progress` | Completion receipt per user and lesson                                                                                 |
| `search-log`      | Anonymous search telemetry (term and result count, no user)                                                            |
| `wiki-space`      | Namespace for wiki pages with its own visibility                                                                       |
| `wiki-page`       | Markdown page with tags, order, optional table of contents, parent page                                                |
| `wiki-revision`   | One recorded state of a page after each changing draft save; read through the wiki-page history routes only            |
| `content-version` | Per-document revision behind the concurrent-change check (`If-Match`); written by the cms only, no route               |
| `audit-event`     | Append-only activity trail, one row per change of a guarded document (keys, no values); kept 365 days, admin-only read |
| _profile_         | Routes-only: `GET`/`PUT /api/me`, the self-service profile                                                             |
| _entra-auth_      | Routes-only: `POST /api/auth/entra/exchange`, the server-to-server step of the Microsoft sign-in (404 when off)        |
| _oidc-auth_       | Routes-only: `POST /api/auth/oidc/exchange`, the server-to-server step of the OIDC sign-in (404 when off)              |

**Draft & publish.** `announcement`, `course`, `document`, `event`,
`lesson`, `poll`, `quick-link`, `wiki-space` and `wiki-page` keep
Strapi's draft & publish (pinned per type in
`apps/cms/src/content-type-flags.test.ts`): the admin panel edits a draft
row, readers get the published row. An entry with a published row but no
draft is given its draft at boot (`apps/cms/src/utils/draft-twins.ts`; see
[Upgrading to the draft-twin repair](./docs/archive/deployment-history.md#upgrading-to-the-draft-twin-repair-fx38)).
Departments and teams have no drafts any more; a database from before that
change needs a one-time migration
([One-time: org draft/publish off](./docs/archive/deployment-history.md#one-time-org-draftpublish-off)).
Wiki revisions have none either since batch 16 (one published row per
revision; the cms refuses to boot on leftover draft rows, see
[Deploying batch 16](./docs/archive/deployment-history.md#deploying-batch-16-v2-authoring-phase-2-documents-with-uploads-the-wiki)).

### Roles and permissions

Six intranet roles are created at every boot
(`apps/cms/src/bootstrap/roles.ts`): `admin_role`, `editor`,
`department_head`, `team_lead`, `member` and `guest`. `authenticated` is the
users-permissions plugin's built-in role; nobody lands there by default (new
local users get `member`, Entra and OIDC users an intranet role), so it
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
| `acknowledgement` | CR           | CR       | CR                | CR          | CR       | —       | CR              |
| `announcement`    | CRUD         | CRUD     | CRU               | R           | R        | —       | R               |
| `classified`      | CRUD         | CRUD     | CRUD              | CRUD        | CRUD     | —       | R               |
| `comment`         | CRD          | CRD      | CRD               | CRD         | CRD      | R       | CR              |
| `course`          | CRU          | CRU      | R                 | R           | R        | —       | R               |
| `department`      | CRUD         | R        | RU                | R           | R        | —       | R               |
| `document`        | CRUD         | CRUD     | CRU               | R           | R        | R       | R               |
| `duty-plan`       | CRUD         | CRUD     | CRU               | CRU         | R        | —       | R               |
| `kpi`             | CRUD         | CRUD     | CRU               | R           | R        | —       | R               |
| `event`           | CRUD         | CRUD     | CRU               | R           | R        | R       | R               |
| `event-rsvp`      | CRUD         | CRU      | CRU               | CRU         | CRU      | —       | CRU             |
| `kudos`           | CRD          | CRD      | CR                | CR          | CR       | —       | CR              |
| `lesson`          | CRU          | CRU      | R                 | R           | R        | —       | R               |
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
| `wiki-revision`   | —            | —        | —                 | —           | —        | —       | —               |

<!-- permission-matrix:end -->

Custom actions and plugin routes (`✓` = granted, `—` = not granted):

<!-- custom-action-grants:start -->

| Action                                          | Endpoint                                        | `admin_role` | `editor` | `department_head` | `team_lead` | `member` | `guest` | `authenticated` |
| ----------------------------------------------- | ----------------------------------------------- | ------------ | -------- | ----------------- | ----------- | -------- | ------- | --------------- |
| `api::event.event.ics`                          | `GET /api/events/:id/ics`                       | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `api::event-rsvp.event-rsvp.summary`            | `GET /api/event-rsvps/summary`                  | ✓            | ✓        | ✓                 | ✓           | ✓        | —       | ✓               |
| `api::kudos.kudos.celebrations`                 | `GET /api/celebrations`                         | ✓            | ✓        | ✓                 | ✓           | ✓        | —       | —               |
| `api::notification.notification.markRead`       | `POST /api/notifications/mark-read`             | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `api::notification.notification.markAllRead`    | `POST /api/notifications/mark-all-read`         | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `api::notification.notification.unreadCount`    | `GET /api/notifications/unread-count`           | ✓            | —        | —                 | —           | —        | —       | —               |
| `api::poll-vote.poll-vote.vote`                 | `POST /api/polls/:id/vote`                      | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `api::poll-vote.poll-vote.results`              | `GET /api/polls/:id/results`                    | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `api::poll.poll.batchResults`                   | `GET /api/poll-results`                         | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `api::announcement.announcement.publish`        | `POST /api/announcements/:id/publish`           | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::announcement.announcement.unpublish`      | `POST /api/announcements/:id/unpublish`         | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::announcement.announcement.discardDraft`   | `POST /api/announcements/:id/discard-draft`     | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::announcement.announcement.authoringList`  | `GET /api/announcements/authoring`              | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::announcement.announcement.editable`       | `GET /api/announcements/:id/editable`           | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::event.event.publish`                      | `POST /api/events/:id/publish`                  | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::event.event.unpublish`                    | `POST /api/events/:id/unpublish`                | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::event.event.discardDraft`                 | `POST /api/events/:id/discard-draft`            | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::event.event.authoringList`                | `GET /api/events/authoring`                     | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::event.event.editable`                     | `GET /api/events/:id/editable`                  | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::document.document.publish`                | `POST /api/documents/:id/publish`               | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::document.document.unpublish`              | `POST /api/documents/:id/unpublish`             | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::document.document.discardDraft`           | `POST /api/documents/:id/discard-draft`         | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::document.document.authoringList`          | `GET /api/documents/authoring`                  | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::document.document.editable`               | `GET /api/documents/:id/editable`               | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::duty-plan.duty-plan.publish`              | `POST /api/duty-plans/:id/publish`              | ✓            | ✓        | ✓                 | ✓           | —        | —       | —               |
| `api::duty-plan.duty-plan.unpublish`            | `POST /api/duty-plans/:id/unpublish`            | ✓            | ✓        | ✓                 | ✓           | —        | —       | —               |
| `api::duty-plan.duty-plan.discardDraft`         | `POST /api/duty-plans/:id/discard-draft`        | ✓            | ✓        | ✓                 | ✓           | —        | —       | —               |
| `api::duty-plan.duty-plan.authoringList`        | `GET /api/duty-plans/authoring`                 | ✓            | ✓        | ✓                 | ✓           | —        | —       | —               |
| `api::duty-plan.duty-plan.editable`             | `GET /api/duty-plans/:id/editable`              | ✓            | ✓        | ✓                 | ✓           | —        | —       | —               |
| `api::kpi.kpi.publish`                          | `POST /api/kpis/:id/publish`                    | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::kpi.kpi.unpublish`                        | `POST /api/kpis/:id/unpublish`                  | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::kpi.kpi.discardDraft`                     | `POST /api/kpis/:id/discard-draft`              | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::kpi.kpi.authoringList`                    | `GET /api/kpis/authoring`                       | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::kpi.kpi.editable`                         | `GET /api/kpis/:id/editable`                    | ✓            | ✓        | ✓                 | —           | —        | —       | —               |
| `api::quick-link.quick-link.publish`            | `POST /api/quick-links/:id/publish`             | ✓            | ✓        | —                 | —           | —        | —       | —               |
| `api::quick-link.quick-link.unpublish`          | `POST /api/quick-links/:id/unpublish`           | ✓            | ✓        | —                 | —           | —        | —       | —               |
| `api::quick-link.quick-link.discardDraft`       | `POST /api/quick-links/:id/discard-draft`       | ✓            | ✓        | —                 | —           | —        | —       | —               |
| `api::quick-link.quick-link.authoringList`      | `GET /api/quick-links/authoring`                | ✓            | ✓        | —                 | —           | —        | —       | —               |
| `api::quick-link.quick-link.editable`           | `GET /api/quick-links/:id/editable`             | ✓            | ✓        | —                 | —           | —        | —       | —               |
| `api::poll.poll.authoringList`                  | `GET /api/polls/authoring`                      | ✓            | ✓        | —                 | —           | —        | —       | —               |
| `api::poll.poll.editable`                       | `GET /api/polls/:id/editable`                   | ✓            | ✓        | —                 | —           | —        | —       | —               |
| `api::wiki-space.wiki-space.authoringList`      | `GET /api/wiki-spaces/authoring`                | ✓            | ✓        | —                 | —           | —        | —       | —               |
| `api::wiki-space.wiki-space.editable`           | `GET /api/wiki-spaces/:id/editable`             | ✓            | ✓        | —                 | —           | —        | —       | —               |
| `api::wiki-page.wiki-page.createDraft`          | `POST /api/wiki-pages/drafts`                   | ✓            | ✓        | ✓                 | ✓           | —        | —       | —               |
| `api::wiki-page.wiki-page.myDrafts`             | `GET /api/wiki-pages/drafts/mine`               | ✓            | ✓        | ✓                 | ✓           | ✓        | —       | —               |
| `api::wiki-page.wiki-page.editable`             | `GET /api/wiki-pages/:id/editable`              | ✓            | ✓        | ✓                 | ✓           | ✓        | —       | —               |
| `api::wiki-page.wiki-page.saveDraft`            | `PUT /api/wiki-pages/:id/draft`                 | ✓            | ✓        | ✓                 | ✓           | ✓        | —       | —               |
| `api::wiki-page.wiki-page.publish`              | `POST /api/wiki-pages/:id/publish`              | ✓            | ✓        | ✓                 | ✓           | ✓        | —       | —               |
| `api::wiki-page.wiki-page.discardDraft`         | `POST /api/wiki-pages/:id/discard-draft`        | ✓            | ✓        | ✓                 | ✓           | ✓        | —       | —               |
| `api::wiki-page.wiki-page.revisions`            | `GET /api/wiki-pages/:id/revisions`             | ✓            | ✓        | ✓                 | ✓           | ✓        | —       | —               |
| `api::wiki-page.wiki-page.revision`             | `GET /api/wiki-pages/:id/revisions/:revisionId` | ✓            | ✓        | ✓                 | ✓           | ✓        | —       | —               |
| `api::wiki-page.wiki-page.restore`              | `POST /api/wiki-pages/:id/restore`              | ✓            | ✓        | ✓                 | ✓           | ✓        | —       | —               |
| `api::wiki-page.wiki-page.unpublish`            | `POST /api/wiki-pages/:id/unpublish`            | ✓            | ✓        | —                 | —           | —        | —       | —               |
| `api::wiki-page.wiki-page.authoringList`        | `GET /api/wiki-pages/authoring`                 | ✓            | ✓        | —                 | —           | —        | —       | —               |
| `api::search-log.search-log.summary`            | `GET /api/search-logs/summary`                  | ✓            | —        | —                 | —           | —        | —       | —               |
| `api::profile.profile.me`                       | `GET /api/me`                                   | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `api::profile.profile.updateMe`                 | `PUT /api/me`                                   | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `plugin::users-permissions.auth.changePassword` | `POST /api/auth/change-password`                | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `api::profile.profile.mfaSetup`                 | `POST /api/me/mfa/setup`                        | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `api::profile.profile.mfaActivate`              | `POST /api/me/mfa/activate`                     | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `api::profile.profile.mfaDisable`               | `POST /api/me/mfa/disable`                      | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `plugin::users-permissions.role.find`           | `GET /api/users-permissions/roles`              | ✓            | —        | —                 | —           | —        | —       | —               |
| `plugin::upload.content-api.upload`             | `POST /api/upload`                              | ✓            | ✓        | ✓                 | ✓           | ✓        | —       | —               |
| `api::classified.classified.cleanupUploads`     | `POST /api/classifieds/cleanup-uploads`         | ✓            | ✓        | ✓                 | ✓           | ✓        | —       | —               |
| `plugin::users-permissions.user.find`           | `GET /api/users`                                | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `plugin::users-permissions.user.findOne`        | `GET /api/users/:id`                            | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |
| `plugin::users-permissions.user.me`             | `GET /api/users/me`                             | ✓            | ✓        | ✓                 | ✓           | ✓        | ✓       | ✓               |

| `api::lesson.lesson.player` | `GET /api/lessons/:id/player` | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| `api::lesson.lesson.check` | `POST /api/lessons/:id/check` | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ |

| `api::course.course.authoringList` | `GET /api/courses/authoring` | ✓ | ✓ | — | — | — | — | — |
| `api::course.course.editable` | `GET /api/courses/:id/editable` | ✓ | ✓ | — | — | — | — | — |
| `api::course.course.publish` | `POST /api/courses/:id/publish` | ✓ | ✓ | — | — | — | — | — |
| `api::course.course.unpublish` | `POST /api/courses/:id/unpublish` | ✓ | ✓ | — | — | — | — | — |
| `api::course.course.discardDraft` | `POST /api/courses/:id/discard-draft` | ✓ | ✓ | — | — | — | — | — |
| `api::course.course.report` | `GET /api/courses/report` | ✓ | — | ✓ | ✓ | — | — | — |
| `api::course.course.reportCourse` | `GET /api/courses/:id/report` | ✓ | — | ✓ | ✓ | — | — | — |
| `api::lesson.lesson.authoringList` | `GET /api/lessons/authoring` | ✓ | ✓ | — | — | — | — | — |
| `api::lesson.lesson.editable` | `GET /api/lessons/:id/editable` | ✓ | ✓ | — | — | — | — | — |
| `api::lesson.lesson.publish` | `POST /api/lessons/:id/publish` | ✓ | ✓ | — | — | — | — | — |
| `api::lesson.lesson.unpublish` | `POST /api/lessons/:id/unpublish` | ✓ | ✓ | — | — | — | — | — |
| `api::lesson.lesson.discardDraft` | `POST /api/lessons/:id/discard-draft` | ✓ | ✓ | — | — | — | — | — |
| `api::department.department.editable` | `GET /api/departments/:id/editable` | ✓ | — | ✓ | — | — | — | — |
| `api::team.team.editable` | `GET /api/teams/:id/editable` | ✓ | — | ✓ | ✓ | — | — | — |
| `api::audit-event.audit-event.list` | `GET /api/audit-events` | ✓ | — | — | — | — | — | — |
| `api::user-management.user-management.list` | `GET /api/user-management` | ✓ | — | — | — | — | — | — |
| `api::user-management.user-management.findOne` | `GET /api/user-management/:id` | ✓ | — | — | — | — | — | — |
| `api::user-management.user-management.update` | `PUT /api/user-management/:id` | ✓ | — | — | — | — | — | — |
| `api::user-management.user-management.roleToEntra` | `POST /api/user-management/:id/role-to-entra` | ✓ | — | — | — | — | — | — |
| `api::user-management.user-management.invite` | `POST /api/user-management/invite` | ✓ | — | — | — | — | — | — |
| `api::user-management.user-management.sendLink` | `POST /api/user-management/:id/send-link` | ✓ | — | — | — | — | — | — |
| `api::user-management.user-management.resetMfa` | `POST /api/user-management/:id/reset-mfa` | ✓ | — | — | — | — | — | — |
| `api::user-management.user-management.trainingEvidence` | `GET /api/user-management/:id/training-evidence` | ✓ | — | — | — | — | — | — |
| `api::user-management.user-management.export` | `GET /api/user-management/:id/export` | ✓ | — | — | — | — | — | — |
| `api::user-management.user-management.anonymisePreview` | `GET /api/user-management/:id/anonymise` | ✓ | — | — | — | — | — | — |
| `api::user-management.user-management.anonymise` | `POST /api/user-management/:id/anonymise` | ✓ | — | — | — | — | — | — |
<!-- custom-action-grants:end -->

The anonymous `public` role holds none of these, and the cms revokes the
users-permissions forgot/reset-password endpoints from it. The plugin's
generic user writes (`user.create`, `user.update`, `user.destroy`) are
revoked for every role, `public` included (v0.23): users are changed through
the user administration only. What the grants
mean in practice (immutable read receipts, ownership gates, removed core
routes, the deliberate `guest` exceptions, why every role reads users, the
upload hardening) is in
[docs/security.md](./docs/security.md#permission-matrix-fine-print).

The training authoring API accepts admin/editor writes with explicit draft/published status and If-Match revisions; course/lesson deletion stays in the panel. Organisation API edits are limited to descriptions, department color and admin-only images: names, structure, membership and creation/deletion stay in the panel. The fixed activity read is admin-only, with 25 rows per page and no generic query or mutation surface. The corresponding training/org/activity web forms are the next Batch 17 step.

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

- **A new installation:** [docs/INSTALL.md](./docs/INSTALL.md).
- **Local development:** [CONTRIBUTING.md, Development setup](./CONTRIBUTING.md#development-setup). It covers three setups:
  - SQLite with Node, without Docker or a Microsoft account;
  - the full stack with Docker Compose;
  - the optional single sign-on.

## Environment reference

Each app reads its own file in development (`apps/cms/.env`,
`apps/web/.env.local`); Docker Compose reads `infra/.env` and passes each
service the keys it needs, under the names below. "Default" is what the
code uses when the variable is unset; the `.env.example` files and compose
set some differently, as noted. `apps/cms/.env.example` lists every setting
`apps/cms/config` reads (`infra/env-examples.test.ts` keeps it complete).

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

Every key, with its default and meaning, is in the example files. `infra/env-examples.test.ts` keeps them complete.

| File                                                   | Read by                                              |
| ------------------------------------------------------ | ---------------------------------------------------- |
| [infra/.env.example](./infra/.env.example)             | Docker Compose                                       |
| [apps/cms/.env.example](./apps/cms/.env.example)       | the cms in development                               |
| [apps/web/.env.example](./apps/web/.env.example)       | the web in development                               |
| [infra/deploy.env.example](./infra/deploy.env.example) | `deploy.sh` and the backup script, for host settings |

The installation steps that use these keys: [docs/INSTALL.md](./docs/INSTALL.md).

## Deployment

- **A new installation, with the bundled Caddy or behind a host Traefik:** [docs/INSTALL.md](./docs/INSTALL.md). With Traefik, the router names are fixed (`sinnlos-*`), so there is one Sinnlos stack per Traefik; a staging copy needs its own host or its own Traefik.
- **Upgrading** an existing instance, plus the release notes and rollback: [docs/UPGRADE.md](./docs/UPGRADE.md).
- **Running it** (monitoring, restore, backups, post-deployment verification, hardening): [docs/OPERATIONS.md](./docs/OPERATIONS.md).
- **Runbooks of earlier releases, and the Azure notes:** [docs/archive/deployment-history.md](./docs/archive/deployment-history.md).

Production deploys run **`infra/deploy.sh`** in the checkout, as the user that owns the checkout (from a root shell: `sudo -u <owner> -H infra/deploy.sh`). In order, it:

1. checks `infra/.env` against the env contract (`--check` runs only that);
2. takes a lock and requires a clean checkout;
3. reports the commit's CI result: the runs of this repository's CI, leaving out Dependabot's own update jobs on the commit. `--require-green-ci` refuses a red one;
4. takes a pre-deploy backup;
5. builds and restarts, behind the bundled Caddy or a host Traefik (`DEPLOY_EDGE=traefik`; host settings in `infra/deploy.env`);
6. smoke-checks the site and runs `infra/live-smoke.sh`;
7. only then tags the images with the commit and records them as the last known good.

A failure prints the rollback commands for a verified target ([docs/UPGRADE.md, Rollback](./docs/UPGRADE.md#rollback)). `--dry-run` prints the plan and changes nothing.

The cms trusts the `X-Forwarded-For` header the edge sets, so the edge must overwrite that header from clients ([Production hardening](./docs/OPERATIONS.md#production-hardening)).

## Accessibility

Each release checks the main screens for WCAG 2.1 A and AA with axe in the browser tests ([e2e/a11y.spec.ts](./e2e/a11y.spec.ts)), in light and dark mode. The screens are: sign-in and the second factor, the dashboard, search, an editor form, a lesson with its quiz, kudos and polls. A manual keyboard and zoom pass covers the same paths.

This is a test, not a conformance claim. Please report a barrier as an issue.

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
pnpm typecheck         # build:domain, tsc for all workspaces, then typecheck:tests
pnpm typecheck:tests   # type-check every *.test.ts (tsconfig.test.json, tsconfig.test.cms.json)
pnpm test              # Vitest unit tests (apps, packages, infra), then E2E runner checks
pnpm test:tz           # the same suite under TZ=UTC, Europe/Berlin and Pacific/Auckland
pnpm test:integration  # build:domain, then the real cms booted in process, per role, over HTTP
pnpm test:e2e          # disposable Docker stack + Chromium: teams, three quiz modes and authoring
pnpm format            # prettier --write over the tree
pnpm format:check      # prettier --check (blocking in CI)
```

Browser E2E setup and its current scope are documented in
[docs/e2e-tests.md](./docs/e2e-tests.md).

And in `infra/`:

```bash
infra/deploy.sh --check      # validate infra/.env against the env contract, deploy nothing
infra/deploy.sh --dry-run    # every deploy check, then the plan; changes nothing
infra/deploy.sh              # the production deploy (see Deployment)
infra/live-smoke.sh          # datetime check, then the SSE live pipeline end to end
infra/restore-db.sh prepare <dump>   # a restore, step 1 of 4: then apply, rotate-jwt, start (see Deployment)
infra/restore-db.sh status           # where the current restore attempt stands (cancel: end it before apply)
infra/backup/restore-drill.sh --all <dir>  # off-box: restore the newest dump into a throwaway Postgres 16
infra/backup/restore-drill.sh --generation <dir> --identity <age key>  # off-box: the same for a backup-run generation
```

**CI** (`.github/workflows/ci.yml`) runs on every pull request and on
pushes to `main` (other branches through "Run workflow"): `build`
(typecheck, lint, `format:check`, test, build, `pnpm audit --prod` blocking
at `critical`, advisory at `high`), `datetime` (`pnpm test:tz` with Postgres
16), `integration` (`pnpm test:integration` on SQLite and Postgres 16),
`infra` (shellcheck, `docker compose config` of every compose variant) and
`images` (both Dockerfiles built, not pushed), plus `e2e · browser` (Chromium
testing team editing/permissions, all three quiz modes and training authoring
in six cases against its own disposable CMS/web/Postgres stack). Docs-only changes under
`docs/**/*.md` skip application/database/E2E runs. E2E has its own path scope;
relevant web-only changes start its private DB without enabling the other
database suites. See [E2E scope and artifacts](./docs/e2e-tests.md#ci-execution-and-scope).
Actions are pinned by commit
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
