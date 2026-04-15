# Sinnlos Intranet

A self-hosted company intranet with **Microsoft Entra ID (Azure AD)** single sign-on,
a **wiki**, **team pages**, and **department pages**, all gated by **user roles**.

- **Backend** — Strapi v5 (Postgres) at `apps/cms`
- **Frontend** — Next.js 15 + TailwindCSS + shadcn/ui at `apps/web`
- **Auth** — Auth.js (NextAuth v5) Microsoft Entra ID provider → Strapi
  users-permissions Microsoft provider → Strapi JWT
- **Deployment** — Docker Compose + Caddy (automatic TLS) in `infra/`

**→ [Full deployment guide](./docs/DEPLOYMENT.md)** — bare-metal, Docker, VPS, Azure VM, Azure Container Apps.

## Repository layout

```
.
├── apps/
│   ├── cms/                Strapi v5 backend
│   └── web/                Next.js 15 frontend
├── infra/
│   ├── docker-compose.yml
│   ├── Caddyfile
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

Strapi content types (all draft+publish):

| Type | Purpose |
| --- | --- |
| **department** | Top-level org unit with head, members, teams, pages |
| **team** | Belongs to a department, has a lead and members |
| **wiki-space** | Namespace for wiki pages with scoped visibility |
| **wiki-page** | Markdown body, tags, parent/children, author, revisions |
| **wiki-revision** | Auto-captured snapshot of a page before each update |
| **announcement** | Dashboard news items, scoped by role / department / team |

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

## 6. Production deployment (Docker Compose + Caddy)

```bash
cd infra
cp .env.example .env
# fill in DOMAIN, secrets, MS_* values
docker compose up -d --build
```

Caddy automatically obtains a Let's Encrypt certificate for `$DOMAIN`, proxies
`/api/*`, `/admin*`, `/uploads/*` and related paths to Strapi, and everything
else to Next.js.

Point your DNS A/AAAA record for `intranet.example.com` at the host and the
stack is live.

## 7. Useful scripts

```bash
pnpm dev               # run every workspace in parallel
pnpm build             # build every workspace
pnpm typecheck         # tsc --noEmit everywhere
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
- [ ] `docker compose up -d` brings the full stack up behind Caddy
