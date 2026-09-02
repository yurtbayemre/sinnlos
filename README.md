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
  users-permissions Microsoft provider → Strapi JWT
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
│   ├── deploy.sh                   direct prod deploy (backup → tag → build → smoke)
│   ├── live-smoke.sh               end-to-end SSE pipeline probe (run by deploy.sh)
│   ├── backup/pg-backup.sh         nightly encrypted Postgres + uploads backup
│   ├── Caddyfile                   used only for local full-stack runs
│   └── .env.example
├── pnpm-workspace.yaml
└── package.json
```

## Prerequisites

- Node.js 20 LTS, 22 LTS, or 24 LTS (≥ 20.11)
- pnpm ≥ 9 (`corepack enable && corepack prepare pnpm@9.12.0 --activate`)
- Docker + Docker Compose (for production / full stack run)
- A Microsoft Entra ID tenant with permission to register an app

## 1. Install dependencies

```bash
pnpm install
```

## 2. Register the Microsoft Entra ID app

In the Azure portal:

1. **App registrations → New registration**
2. **Redirect URIs (Web)** — add both:
   - `http://localhost:3000/api/auth/callback/microsoft-entra-id` (Next.js / Auth.js)
   - `http://localhost:1337/api/connect/microsoft/callback` (Strapi)
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
automatically on both apps — no extra configuration needed. Accounts
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
   and content for every module. Otherwise create users in the Strapi admin
   under **Content Manager → User**
   (set email, password, and confirmed = true) — or let people register
   themselves if you enabled registration.
5. Sign in at http://localhost:3000/sign-in with email + password.

To offer local sign-in *alongside* Microsoft, keep the Entra vars set
and add `AUTH_LOCAL_ENABLED=1` to `apps/web/.env.local`.

## 3. Environment files

```bash
cp apps/cms/.env.example apps/cms/.env
cp apps/web/.env.example apps/web/.env.local
cp infra/.env.example infra/.env
```

Fill in `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID`, and generate
strong secrets for every `change-me` / `toBeModified` placeholder:

```bash
openssl rand -base64 32
```

## 4. Run locally (two terminals)

```bash
# Terminal A — Strapi
pnpm --filter @sinnlos/cms dev

# Terminal B — Next.js
pnpm --filter @sinnlos/web dev
```

- Strapi admin: http://localhost:1337/admin (see admin bootstrap note below)
- Web: http://localhost:3000 — redirects to `/sign-in`, click **Sign in with Microsoft**

> **Strapi admin account:** the first time Strapi boots with an empty
> `admin_users` table, `src/index.ts → bootstrap()` will auto-create a
> **Super Admin** from `STRAPI_ADMIN_EMAIL` / `STRAPI_ADMIN_PASSWORD`
> in `apps/cms/.env`. Set those before the first boot and you can log
> straight into `/admin` with no registration form. Leave them blank to
> keep the classic interactive flow. Strapi CE does **not** support SSO
> for the admin panel — Entra ID SSO only applies to the Next.js
> frontend (i.e. `users-permissions` users, not `admin_users`). Admin
> SSO is a Strapi Enterprise Edition feature.

> **Database:** the default `apps/cms/.env.example` uses **SQLite** (file
> at `apps/cms/.tmp/data.db`) so local dev needs no database server. If
> you want Postgres locally, uncomment the `DATABASE_CLIENT=postgres`
> block and set `DATABASE_HOST=localhost`. The hostname `db` that appears
> in `infra/.env.example` is the Docker Compose service name and only
> resolves inside the Compose network.

On first sign-in, Strapi will:

1. Create a user keyed on the Entra ID `oid` claim.
2. Fetch `displayName`, `jobTitle`, `department` from Microsoft Graph `/me`.
3. Look up the user's Entra groups via Graph `/me/memberOf`.
4. Map the first matching group to a Strapi role (see
   [`apps/cms/config/ms-role-map.ts`](./apps/cms/config/ms-role-map.ts)).

## 5. Content model + roles

Strapi ships 22 collection types plus one routes-only API
(`apps/cms/src/api/`):

