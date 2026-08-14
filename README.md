# Sinnlos Intranet

A self-hosted company intranet with **Microsoft Entra ID (Azure AD)** single sign-on,
all gated by **user roles**: announcements with **comments & reactions**, a
**wiki** with revision history, **department/team pages**, a **people directory
+ org chart**, **events with ICS export**, **polls**, **kudos**, a **document
library**, **notifications**, **global search (⌘K)** and an **English/German
UI** (see [Internationalization](#internationalization-i18n)).

- **Backend** — Strapi v5 (Postgres) at `apps/cms`
- **Frontend** — Next.js 16 + TailwindCSS + shadcn/ui at `apps/web`
- **Auth** — Auth.js (NextAuth v5) Microsoft Entra ID provider → Strapi
  users-permissions Microsoft provider → Strapi JWT
- **Deployment** — Docker Compose in `infra/`. Local full-stack runs use the
  bundled **Caddy** (automatic TLS); the live production host (srv-prod-01)
  fronts the same compose stack with **Traefik** via a second override file.

**→ [Full deployment guide](./docs/DEPLOYMENT.md)** — bare-metal, Docker, VPS (Traefik), Azure VM, Azure Container Apps.

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
4. Create users in the Strapi admin under **Content Manager → User**
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

Strapi ships 14 collection types plus one routes-only API
(`apps/cms/src/api/`):

| Type | Purpose |
| --- | --- |
| **department** | Top-level org unit with head, members, teams, pages |
| **team** | Belongs to a department, has a lead and members |
| **announcement** | Dashboard news items, targeted via `audience` / `audienceRoles` / departments |
| **comment** | Comments on announcements and wiki pages (`targetType` + `targetId`, no FK) |
| **reaction** | Emoji reactions, same polymorphic `targetType`/`targetId` scheme |
| **kudos** | Peer recognition (`from` → `to` user, message, company value) |
| **notification** | Per-user notification rows (recipient, actor, link), fan-out via lifecycles |
| **event** | Calendar events, department-scoped, ICS export via custom route |
| **poll** | Question + options, `closesAt`, `anonymous` flag, department targeting |
| **poll-vote** | One vote per user per poll, cast via custom `vote`/`results` routes |
| **document** | File library entry; `departments` m2m — no relation = company-wide |
| **wiki-space** | Namespace for wiki pages with scoped visibility |
| **wiki-page** | Markdown body, tags, parent/children, author, revisions |
| **wiki-revision** | Auto-captured snapshot of a page before each update |
| *profile* | Routes-only API (no schema): `GET`/`PUT /api/me` self-service profile |

The users-permissions **User** is extended with `department`, `teams`,
`manager` (self-relation, drives the org chart) and `microsoftOid`.

Six roles are created automatically on Strapi boot (see
[`apps/cms/src/index.ts`](./apps/cms/src/index.ts)):
`admin_role`, `editor`, `department_head`, `team_lead`, `member`, `guest`.
The same bootstrap grants each role sensible default REST permissions on
every intranet content type (reads for everyone, writes scoped per role).
Writes are then further gated by the route-level policies listed below.

Policies at `apps/cms/src/policies/` enforce scoped access:

- `is-admin-or-editor` — global write guard
- `is-department-head` — department update requires matching department
- `is-team-member-or-lead` — team update requires membership/lead
- `can-edit-wiki` — wiki page write gated by author / department head / team lead
- `wiki-visibility` — read filter based on `space.visibility` (public / role /
  department / team)
- `document-visibility` — read filter: documents without a `departments`
  relation are company-wide, otherwise only the owning departments see them
  (admins/editors always pass)

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

| Role | Announcements | Depts / Teams | Docs · Events · Polls | Wiki spaces · pages · revisions | Comments · Reactions | Kudos · Poll-votes | Notifications |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `admin_role` | CRUD | CRUD / CRUD | CRUD | CRUD | CRUD | CRUD | CRUD |
| `editor` | CRUD | R / R | CRUD | CRUD | CRUD | CRUD | CRUD |
| `department_head` | R | R+U / R+U | R | R · R+C+U · R | R+C+D | R+C | R+D |
| `team_lead` | R | R / R+U | R | R · R+C+U · R | R+C+D | R+C | R+D |
| `member` | R | R / R | R | R · R+U · R | R+C+D | R+C | R+D |
| `guest` | — | — / — | R | R · R · — | R | — · R | R |
| `authenticated` *(fallback)* | R | R / R | R | R | R+C | R+C | R |

Every role in the matrix **except `guest`** additionally gets
`user.find`/`findOne` (so populated relations like author/lead/head survive) —
this also powers the people directory. `guest` is deliberately excluded (see
`USER_READ_EXCLUDED_ROLES`): `user` reads would expose the whole employee
directory (email, phone, hire date) to a read-only visitor, so populated user
relations are simply stripped from guest responses. Custom (non-CRUD) route
actions (ICS export, celebrations,
mark-read, poll `vote`/`results`, `/api/me`, `changePassword`) are seeded via
`CUSTOM_ACTION_GRANTS` in the same file.

**The frontend has no roles of its own.** `apps/web/src/lib/roles.ts` is
a single helper:

```ts
export const ADMIN_ROLES = new Set(["admin_role"]);
export function isAdmin(role) { return role ? ADMIN_ROLES.has(role) : false; }
```

Used in exactly three places: the sidebar (hide/show the *Admin* link), the
`/manage` page and the `/manage/analytics` page (both redirect non-admins
to `/`). Note the admin area lives under **`/manage`** — `/admin` is reserved
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
