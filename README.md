# Sinnlos Intranet

A self-hosted company intranet with **Microsoft Entra ID (Azure AD)** single sign-on,
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
- **Auth** — Auth.js (NextAuth v5) Microsoft Entra ID provider → Strapi
  users-permissions Microsoft provider → Strapi JWT, or local e-mail +
  password against Strapi. **Microsoft sign-in is unavailable on the current
  release** (Strapi 5.55.1 rejects the token exchange, see
  [step 4](#4-run-locally-two-terminals)); local sign-in is the supported
  path until the planned Entra redesign ships.
- **Deployment** — Docker Compose in `infra/`. Local full-stack runs use the
  bundled **Caddy** (automatic TLS); the live production host (srv-prod-01)
  fronts the same compose stack with **Traefik** via a second override file.

**→ [Full deployment guide](./docs/DEPLOYMENT.md)** — bare-metal, Docker, VPS (Traefik), Azure VM, Azure Container Apps.

**→ [Architecture map](./docs/architecture.md)** — topology, data model, request/caching flow, the conventions you must know before changing code, and the known open issues.

## Repository layout

```
.
├── apps/
│   ├── cms/                Strapi v5 backend
│   └── web/                Next.js 16 frontend
├── infra/
│   ├── docker-compose.yml          base stack (db, cms, web, caddy)
│   ├── docker-compose.traefik.yml  prod override (Traefik instead of Caddy)
│   ├── deploy.sh                   direct prod deploy (env preflight → backup → tag → build → smoke; --check = preflight only)
│   ├── live-smoke.sh               end-to-end SSE pipeline probe (run by deploy.sh)
│   ├── backup/pg-backup.sh         nightly encrypted Postgres + uploads backup
│   ├── Caddyfile                   used only for local full-stack runs
│   └── .env.example
├── pnpm-workspace.yaml
└── package.json
```

## Prerequisites

- Node.js 22.13+ or 24 LTS (root `engines`: `^22.13.0 || ^24.0.0`; CI and
  the Docker images use Node 24; Node 20 is end-of-life)
- pnpm ≥ 9 (`corepack enable && corepack prepare pnpm@9.12.0 --activate`)
- Docker + Docker Compose (for production / full stack run)
- A Microsoft Entra ID tenant with permission to register an app — only for
  Microsoft sign-in, which the current release cannot offer (use
  [standalone mode](#running-without-microsoft-standalone-mode))

## 1. Install dependencies

```bash
pnpm install
```

Run it again after pulling a change to the lockfile (hardening batch 2, for
example, brought vitest 4.1.11 and Vite 7.3.6 for the root test tooling).

## 2. Register the Microsoft Entra ID app

> **Skip this on the current release.** Strapi 5.51+ (the cms runs 5.55.1)
> answers the web's server-side Microsoft token exchange with a 400, so
> Microsoft sign-in cannot complete. Use
> [standalone mode](#running-without-microsoft-standalone-mode) until the
> planned Entra redesign ships; the steps below stay for reference.

In the Azure portal:

1. **App registrations → New registration**
2. **Redirect URIs (Web)** — add both:
   - `http://localhost:3000/api/auth/callback/microsoft-entra-id` (Next.js / Auth.js)
   - `http://localhost:1337/api/connect/microsoft/callback` (Strapi's own
     OAuth redirect; not used by the current flow, which exchanges the
     access token server-side, but harmless to register)
   - Add the production equivalents once you have a domain.
3. **Front-channel logout URL** (on the same *Authentication* blade,
   further down the page): `http://localhost:3000/sign-in`. This is
   required for federated sign-out — without it, clicking "Sign out"
   still ends the local session but leaves the Microsoft tenant cookie
   intact, and the next login skips the password prompt. Add the
   production equivalent alongside it.
4. **API permissions (delegated)**:
   - `openid`, `profile`, `email`, `User.Read`
   - `GroupMember.Read.All` (needed to map Entra groups → intranet roles)
   - Grant admin consent.
5. **Certificates & secrets** → new client secret, copy the value.

## Running without Microsoft (standalone mode)

No Entra ID tenant? Leave every `MS_*` / `AUTH_MICROSOFT_*` variable
empty and local email+password sign-in (against Strapi) activates
automatically on both apps — no extra configuration needed. **On the
current release this is the supported sign-in path** (Microsoft sign-in
cannot complete, see step 2). Accounts
are created in the Strapi admin (**Content Manager → User**) or via
self-registration when `LOCAL_REGISTRATION=1` is set in **both**
`apps/web/.env.local` and `apps/cms/.env`. New local users get the
`member` role; users manage their own display name, job title and phone
on **/profile**; password resets are done by an admin in the Strapi
panel (no SMTP required).

Quick start:

1. Copy the env files (step 3 below) and leave all `MS_*` /
   `AUTH_MICROSOFT_*` values empty; generate `AUTH_SECRET` and the
   Strapi secrets as usual.
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

To offer local sign-in *alongside* Microsoft, keep the Entra vars set
and add `AUTH_LOCAL_ENABLED=1` to `apps/web/.env.local`. On the current
release that only adds a Microsoft button that cannot complete, and
`infra/deploy.sh` refuses to deploy with a real app registration configured.

## 3. Environment files

```bash
cp apps/cms/.env.example apps/cms/.env
cp apps/web/.env.example apps/web/.env.local
cp infra/.env.example infra/.env
```

Leave `MS_CLIENT_ID`, `MS_CLIENT_SECRET` and `MS_TENANT_ID` empty on the
current release (Microsoft sign-in cannot complete, see step 2), and
generate strong secrets for every empty secret in `infra/.env` and every
`toBeModified` placeholder in `apps/cms/.env`:

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
- **`JWT_SECRET`** signs the users' 7-day Strapi JWTs. Rotating it signs
  everyone out once. An instance upgraded from a release before 2026-09-24
  must rotate it once (see
  [Upgrading from a release before 2026-09-24](./docs/DEPLOYMENT.md#upgrading-from-a-release-before-2026-09-24));
  `infra/deploy.sh` refuses to deploy until it is rotated. The Strapi 5.55.1
  upgrade needs no rotation: tokens issued by 5.49 stay valid.
- **`MS_*`:** leave empty on the current release. `infra/deploy.sh` refuses
  to deploy while `MS_CLIENT_ID` (a real app registration) and
  `MS_CLIENT_SECRET` are set, because Microsoft sign-in cannot complete on
  Strapi 5.51+ ([upgrade notes](./docs/DEPLOYMENT.md#upgrading-an-existing-instance-to-this-release)).
- **Optional:** `LIVE_EVENTS_DISABLED=1` switches the live SSE pipeline off
  (same value on cms and web). `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`
  enable the e-mail digests (dark without them). Once SMTP is set,
  `DIGEST_FROM` is required too (there is no built-in sender any more;
  without it every run is skipped and `infra/deploy.sh` refuses to deploy).
  Digest links use `PUBLIC_WEB_URL` (compose default: `WEB_PUBLIC_URL`), and
  `DIGESTS_DISABLED=1` is the kill switch.

## 4. Run locally (two terminals)

```bash
# Terminal A — Strapi
pnpm --filter @sinnlos/cms dev

# Terminal B — Next.js
pnpm --filter @sinnlos/web dev
```

- Strapi admin: http://localhost:1337/admin (see admin bootstrap note below)
- Web: http://localhost:3000 — redirects to `/sign-in`; sign in with e-mail +
  password ([standalone mode](#running-without-microsoft-standalone-mode)).
  With Microsoft configured, the web logs an `[auth]` error at boot: the
  Microsoft button cannot complete a sign-in on the current release.

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

On first sign-in, Strapi will:

1. Create a user keyed on the Entra ID `oid` claim.
2. Fetch `displayName`, `jobTitle`, `department` from Microsoft Graph `/me`.
3. Look up the user's Entra groups via Graph `/me/memberOf`.
4. Map the first matching group to a Strapi role (see
   [`apps/cms/config/ms-role-map.ts`](./apps/cms/config/ms-role-map.ts)).

> **Current state (verified 2026-09-25):** Microsoft sign-in does not
> complete at all on the current release. Strapi's users-permissions 5.51+
> (the cms runs 5.55.1) finishes `/api/auth/microsoft/callback` only from
> its own OAuth session, so it answers the web's server-side access-token
> exchange with a 400 and the sign-in fails closed. The web logs an
> `[auth]` error at boot when Microsoft is configured, and `infra/deploy.sh`
> refuses to deploy with a real app registration. An instance that relies
> on Microsoft sign-in stays on the previous (Strapi 5.49) release.
>
> Even on Strapi 5.49 steps 2–4 do not run. The users-permissions extension
> patches the controller factory instead of the controller, so it is inert.
> Strapi's built-in callback keys a new Microsoft user on the lowercased
> `userPrincipalName` (as e-mail), creates it only while
> `LOCAL_REGISTRATION=1` is set on the cms, and gives it the default
> `member` role. Roles are then assigned in the Strapi admin. A redesign of
> the Entra sign-in replaces this path; it is not part of the current
> release. See [Role flow](#role-flow-sign-in--strapi--frontend).

## 5. Content model + roles

Strapi ships 22 collection types plus one routes-only API
(`apps/cms/src/api/`):

| Type | Purpose |
| --- | --- |
| **department** | Top-level org unit with head, members, teams, pages. Master data **without draft & publish**: one row per department with a stable id; saving in the admin is live immediately (no Publish/Unpublish), hiding a unit means deleting it |
| **team** | Belongs to a department, has a lead and members. Like department: **no draft & publish**, one row per team, a save is live |
| **announcement** | Dashboard news items, targeted via `audience` / `audienceRoles` / departments; optional read confirmation (`requiresAck` + `ackDeadline`) |
| **acknowledgement** | Read receipt for a mandatory announcement — one per user, anchored to the target's **`targetDocumentId`** (stable across re-publish), immutable once created |
| **comment** | Comments on announcements and wiki pages (`targetType` + `targetDocumentId` — the target's documentId, stable across re-publishes; no FK). Reads and creates are filtered to targets the caller may see (#28) |
| **reaction** | Emoji reactions, same polymorphic `targetType`/`targetDocumentId` anchor and the same #28 target-visibility enforcement |
| **kudos** | Peer recognition (`from` → `to` user, message, company value) |
| **notification** | Per-user notification rows (recipient, actor, link), fan-out via lifecycles |
| **event** | Calendar events, ICS export via custom route; optional RSVP (`rsvpEnabled` + `capacity`). `departments` decide who is notified, not who can read: every role with `event.find` (guest included) sees all published events |
| **event-rsvp** | Attendance answer (`yes`/`no`/`maybe`) per user + event, anchored to the event's `documentId`; `create` is an **upsert**, capacity counts distinct "yes" users |
| **poll** | Question + options, `closesAt`, `anonymous` flag. `departments` is stored but not enforced yet (every poll is visible to every role with `poll.find`; poll targeting is planned) |
| **poll-vote** | One vote per user per poll, cast and counted only via the custom `POST /api/polls/:id/vote` and `GET /api/polls/:id/results` routes. There are no generic `/api/poll-votes` routes |
| **document** | File library entry; `departments` m2m — no relation = company-wide |
| **classified** | Employee marketplace ad (`/marketplace`): 5 categories (sale, giveaway, wanted, service-offer/-wanted), up to 4 photos, `expiresAt` auto-set to +30 days (max 90) — expired ads drop out of the list without a cron |
| **quick-link** | Central link gateway on the dashboard (label, URL, icon, category, order); `departments` m2m — no relation = company-wide. No frontend editing UI — maintained in the Strapi admin panel |
| **course** | Training course (draft & publish): ordered lessons, `mandatory` flag, `completionMode` (`confirm` \| `quizGate` — quiz must be passed before completion unlocks). Maintained in the Strapi admin panel; the content api is read-only |
| **lesson** | One lesson of a course: markdown body, `order`, YouTube-only `videoUrl` (validated in a lifecycle AND render-gated in the web player), `quiz` JSON self-check. First validating `beforeCreate`/`beforeUpdate` lifecycle in the repo (admin writes bypass content-api controllers) |
| **lesson-progress** | Completion receipt per user + lesson, anchored on the lesson's `documentId` (survives re-publish); own-rows read policy, admin report at `/manage/training`. Course completion is derived at read time — a lesson added later re-opens the course |
| **search-log** | Anonymous search telemetry (term + result count, deliberately NO user relation): write-only content api, aggregated admin-only `/search-logs/summary`, 90-day retention cron. Feeds the Meilisearch go/no-go decision |
| **wiki-space** | Namespace for wiki pages with scoped visibility |
| **wiki-page** | Markdown body, tags, parent/children, author, revisions |
| **wiki-revision** | Auto-captured snapshot of a page before each update |
| *profile* | Routes-only API (no schema): `GET`/`PUT /api/me` self-service profile (incl. the birthday fields and the e-mail digest opt-ins below) |

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
Details: [Upgrading to the draft-twin repair](./docs/DEPLOYMENT.md#upgrading-to-the-draft-twin-repair-fx38).

The users-permissions **User** is extended with `department`, `teams`,
`manager` (self-relation, drives the org chart), `microsoftOid`, and the
schema-`private` pair `birthday` / `birthdayVisible`: birthdays are strictly
**opt-in** (maintained via `/api/me`, never exposed through user reads) and
only surface — without the year of birth — in the celebrations feed when
`birthdayVisible` is set. Since the e-mail digests (#18) the user also
carries `digestAnnouncements` / `digestMentions` / `digestKudos` (booleans),
`digestFrequency` (`daily` | `weekly`, default weekly) and the
schema-`private`, cron-owned `lastDigestAt` — the opt-ins are maintained on
the profile page via the same `/api/me` whitelist.

Six roles are created automatically on Strapi boot (see
[`apps/cms/src/index.ts`](./apps/cms/src/index.ts)):
`admin_role`, `editor`, `department_head`, `team_lead`, `member`, `guest`.
The same bootstrap grants each role sensible default REST permissions on
every intranet content type (broad reads, writes scoped per role — with the
deliberate `guest` exceptions listed under the permission matrix below).
Writes are then further gated by the route-level policies listed below.

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
decide *whether* a caller may write a row and in which role class (head,
lead, author, …); `apps/cms/src/utils/write-allowlist.ts` decides *what* a
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
- `published-only` — pins reads without a row filter (event, poll,
  department, team) to `status=published`, so `?status=draft` no longer
  returns unpublished entries; admin/editor bypass and keep draft reads.
  department and team have no drafts of their own any more, but `status`
  still decides which rows of their populated draft & publish relations
  come back. The custom ICS, vote and results actions read published rows
  only as well
- `acknowledgement-visibility` — reads restricted to the caller's own read
  receipts; `admin_role` bypasses for the `/manage/acknowledgements` report
- `announcement-visibility` — server-side audience targeting (#9):
  department AND team AND audienceRoles, resolved to a non-relational id
  filter; pins `status=published`
- `comment-target-visibility` — comment/reaction reads filtered to targets
  the caller may see (#28; the create counterpart lives in the controllers
  via `isTargetVisible`)
- `training-visibility` — courses/lessons pinned to `status=published`;
  lessons only visible when their owning course is published (fail-closed);
  admin/editor bypass for draft preview (#29)
- `lesson-progress-visibility` — reads restricted to the caller's own
  completion receipts; `admin_role` bypasses for the `/manage/training`
  report (#29)

The read-side policies share helpers in `apps/cms/src/utils/`:
`policy-query.ts` provides `getMutableQuery` (policies must mutate the real
Koa `request.query` — `policyContext.query` is a copy the core controllers
never read) and `restrictiveIdFilter` (an empty id allow-list is injected as
`{ id: { $eq: -1 } }` because Strapi's query sanitizer strips an empty
`$in: []`, which would fail **open**), and `forcePublishedStatus` (after the
`admin_role`/`editor` bypass: pins `status=published` and drops the
publication-cohort keys `publicationFilter`/`hasPublishedVersion` and the
v4 `publicationState`, so a reader can neither fetch drafts nor learn which
published entries have pending edits). `visible-ids.ts` (`loadUserScope`,
`visibleWikiSpaceIds`) resolves per-user wiki-space visibility,
`target-visibility.ts` (`visibleTargetAnchors`, `isTargetVisible`) decides
comment/reaction target visibility for #28, and
`wiki-edit-context.ts` carries the authenticated editor from the wiki-page
controller into the revision-snapshot lifecycle via `AsyncLocalStorage`, so
revisions written through the REST API record who actually edited (edits in
the Strapi admin panel have no such context).

Global guards that apply to **every** content-API route, not per route:

- **Relation guard** (`registerRestrictedRelationGuard` in `src/index.ts`,
  rules in `utils/restricted-relations.ts`) — a relation into a
  visibility-filtered type is only followed from that type's own filter
  domain. Today this protects wiki pages: `department.pages`/`team.pages`
  (and any chain that reaches them, e.g. `/api/users?populate[department]…`)
  are dropped from `populate`, rejected with a 400 in `filters`/`sort`, and
  deleted from responses. `admin_role`/`editor` bypass it. It wraps
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
- **`global::uploads-auth`** middleware — `/uploads/*` file bytes only for
  requests carrying `INTERNAL_UPLOAD_TOKEN` (i.e. the web's session-gated
  proxy); everything else gets 404, whatever the encoding of the path.
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
│     Microsoft: Entra access token →                             │
│                /api/auth/microsoft/callback → Strapi JWT        │
│                (Strapi 5.51+ answers 400: unavailable for now)  │
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

**Entra ID group → Strapi role** (configured in
[`apps/cms/config/ms-role-map.ts`](./apps/cms/config/ms-role-map.ts)):

| Microsoft group    | Strapi `role.type`             |
| ------------------ | ------------------------------ |
| `Intranet-Admins`  | `admin_role`                   |
| `Intranet-Editors` | `editor`                       |
| `Department-Heads` | `department_head`              |
| `Team-Leads`       | `team_lead`                    |
| *(no match)*       | `member`  ← `DEFAULT_ROLE`     |
| *(manual only)*    | `guest`                        |

> This mapping is configured but **not applied**: Microsoft sign-in is
> unavailable on the current release (Strapi 5.55.1), and on Strapi 5.49 the
> users-permissions extension that would run it was inert (see the note
> under [step 4](#4-run-locally-two-terminals)). Microsoft users keep the
> default `member` role until an admin changes it in the Strapi admin.
> The planned Entra redesign takes roles from Entra app roles instead.

`guest` has no group mapping — only an admin can assign it in Strapi.
`authenticated` is the users-permissions plugin's built-in role. The
bootstrap forces `default_role = member` on every boot, so new local and
Microsoft users start as `member`; `authenticated` only applies to accounts
an admin (or an older version) put there. Its permissions mirror
`member`-level read access so the dashboard still works for such accounts.

**Strapi role capabilities** (REST API permissions seeded by
`PERMISSION_MATRIX` in `apps/cms/src/index.ts`, further gated by the policies
above; `R` = find + findOne, `C` = create, `U` = update, `D` = delete):

| Role | Announcements | Acks · RSVPs | Depts / Teams | Docs · Events · Polls | Classifieds | Quick-links | Wiki spaces · pages · revisions | Comments · Reactions | Kudos | Notifications | Courses · Lessons / Progress | Search-log |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `admin_role` | CRUD | CRUD | CRUD / CRUD | CRUD | CRUD | CRUD | CRUD | R+C+D | R+C+D | R+D | R / R+C | C |
| `editor` | CRUD | R+C · R+C+U | R / R | CRUD | CRUD | CRUD | CRUD | R+C+D | R+C+D | R+D | R / R+C | C |
| `department_head` | R | R+C · R+C+U | R+U / R+U | R | CRUD | R | R · R+C+U · R | R+C+D | R+C | R+D | R / R+C | C |
| `team_lead` | R | R+C · R+C+U | R / R+U | R | CRUD | R | R · R+C+U · R | R+C+D | R+C | R+D | R / R+C | C |
| `member` | R | R+C · R+C+U | R / R | R | CRUD | R | R · R+U · R | R+C+D | R+C | R+D | R / R+C | C |
| `guest` | — | — · — | — / — | R | — | R | R · R · — | R | — | R | — / — | C |
| `authenticated` *(fallback)* | R | R+C · R+C+U | R / R | R | R | R | R | R+C | R+C | R | R / R+C | C |

No role holds any `poll-vote` grant: votes are cast and counted only
through the custom `vote`/`results` actions below.

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
calendar but neither respond nor see attendee names), and **no training**
(no course/lesson/lesson-progress grants at all — while `search-log.create`
IS granted to guest: search telemetry is anonymous by design). Grants that older
bootstrap versions handed to `guest` are actively removed again via the
`REVOKED_PERMISSIONS` mechanism in the same file (`ensurePermission` only ever
*adds* rows, so revocations must be listed explicitly to take effect on
existing databases).

Every role in the matrix — **including `guest`** — additionally gets
`user.find`/`findOne` (so populated relations like author/lead/head survive);
this also powers the people directory. `USER_READ_EXCLUDED_ROLES` is empty:
an earlier audit attempt to revoke the grant from `guest` turned every guest
read that populates a user relation (and the notification visibility
filter) into a 400, because Strapi's core controllers run
`validateQuery` → `throwRestrictedRelations` *before* the sanitize pass.
(On Strapi 5.55.1 such a populate is dropped silently instead of failing,
which would still strip every author and uploader name from guest pages;
filters through a user relation still answer 400.)
The contact fields a guest could read that way (email, phone, hireDate,
officeLocation, microsoftOid) are removed output-side by the contact-field
sanitizer (#10, see the global guards above). Custom (non-CRUD) route
actions (ICS export, celebrations — staff roles only, not `guest` or
`authenticated` —, poll `vote` — every role except `guest` —,
mark-read/mark-all-read, poll `results`, `/api/me`, `changePassword`,
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
  into a link on *any* entry — someone else's ad, an avatar, a document —
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

| Helper | Roles | Used for |
| --- | --- | --- |
| `isAdmin` | `admin_role` | sidebar *Admin* link; `/manage`, `/manage/acknowledgements`, `/manage/analytics`, `/manage/training` (redirect non-admins to `/`); marketplace detail/edit controls for someone else's ad |
| `canCreatePolls` | `admin_role`, `editor` | *New poll* button, `/polls/new`, the create-poll action |
| `canRsvp` | the five staff roles + `authenticated` | RSVP controls and the RSVP fetch on `/events` |
| `canPostAds` | the five staff roles | *New ad* button, `/marketplace/new` |

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
(built-in default `de` when the var is unset or invalid; supported values
`en`, `de`). Users switch languages with the
locale switcher in the UI, which sets the cookie through a Server Action
(`apps/web/src/lib/locale-actions.ts`). Message catalogs live in
`apps/web/messages/en.json` and `apps/web/messages/de.json` — new
user-visible strings must be added to **both** files.

## 6. Production deployment

The base `infra/docker-compose.yml` ships a **Caddy** reverse proxy so a fresh
self-hosted box works with one command:

```bash
cd infra
cp .env.example .env
# fill in DOMAIN and the secrets; leave MS_* empty on the current release
docker compose up -d --build
```

Caddy obtains a Let's Encrypt certificate for `$DOMAIN`, proxies `/api/*`
(except `/api/auth/*`, which is Auth.js on Next.js), `/admin*`, `/upload*`
(the media-library API) and the other Strapi admin paths to Strapi, and
everything else to Next.js — including `/uploads/*`, the file bytes, which
Next.js serves through its session-gated proxy route. Point your DNS
A/AAAA record at the host and the stack is live.

### Live production (srv-prod-01, Traefik)

The hosted instance at <https://sinnlos.yurtbay.dev> runs the **same stack
behind the host's shared Traefik** instead of Caddy. A second compose file
(`docker-compose.traefik.yml`) disables the bundled Caddy and attaches `web` +
`cms` to the external `frontend` Docker network with Traefik routing labels:

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
  up -d --build          # compose project name must stay 'infra'
```

`infra/deploy.sh` wraps this end to end: env preflight (`infra/.env` against
the env contract; `infra/deploy.sh --check` runs only this step) →
pre-deploy DB backup → tag the running images `:rollback` → rebuild +
restart → curl smoke-check → live-pipeline smoke. TLS, the security
response headers, and the edge rate limits all live at the Traefik layer
(see the override labels). The cms trusts the `X-Forwarded-For` the edge
sets (its sign-in throttles count per client IP), so the host Traefik must
not accept that header from clients. The web and cms containers run
**non-root** with `no-new-privileges`. Full details — upgrading an existing
instance, backup/restore, rollback, hardening — are in
**[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)**.

## 7. Useful scripts

```bash
pnpm dev               # run every workspace in parallel
pnpm build             # build every workspace (the cms build deletes apps/cms/dist first)
pnpm typecheck         # tsc for both apps + typecheck:tests (also run in CI)
pnpm typecheck:tests   # type-check every *.test.ts: tsconfig.test.json (web + infra,
                       # strict) and tsconfig.test.cms.json (cms, Strapi's settings)
pnpm test              # vitest 4 unit tests from the repo root (also run in CI)
pnpm cms:dev           # just Strapi
pnpm web:dev           # just Next.js
infra/deploy.sh --check  # validate infra/.env against the env contract, deploy nothing
infra/live-smoke.sh    # prove the SSE live pipeline end to end (comment → ping frame)
```

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

## 8. Verification checklist

- [ ] `pnpm install` completes cleanly
- [ ] Strapi admin loads at `:1337/admin`, first admin created
- [ ] The six intranet roles visible under *Settings → Users & Permissions →
      Roles* (next to the built-in *Authenticated* and *Public*)
- [ ] Create a department, a team, a wiki space + page via the admin
- [ ] With `SEED_DEMO_DATA=1`, the seeded announcements, events, wiki pages
      and the rest show in the Content Manager's default list as
      *Published*, and editing and publishing one keeps its relations
      (author, department, space, …)
- [ ] Next.js dashboard at `:3000` shows stat cards and empty states
- [ ] Local sign-in (e-mail + password) completes and returns to the
      dashboard with your display name in the topbar (Microsoft sign-in is
      unavailable on the current release)
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
- [ ] An admin sees the *Admin* link and `/manage`; an editor sees
      *New poll*; a guest sees no RSVP controls and no *New ad* button
- [ ] `docker compose up -d` brings the full stack up behind the reverse proxy
      (Caddy locally / Traefik on srv-prod-01)
- [ ] A comment posted in session A appears in session B in under two
      seconds without a reload (SSE) — or run `infra/live-smoke.sh`
- [ ] `/training` lists published courses; on a `quizGate` course the
      completion button stays locked until every quiz answer is correct;
      `/manage/training` shows the completion report (admin)
- [ ] After a few ⌘K searches, `/manage/analytics` shows the search section
      (totals, zero-result rate, top terms)
- [ ] Digest opt-ins save on `/profile`; without SMTP env the 07:30 cron
      logs `[digest] skipped` (dark mode)