| Type | Purpose |
| --- | --- |
| **department** | Top-level org unit with head, members, teams, pages |
| **team** | Belongs to a department, has a lead and members |
| **announcement** | Dashboard news items, targeted via `audience` / `audienceRoles` / departments; optional read confirmation (`requiresAck` + `ackDeadline`) |
| **acknowledgement** | Read receipt for a mandatory announcement — one per user, anchored to the target's **`targetDocumentId`** (stable across re-publish), immutable once created |
| **comment** | Comments on announcements and wiki pages (`targetType` + `targetDocumentId` — the target's documentId, stable across re-publishes; no FK). Reads and creates are filtered to targets the caller may see (#28) |
| **reaction** | Emoji reactions, same polymorphic `targetType`/`targetDocumentId` anchor and the same #28 target-visibility enforcement |
| **kudos** | Peer recognition (`from` → `to` user, message, company value) |
| **notification** | Per-user notification rows (recipient, actor, link), fan-out via lifecycles |
| **event** | Calendar events, department-scoped, ICS export via custom route; optional RSVP (`rsvpEnabled` + `capacity`) |
| **event-rsvp** | Attendance answer (`yes`/`no`/`maybe`) per user + event, anchored to the event's `documentId`; `create` is an **upsert**, capacity counts distinct "yes" users |
| **poll** | Question + options, `closesAt`, `anonymous` flag, department targeting |
| **poll-vote** | One vote per user per poll, cast via custom `vote`/`results` routes |
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
- `is-department-head` — department update requires matching department
- `is-team-member-or-lead` — team update requires membership/lead
- `can-edit-wiki` — wiki page write gated by author / department head / team lead
- `is-classified-author` — marketplace ad update/delete only by its author
  (admin/editor bypass for moderation)
- `is-event-rsvp-owner` — RSVP update only by the responding user (admin
  bypass; deliberately **no** editor bypass — an RSVP is a personal statement,
  not content)
- `is-reaction-author` — reaction delete only by its author (admin/editor bypass)
- `is-notification-recipient` — notification delete only by its recipient (or admin)

Read-side filters:

- `wiki-visibility` — read filter based on `space.visibility` (public / role /
  department / team)
- `document-visibility` — read filter: documents without a `departments`
  relation are company-wide, otherwise only the owning departments see them
  (admins/editors always pass)
- `quick-link-visibility` — same `departments`-relation scheme as documents
- `notification-visibility` — reads restricted to the caller's own rows
  (recipient = caller)
- `poll-vote-visibility` — reads restricted to the caller's own votes
  (protects anonymous polls from `voter` populates; aggregates come from the
  `results` route)
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
`$in: []`, which would fail **open**). `visible-ids.ts` (`loadUserScope`,
`visibleWikiSpaceIds`) resolves per-user wiki-space visibility,
`target-visibility.ts` (`visibleTargetAnchors`, `isTargetVisible`) decides
comment/reaction target visibility for #28, and
`wiki-edit-context.ts` carries the authenticated editor from the wiki-page
controller into the revision-snapshot lifecycle via `AsyncLocalStorage`, so
revisions record who actually edited.

### Role flow: Entra ID → Strapi → frontend

A user's role is resolved once, at sign-in, and then propagated through the stack:

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Microsoft Entra ID (Azure AD)                               │
│     User signs in → Graph /me + /me/memberOf returns groups     │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. Strapi users-permissions Microsoft callback                 │
│     extensions/users-permissions/strapi-server.ts               │
│     resolveRoleType(groups) applies rules from                  │
│     config/ms-role-map.ts → user.role written to the DB         │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼ Strapi JWT issued
┌─────────────────────────────────────────────────────────────────┐
│  3. Next.js Auth.js jwt callback (web/src/auth.ts)              │
│     exchangeForStrapiJwt(msAccessToken)                         │
│     → session.user.role = strapi.user.role.type                 │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼ session.user.role (string)
┌─────────────────────────────────────────────────────────────────┐
│  4. Frontend UI gating                                          │
│     isAdmin(session.user.role) → show/hide Admin link + page    │
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

`guest` has no group mapping — only an admin can assign it in Strapi.
`authenticated` is the users-permissions plugin's built-in fallback role
and only applies if the Microsoft callback fails to remap the user;
its permissions mirror `member`-level read access so the dashboard still
works in that degraded state.

**Strapi role capabilities** (REST API permissions seeded by
`PERMISSION_MATRIX` in `apps/cms/src/index.ts`, further gated by the policies
above; `R` = find + findOne, `C` = create, `U` = update, `D` = delete):

| Role | Announcements | Acks · RSVPs | Depts / Teams | Docs · Events · Polls | Classifieds | Quick-links | Wiki spaces · pages · revisions | Comments · Reactions | Kudos · Poll-votes | Notifications | Courses · Lessons / Progress | Search-log |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `admin_role` | CRUD | CRUD | CRUD / CRUD | CRUD | CRUD | CRUD | CRUD | CRUD | CRUD | CRUD | R / CRUD | C |
| `editor` | CRUD | R+C · R+C+U | R / R | CRUD | CRUD | CRUD | CRUD | CRUD | CRUD | CRUD | R / R+C | C |
| `department_head` | R | R+C · R+C+U | R+U / R+U | R | CRUD | R | R · R+C+U · R | R+C+D | R+C | R+D | R / R+C | C |
| `team_lead` | R | R+C · R+C+U | R / R+U | R | CRUD | R | R · R+C+U · R | R+C+D | R+C | R+D | R / R+C | C |
| `member` | R | R+C · R+C+U | R / R | R | CRUD | R | R · R+U · R | R+C+D | R+C | R+D | R / R+C | C |
| `guest` | — | — · — | — / — | R | — | R | R · R · — | R | — · R | R | — / — | C |
| `authenticated` *(fallback)* | R | R+C · R+C+U | R / R | R | R | R | R | R+C | R+C | R | R / R+C | C |

Fine print encoded in the matrix (and enforced by the policies/controllers):
acknowledgements are **immutable read receipts** — only `admin_role` may
update/delete them; RSVP `delete` is admin-only across all roles (removing
someone else's RSVP is an admin correction) and `update` is ownership-gated;
classified `CRUD` for non-admins is ownership-gated by `is-classified-author`;
course/lesson content-api **write routes do not exist at all** (`only:
["find", "findOne"]` routers — authoring happens in the Strapi admin) and
lesson-progress receipts are immutable (update/delete admin-only);
`search-log` is write-only telemetry — nobody lists raw rows, aggregates come
from the admin-only `summary` route.
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
read that populates a user relation (and the notification/poll-vote
visibility filters) into a 400, because Strapi's core controllers run
`validateQuery` → `throwRestrictedRelations` *before* the sanitize pass.
That guest can consequently still read directory fields is a documented
**open issue** — see the `OPEN ISSUE` note on the `guest` matrix in
`src/index.ts`. Custom (non-CRUD) route actions (ICS export, celebrations
and poll `vote` — both minus `guest` —, mark-read/mark-all-read, poll
`results`, `/api/me`, `changePassword`, `role.find` for the admin ack
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
- **Max 4 files per request, 5 MB per file** (with an `fs.stat` fallback when
  the reported size is missing — never waved through).
- **Strict image allowlist verified by magic bytes** of the temp file, not
  the client-declared mimetype: JPEG/PNG/WebP only. **No SVG** (stored-XSS
  vector) and no GIF (decompression-bomb surface) on purpose.
- **Uploader attribution** — every stored file is stamped with the caller's
  user id in `provider_metadata.uploadedBy`; the classified controller only
  accepts image ids whose `uploadedBy` matches the caller (admin/editor
  bypass), so nobody can attach foreign media — avatars, documents, other
  people's photos — to their own ad.

The grant itself (`plugin::upload.content-api.upload`) is only handed to
`member`/`team_lead`/`department_head`/`editor`/`admin_role` — never `guest`
or the `authenticated` fallback — and there are deliberately no
`find`/`findOne`/`destroy` grants on the upload content-API (no browsing or
deleting the media library from outside the admin panel).

**The frontend has no roles of its own.** `apps/web/src/lib/roles.ts` is
a single helper:

```ts
export const ADMIN_ROLES = new Set(["admin_role"]);
export function isAdmin(role) { return role ? ADMIN_ROLES.has(role) : false; }
```

Used in a handful of places: the sidebar (hide/show the *Admin* link), the
`/manage`, `/manage/acknowledgements`, `/manage/analytics` and
`/manage/training` pages (all redirect non-admins to `/`), and the marketplace detail/edit pages (show the
moderation controls for admin/editor alongside the ad owner). Note the admin
area lives under **`/manage`** — `/admin` is reserved
for the Strapi admin panel by the reverse proxy. Every other authorization
decision is made server-side by Strapi's permission matrix + route
policies — the frontend just mirrors the role string.

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
# fill in DOMAIN, secrets, MS_* values
docker compose up -d --build
```

Caddy obtains a Let's Encrypt certificate for `$DOMAIN`, proxies `/api/*`,
`/admin*`, `/uploads/*` and related paths to Strapi, and everything else to
Next.js. Point your DNS A/AAAA record at the host and the stack is live.

### Live production (srv-prod-01, Traefik)

The hosted instance at <https://sinnlos.yurtbay.dev> runs the **same stack
behind the host's shared Traefik** instead of Caddy. A second compose file
(`docker-compose.traefik.yml`) disables the bundled Caddy and attaches `web` +
`cms` to the external `frontend` Docker network with Traefik routing labels:

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
  up -d --build          # compose project name must stay 'infra'
```

`infra/deploy.sh` wraps this end to end: pre-deploy DB backup → tag the running
images `:rollback` → rebuild + restart → curl smoke-check. TLS, the security
response headers, and the admin/auth rate limits all live at the Traefik layer
(see the override labels). The web and cms containers run **non-root** with
`no-new-privileges`. Full details — backup/restore, rollback, hardening — are in
**[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)**.

## 7. Useful scripts

```bash
pnpm dev               # run every workspace in parallel
pnpm build             # build every workspace
pnpm typecheck         # tsc --noEmit everywhere
pnpm test              # vitest unit tests (also run in CI)
pnpm cms:dev           # just Strapi
pnpm web:dev           # just Next.js
infra/live-smoke.sh    # prove the SSE live pipeline end to end (comment → ping frame)
```

## 8. Verification checklist

- [ ] `pnpm install` completes cleanly
- [ ] Strapi admin loads at `:1337/admin`, first admin created
- [ ] Six roles visible under *Settings → Users & Permissions → Roles*
- [ ] Create a department, a team, a wiki space + page via the admin
- [ ] Next.js dashboard at `:3000` shows stat cards and empty states
- [ ] "Sign in with Microsoft" completes and returns to the dashboard with
      your display name in the topbar
- [ ] Editing a wiki page as a non-author member is blocked (403)
- [ ] A member of the owning department can edit wiki pages for that department
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
