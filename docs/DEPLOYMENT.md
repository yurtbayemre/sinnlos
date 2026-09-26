# Deployment Guide

This guide walks through every supported deployment method for **Sinnlos Intranet**
(Next.js 16 frontend + Strapi v5 CMS).

| Method | Best for |
|---|---|
| [Bare-metal local](#1-bare-metal-local-development) | Day-to-day development, quick feature testing |
| [Docker local](#2-docker-local-full-stack) | Full-stack smoke tests before deploying |
| [VPS (any provider)](#3-vps-deployment) | Self-hosted production on any Linux VM |
| [Azure (VM)](#4-azure-vm-deployment) | Production on Azure using the same Docker Compose approach |
| [Azure (Container Apps)](#5-azure-container-apps-advanced) | Cloud-native, autoscaling, no VM management |

> **Reverse proxy:** the base compose stack bundles **Caddy** (auto-TLS) so a
> stock VPS works with one command. The live production host (srv-prod-01)
> instead fronts the same stack with the box's shared **Traefik** via the
> `docker-compose.traefik.yml` override — see [§3.6](#36-deploy). Pick one; they
> are mutually exclusive.

After deploying, run the [post-deployment verification](#post-deployment-verification)
and set up [backup & restore](#backup--restore) for any production environment.

All methods share the same [prerequisites](#prerequisites) and
[Microsoft Entra ID setup](#microsoft-entra-id-app-registration) — do those first
(the Entra setup is only needed for Microsoft sign-in, which this release
cannot offer; see the note there).

> **Upgrading an existing instance?** Work through
> [Upgrading an existing instance to this release](#upgrading-an-existing-instance-to-this-release)
> before you deploy: this release introduces the
> [datetime contract](#310-datetime-contract): the cms runs in UTC, every
> stored instant becomes `timestamptz`, and the **first boot repairs the times
> the old cms stored**, once. An existing database needs
> `DATETIME_LEGACY_ZONE` (and on some instances `DATETIME_LEGACY_UTC_UNTIL`) in
> `infra/.env`; the new cms refuses to start without it, and `infra/deploy.sh`
> refuses to deploy. Coming from a release before 2026-09-26, also work through
> the older notes, newest first:
> [One-time: org draft/publish off](#one-time-org-draftpublish-off) (a
> database with department or team drafts needs a one-time migration first),
> [Upgrading to the Strapi 5.55.1 release (2026-09-25)](#upgrading-to-the-strapi-5551-release-2026-09-25)
> (additive database changes; **Microsoft sign-in stops working**, so an
> instance that uses it must stay on its current release) and
> [Upgrading from a release before 2026-09-24](#upgrading-from-a-release-before-2026-09-24)
> (stricter env contract, one `JWT_SECRET` rotation).

---

## Prerequisites

Install these on any machine you are deploying **from**:

| Tool | Minimum version | Install |
|---|---|---|
| Node.js | 22.13+ or 24 LTS *(root `engines`: `^22.13.0 \|\| ^24.0.0`; CI and the images use 24; Node 20 is EOL — do not use)* | [nodejs.org](https://nodejs.org) |
| pnpm | 9.x | `corepack enable && corepack prepare pnpm@9.12.0 --activate` |
| Git | any recent | system package manager |
| openssl | any recent | preinstalled on macOS/Linux; on Windows use Git Bash or WSL |
| curl | any recent | preinstalled on macOS/Linux |
| Docker + Docker Compose | Docker 24 / Compose v2 | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Mac/Win) or [Docker Engine](https://docs.docker.com/engine/install/) (Linux) |
| Azure CLI *(Azure only)* | 2.60 | [learn.microsoft.com/cli/azure/install](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) |

Check versions:

```bash
node -v          # v22.13.0 or later on the 22 line, or v24.x.x
pnpm -v          # 9.x.x
docker -v        # Docker version 24.x.x
docker compose version  # Docker Compose version v2.x.x
openssl version  # OpenSSL 3.x.x
```

> **Windows users:** Use **WSL2** with Ubuntu 24.04 for the smoothest experience.
> Everything in this guide assumes a bash-like shell. PowerShell works for bare-metal
> dev but the heredoc and `openssl rand` snippets won't run as-is.

---

## Microsoft Entra ID App Registration

Sinnlos uses **Microsoft Entra ID (formerly Azure AD)** for SSO. You need one
app registration and you'll reference it in every deployment method.

> **Microsoft sign-in is unavailable in this release.** Strapi's
> users-permissions 5.51+ (this release runs Strapi 5.55.1) completes
> `/api/auth/:provider/callback` only from its own OAuth session, so it
> answers the web's server-side access-token exchange with a 400 and every
> Microsoft sign-in fails. Until the planned Entra exchange ships, leave every
> `MS_*` / `AUTH_MICROSOFT_*` value empty and use local e-mail + password
> sign-in ([README → standalone mode](../README.md#running-without-microsoft-standalone-mode)).
> With a real app registration configured, the web logs an `[auth]` error at
> boot and `infra/deploy.sh` refuses to deploy (see
> [Upgrading to the Strapi 5.55.1 release (2026-09-25)](#upgrading-to-the-strapi-5551-release-2026-09-25)).
> The steps below stay for reference.

### Step 1 — Create the app registration

1. Open [portal.azure.com](https://portal.azure.com) → search **App registrations** → **New registration**.
2. **Name**: `Sinnlos Intranet` (or any name you prefer).
3. **Supported account types**: *Accounts in this organizational directory only* (single-tenant).
   - Choose **single-tenant** for a company intranet so only your org's users can sign in.
   - Choose **multi-tenant** only if you want any Microsoft work/school account to sign in.
4. Leave Redirect URI blank for now → **Register**.

### Step 2 — Copy the IDs

On the app overview page, copy:

- **Application (client) ID** → this is `MS_CLIENT_ID`
- **Directory (tenant) ID** → this is `MS_TENANT_ID`

> **MS_TENANT_ID tip:** Use the actual tenant GUID (not `common` or `organizations`)
> for a single-tenant company intranet. Using `common` would let any MS account
> in the world attempt to sign in — Strapi would still reject unauthorized users,
> but it's cleaner to scope the token issuer to your tenant at the OIDC layer.

### Step 3 — Create a client secret

**Certificates & secrets** → **New client secret** → set an expiry → **Add**.
Copy the **Value** immediately (it is shown only once) → this is `MS_CLIENT_SECRET`.

### Step 4 — API permissions

**API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated**:

| Permission | Why |
|---|---|
| `openid` | Basic OIDC login |
| `profile` | Read display name and photo |
| `email` | Read email address |
| `User.Read` | Pull job title and department from Graph `/me` |
| `GroupMember.Read.All` | Map Entra groups → intranet roles |

Click **Grant admin consent for \<tenant\>** → **Yes**.

### Step 5 — Redirect URIs

**Authentication** → **Add a platform** → **Web** — add all URIs you'll use:

| Deployment | Next.js (Auth.js) | Strapi |
|---|---|---|
| Local bare-metal | `http://localhost:3000/api/auth/callback/microsoft-entra-id` | `http://localhost:1337/api/connect/microsoft/callback` |
| Local Docker | `http://localhost:3000/api/auth/callback/microsoft-entra-id` | `http://localhost/api/connect/microsoft/callback` |
| VPS / Azure VM | `https://intranet.example.com/api/auth/callback/microsoft-entra-id` | `https://intranet.example.com/api/connect/microsoft/callback` |

You can add all of them up front so a single registration covers every environment.

The Strapi column (`/api/connect/microsoft/callback`) is not used by the
current sign-in flow: the web exchanges the Entra access token server-side at
`/api/auth/microsoft/callback` and never sends the browser through Strapi's
own OAuth redirect. Registering it is harmless.

---

## 1. Bare-Metal Local Development

Run Strapi and Next.js directly with Node — no Docker required.
Best for active development.

### 1.1 Clone and install

```bash
git clone https://github.com/yurtbayemre/sinnlos.git
cd sinnlos
pnpm install
```

### 1.2 Create environment files

```bash
cp apps/cms/.env.example   apps/cms/.env
cp apps/web/.env.example   apps/web/.env.local
```

**`apps/cms/.env`** — fill in. The `.env.example` defaults to **SQLite** — the
intended zero-config standalone setup (no external database needed). Keep it
for local dev; production/Docker switches to Postgres (see the tip below):

```dotenv
# SQLite is the .env.example default — zero-config, file-based
DATABASE_CLIENT=sqlite
DATABASE_FILENAME=.tmp/data.db

APP_KEYS=key1,key2            # two random strings, comma-separated
API_TOKEN_SALT=               # openssl rand -base64 32
ADMIN_JWT_SECRET=             # openssl rand -base64 32
TRANSFER_TOKEN_SALT=          # openssl rand -base64 32
JWT_SECRET=                   # openssl rand -base64 32
ENCRYPTION_KEY=               # openssl rand -base64 32

PUBLIC_URL=http://localhost:1337

# Microsoft sign-in cannot complete on this release (Strapi 5.51+, see the
# Entra section above): leave these empty and use local sign-in.
MS_CLIENT_ID=<your-client-id>
MS_CLIENT_SECRET=<your-client-secret>
MS_TENANT_ID=<your-tenant-id>

# Optional locally — authenticates the live-event pings the cms sends to
# Next.js (POST /api/live/emit, see "Live-event ingest" below). Must match
# REVALIDATE_SECRET in apps/web/.env.local; the name is historical (there
# is no cache webhook any more). Leave both unset and live updates fall
# back to polling.
REVALIDATE_SECRET=<openssl rand -hex 32>
WEB_INTERNAL_URL=http://localhost:3000

# Optional outside production — the /uploads gate is a no-op in dev when
# unset. In production it is required on cms AND web (same value).
INTERNAL_UPLOAD_TOKEN=<openssl rand -hex 32>

# Optional — seed the first Strapi super-admin on an empty database.
# Refused (error log, no admin) for placeholders and passwords failing the
# admin policy (8+ chars, upper, lower, digit). Leave empty to register
# the first admin at /admin.
STRAPI_ADMIN_EMAIL=
STRAPI_ADMIN_PASSWORD=
```

> **Placeholder guard:** the `toBeModified` values in `apps/cms/.env.example`
> only produce a warning in development. With `NODE_ENV=production` the cms
> refuses to start while any Strapi secret, `REVALIDATE_SECRET` or
> `INTERNAL_UPLOAD_TOKEN` still holds a template placeholder (`change-me…`,
> `toBeModified…`, `<secret>`).

> **Keep the dev server off the network.** `apps/cms/.env.example` sets
> `HOST=0.0.0.0`, so `pnpm cms:dev` (`strapi develop`) listens on every
> interface, and in develop mode Strapi serves its admin panel through the
> Vite dev server on that same port. Strapi 5.55.1 (like 5.49 before it)
> pins Vite 5.4.21, which has open advisories for its dev server
> (GHSA-fx2h-pf6j-xcff, GHSA-v6wh-96g9-6wx3, GHSA-4w7w-66w2-5vf9; see
> [architecture.md §7b P1.7](./architecture.md)). On a machine in a shared
> network, especially on Windows, set `HOST=127.0.0.1` in `apps/cms/.env`;
> the `localhost` URLs above keep working. Production (`strapi start`, the
> Docker image) does not load Vite. The root test tooling (vitest 4) uses its
> own Vite 7.3.6, which has no known advisories.

> **Prefer Postgres locally?** Run one with Docker in a single command, set
> `DATABASE_CLIENT=postgres` and uncomment the Postgres block in `apps/cms/.env`:
> ```bash
> docker run -d --name sinnlos-pg \
>   -e POSTGRES_DB=sinnlos -e POSTGRES_USER=sinnlos -e POSTGRES_PASSWORD=sinnlos \
>   -p 5432:5432 -v sinnlos-pgdata:/var/lib/postgresql/data \
>   postgres:16-alpine
> ```
> Then set `DATABASE_HOST=localhost` in `apps/cms/.env`.

Generate secrets quickly:

```bash
for i in APP_KEYS API_TOKEN_SALT ADMIN_JWT_SECRET TRANSFER_TOKEN_SALT JWT_SECRET ENCRYPTION_KEY; do
  echo "$i=$(openssl rand -base64 32)"
done
```

**`apps/web/.env.local`** — fill in:

```dotenv
STRAPI_URL=http://localhost:1337
STRAPI_PUBLIC_URL=http://localhost:1337
AUTH_SECRET=<openssl rand -base64 32>
# Its scheme also names the session cookie (https → __Secure-authjs.session-token);
# the server-side Strapi token reader derives the name the same way.
AUTH_URL=http://localhost:3000
AUTH_TRUST_HOST=true
# Leave the three Entra values empty on this release (Microsoft sign-in
# cannot complete on Strapi 5.51+); local sign-in then switches on by itself.
AUTH_MICROSOFT_ENTRA_ID_ID=<your-client-id>
AUTH_MICROSOFT_ENTRA_ID_SECRET=<your-client-secret>
AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/<your-tenant-id>/v2.0

# Must match REVALIDATE_SECRET in apps/cms/.env (or leave both unset
# to disable the live-event pings locally).
REVALIDATE_SECRET=<same-value-as-cms>

# Must match INTERNAL_UPLOAD_TOKEN in apps/cms/.env when set there.
INTERNAL_UPLOAD_TOKEN=<same-value-as-cms>
```

### 1.3 Start the servers

Open **two terminals**:

```bash
# Terminal 1 — Strapi CMS
pnpm --filter @sinnlos/cms dev
# Wait for: [2024-xx-xx] info: Strapi is listening on: http://localhost:1337
```

```bash
# Terminal 2 — Next.js
pnpm --filter @sinnlos/web dev
# Wait for: ✓ Ready in ...ms
```

Or both at once (output interleaved):

```bash
pnpm dev
```

> **Built code from a checkout.** `pnpm --filter @sinnlos/cms build` deletes
> `apps/cms/dist` before it runs `strapi build`. Strapi's build never cleans
> `dist` (only `strapi develop` does), and `strapi start` loads every compiled
> file there, so without this a later `strapi start` from the same checkout
> kept loading code whose source had been removed. No manual `rm -rf dist` is
> needed any more. Do not run the cms build while `strapi start` serves from
> the same checkout: `dist` disappears at the start of the build. The Docker
> build starts from a fresh tree and is unaffected.

### 1.4 First-time Strapi setup

1. Open **http://localhost:1337/admin** → create your first admin account.
2. The bootstrap script automatically creates the six roles (`admin_role`, `editor`,
   `department_head`, `team_lead`, `member`, `guest`). Verify them under
   *Settings → Users & Permissions → Roles*.

### 1.5 Verify login

1. Open **http://localhost:3000** → you are redirected to `/sign-in`.
2. Sign in with e-mail + password. Create the account first in the Strapi
   admin (**Content Manager → User**: e-mail, password, confirmed = true), or
   boot once with `SEED_DEMO_DATA=1` for demo users. Microsoft sign-in cannot
   complete on this release (see the
   [Entra section](#microsoft-entra-id-app-registration)).
3. You land on the dashboard with your name in the top-right corner.

### 1.6 Demo mode (no Microsoft account needed)

```bash
DEMO_MODE=1 pnpm --filter @sinnlos/web dev
```

Bypasses auth and Strapi entirely. Uses the in-memory fixture dataset in
`apps/web/src/lib/demo.ts`. Useful for UI tweaking without network setup.

---

## 2. Docker Local (Full Stack)

Runs Postgres + Strapi + Next.js + Caddy in containers — the same app images as
production, fronted by the bundled Caddy (live prod swaps Caddy for Traefik; see
[§3.6](#36-deploy)). Requires Docker Desktop (Mac/Windows) or Docker Engine (Linux).

### 2.1 Clone and prepare env

```bash
git clone https://github.com/yurtbayemre/sinnlos.git
cd sinnlos/infra
cp .env.example .env
```

Edit `infra/.env`:

```dotenv
DOMAIN=localhost

WEB_PUBLIC_URL=http://localhost
CMS_PUBLIC_URL=http://localhost

# --- Required: compose refuses to start while any of these is empty ---
DATABASE_PASSWORD=<strong-random-password>

APP_KEYS=<openssl rand -base64 32>,<openssl rand -base64 32>
API_TOKEN_SALT=<openssl rand -base64 32>
ADMIN_JWT_SECRET=<openssl rand -base64 32>
TRANSFER_TOKEN_SALT=<openssl rand -base64 32>
JWT_SECRET=<openssl rand -base64 32>
ENCRYPTION_KEY=<openssl rand -base64 32>
AUTH_SECRET=<openssl rand -base64 32>

# Shared secret for the internal Strapi → Next.js live-event pings
# (POST /api/live/emit — its only use; the name is historical). Both
# services read it.
REVALIDATE_SECRET=<openssl rand -hex 32>

# Shared secret the web's session-gated /uploads proxy presents to the cms.
# Without it every uploaded file answers 404 (fail closed).
INTERNAL_UPLOAD_TOKEN=<openssl rand -hex 32>

# Microsoft sign-in: leave empty on this release (it cannot complete on
# Strapi 5.51+); both apps then offer local sign-in.
MS_TENANT_ID=<your-tenant-id>
MS_CLIENT_ID=<your-client-id>
MS_CLIENT_SECRET=<your-client-secret>

# --- Optional features (safe to leave unset) --------------------------
# First Strapi super-admin on an empty database (else: register at /admin).
# Refused for placeholders and passwords failing the admin policy
# (8+ chars, upper, lower, digit).
STRAPI_ADMIN_EMAIL=
STRAPI_ADMIN_PASSWORD=

# Live updates (SSE, issue #17/#27): set to 1 to revert the app to the
# pre-SSE polling behaviour entirely (kill switch / rollback lever).
LIVE_EVENTS_DISABLED=0

# E-mail digests (issue #18): authenticated SMTP submission. Without
# SMTP_HOST/USER/PASS the digest cron is a logged no-op ("ships dark").
# Use a mailbox app password (SMTP-only) — never a login password.
# With SMTP set, DIGEST_FROM is required (otherwise every run is skipped
# with an error log, and infra/deploy.sh refuses to deploy). Links use
# PUBLIC_WEB_URL, default WEB_PUBLIC_URL.
SMTP_HOST=<mail.example.com>
SMTP_PORT=587
SMTP_USER=<noreply@example.com>
SMTP_PASS=<mailbox-app-password>
DIGEST_FROM=Intranet <noreply@example.com>
DIGEST_REPLY_TO=
DIGESTS_DISABLED=0
```

> The `<…>` values above are stand-ins: with `NODE_ENV=production` (as in
> compose) the cms refuses to start while a Strapi secret, `REVALIDATE_SECRET`
> or `INTERNAL_UPLOAD_TOKEN` still holds `<…>`, `change-me…` or
> `toBeModified…`.

> **Tip:** For localhost, Caddy runs without HTTPS (no domain ownership proof
> needed). Redirect URIs in Entra should use `http://localhost/...`.

> **Time zone:** set `APP_TIME_ZONE` in `.env` if your company is not in
> `Europe/Berlin` (the default). It is the zone of every business date: "today",
> ad expiry, birthdays, digest days, the cron times, all-day events and poll
> deadlines. Do not set the containers' `TZ`: compose runs the cms in UTC
> (required, see the [datetime contract](#310-datetime-contract)) and the web
> in `APP_TIME_ZONE` until its own datetime port.

### 2.2 Build and start

```bash
# From the infra/ directory
docker compose up -d --build
```

First build takes 3–5 minutes (downloading base images + compiling both apps).

Watch logs:

```bash
docker compose logs -f
```

Wait until you see:

```
cms  | [info] Strapi is listening on: http://0.0.0.0:1337
web  | Listening on port 3000
```

### 2.3 Strapi first-time setup

```
http://localhost/admin    ← proxied through Caddy
```

Create the admin account. The six roles are bootstrapped automatically.

### 2.4 Verify the stack

```
http://localhost          ← Next.js (via Caddy)
http://localhost/admin    ← Strapi admin panel
```

### 2.5 Useful commands

```bash
docker compose stop                  # stop without removing containers
docker compose down                  # stop + remove containers (data preserved)
docker compose down -v               # ⚠ also deletes Postgres data volume
docker compose up -d --build web     # rebuild only the Next.js container
docker compose exec db psql -U sinnlos sinnlos   # Postgres shell
```

---

## 3. VPS Deployment

Works on any Linux VPS (Hetzner, DigitalOcean, Linode, OVH, etc.).
The setup is identical to Docker local — you just add a real domain and DNS.

### 3.1 Provision the server

Minimum specs: **2 vCPU / 4 GB RAM / 20 GB SSD**.
Recommended OS: **Ubuntu 24.04 LTS**.

### 3.2 Install Docker

```bash
# Connect as root or a sudo user
ssh root@<your-vps-ip>

# Install Docker (official script)
curl -fsSL https://get.docker.com | sh

# Add your user to the docker group (if not root)
usermod -aG docker $USER
newgrp docker

# Verify
docker -v
docker compose version
```

### 3.3 Open firewall ports

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

### 3.4 Point DNS

In your domain registrar / DNS provider add:

```
A    intranet.example.com    <vps-ip>
```

Wait for propagation (usually < 5 min). Verify:

```bash
dig +short intranet.example.com
```

### 3.5 Clone the repo and configure

```bash
git clone https://github.com/yurtbayemre/sinnlos.git /opt/sinnlos
cd /opt/sinnlos/infra
cp .env.example .env
```

Edit `/opt/sinnlos/infra/.env`:

```dotenv
DOMAIN=intranet.example.com
WEB_PUBLIC_URL=https://intranet.example.com
CMS_PUBLIC_URL=https://intranet.example.com

# --- Required: compose refuses to start while any of these is empty ---
DATABASE_PASSWORD=<strong-random-password>

# openssl rand -base64 32 each (APP_KEYS: two, comma-separated)
APP_KEYS=<secret>,<secret>
API_TOKEN_SALT=<secret>
ADMIN_JWT_SECRET=<secret>
TRANSFER_TOKEN_SALT=<secret>
JWT_SECRET=<secret>
ENCRYPTION_KEY=<secret>
AUTH_SECRET=<secret>

# Shared cms <-> web secrets. Generate with: openssl rand -hex 32
# REVALIDATE_SECRET guards only the internal /api/live/emit ingest;
# INTERNAL_UPLOAD_TOKEN lets the web /uploads proxy fetch file bytes
# (without it every uploaded file answers 404).
REVALIDATE_SECRET=<secret>
INTERNAL_UPLOAD_TOKEN=<secret>

# Microsoft sign-in: leave empty on this release. It cannot complete on
# Strapi 5.51+, and infra/deploy.sh refuses a real app registration here.
MS_TENANT_ID=<your-tenant-id>
MS_CLIENT_ID=<your-client-id>
MS_CLIENT_SECRET=<your-client-secret>

# --- Optional features (safe to leave unset) --------------------------
# Business time zone (IANA): "today", expiry, birthdays, digests, cron
# times, all-day events, poll deadlines. Unset/empty = Europe/Berlin.
APP_TIME_ZONE=Europe/Berlin
# Only for a database written by a cms before the datetime contract
# (§3.8, "Upgrading an existing instance to this release"). Empty on a
# fresh install.
DATETIME_LEGACY_ZONE=
DATETIME_LEGACY_UTC_UNTIL=
# First Strapi super-admin on an empty database (else: register at /admin).
# Refused for placeholders and passwords failing the admin policy.
STRAPI_ADMIN_EMAIL=
STRAPI_ADMIN_PASSWORD=
# SSE live updates kill switch (1 = revert to pre-SSE polling entirely).
LIVE_EVENTS_DISABLED=0
# E-mail digests: without SMTP_HOST/USER/PASS the 07:30 digest cron is a
# logged no-op. Use a mailbox app password (SMTP-only). With SMTP set,
# DIGEST_FROM is required (infra/deploy.sh refuses to deploy without it);
# links use PUBLIC_WEB_URL (default WEB_PUBLIC_URL).
SMTP_HOST=<mail.example.com>
SMTP_PORT=587
SMTP_USER=<noreply@example.com>
SMTP_PASS=<mailbox-app-password>
DIGEST_FROM=Intranet <noreply@example.com>
DIGEST_REPLY_TO=
DIGESTS_DISABLED=0
```

> Replace every `<secret>` — the cms refuses to start in production while a
> Strapi secret, `REVALIDATE_SECRET` or `INTERNAL_UPLOAD_TOKEN` still holds a
> template placeholder (`<…>`, `change-me…`, `toBeModified…`).

Update Entra ID redirect URIs (only once Microsoft sign-in is usable again;
the second one is not used by the current flow):

```
https://intranet.example.com/api/auth/callback/microsoft-entra-id
https://intranet.example.com/api/connect/microsoft/callback
```

### 3.6 Deploy

There are two reverse-proxy modes. Use **A** for a stock standalone VPS, or **B**
if the box already runs a shared Traefik (this is how the live
`sinnlos.yurtbay.dev` instance is deployed).

#### A. Bundled Caddy (standalone VPS)

```bash
cd /opt/sinnlos/infra
docker compose up -d --build
```

Caddy automatically requests a **Let's Encrypt TLS certificate** for your domain.
Wait ~30 seconds, then visit **https://intranet.example.com**.

#### B. Shared Traefik (live production layout)

The live host fronts the **same** db/cms/web containers with the host's existing
Traefik instead of the bundled Caddy. The second compose file
`docker-compose.traefik.yml`:

- gives the bundled `caddy` service the `manual` profile so it does **not** start;
- attaches `web` + `cms` to the external `frontend` Docker network (the network
  Traefik watches — it must already exist: `docker network create frontend`);
- adds Traefik router/middleware labels that mirror the Caddyfile routing
  (`/api/auth/*` → web, Strapi paths → cms, everything else → web), terminate TLS
  via the `lehttp` certresolver, and apply the security headers + rate limits
  described in [§3.9](#39-production-hardening).

Deploy with **both** files and the fixed project name `infra` (so container and
image names stay `infra-web-1`, `infra-cms-1`, `infra-db-1` / `infra-web`,
`infra-cms`):

```bash
cd /opt/sinnlos
docker compose -p infra \
  -f infra/docker-compose.yml \
  -f infra/docker-compose.traefik.yml \
  up -d --build
```

In practice you don't run that by hand — use the wrapper:

```bash
infra/deploy.sh
```

`deploy.sh` does, in order: (0) an env preflight that stops before anything is
touched (`infra/deploy.sh --check` runs only this step, see
[§3.8](#upgrading-an-existing-instance-to-this-release)), (1) pre-deploy
Postgres + uploads backup, (2) tags the currently running `infra-web` /
`infra-cms` images as `:rollback`, (3) rebuilds + restarts the stack with the
Traefik override, (4) curl smoke-checks `https://sinnlos.yurtbay.dev`
(override with `SMOKE_URL=`), (5) runs `infra/live-smoke.sh`: first the
[datetime contract](#310-datetime-contract) check (no
`timestamp without time zone` column left, the cms boot log reports the
process zone UTC), then the end-to-end SSE pipeline probe (comment posted via
the cms → ping frame on a subscribed stream). Step 5 **fails the deploy** when
either check fails; it is skipped with `LIVE_EVENTS_DISABLED=1` or when the
demo credentials file is absent (then run `infra/live-smoke.sh` by hand). It
is `set -euo pipefail` and re-run safe.

The preflight fails (naming keys, never values) when:

- a required key in `infra/.env` is empty (`docker compose config` rejects it);
- a secret still holds a template placeholder (`change-me…`, `changeme`,
  `toBeModified…`, `generate-with-openssl…`, `placeholder`, or a `<…>`
  stand-in) in `APP_KEYS`, `API_TOKEN_SALT`, `ADMIN_JWT_SECRET`,
  `TRANSFER_TOKEN_SALT`, `JWT_SECRET`, `ENCRYPTION_KEY`, `REVALIDATE_SECRET`,
  `INTERNAL_UPLOAD_TOKEN` or `AUTH_SECRET` (a placeholder
  `DATABASE_PASSWORD` only warns);
- `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` are set, `DIGESTS_DISABLED` is not `1`,
  and `DIGEST_FROM` or `PUBLIC_WEB_URL` is empty;
- `JWT_SECRET` must be rotated: the running `infra-web-1` lacks the image
  label `org.sinnlos.strapi-jwt=server-only` (i.e. it is a web from before
  2026-09-24 that handed users their Strapi JWT) and the `JWT_SECRET` about to
  be deployed equals the one the running cms uses. A fresh install (no
  running web/cms) skips this check;
- Microsoft sign-in is configured: `MS_CLIENT_ID` and `MS_CLIENT_SECRET` are
  both set and the client id is a GUID (a real app registration). Strapi
  5.51+ rejects the web's access-token exchange, so every Microsoft sign-in
  would fail, and with `AUTH_LOCAL_ENABLED=0` nobody could sign in. A
  non-GUID client id (template text) only warns. The rule goes away with the
  Entra exchange;
- the running database still holds datetime columns in the pre-contract
  format (`timestamp without time zone` outside Strapi's bookkeeping tables)
  and `DATETIME_LEGACY_ZONE` is empty: the new cms would refuse to start
  ([Upgrading an existing instance to this release](#upgrading-an-existing-instance-to-this-release)).
  No running database (a fresh install) skips this check.

`apps/cms/src/utils/deploy-preflight.test.ts` pins the preflight's key lists,
placeholder markers and digest rule to the cms guards (`env-guard.ts`,
`send-digests.ts`), and the Microsoft rule to the web's `MICROSOFT_ENABLED`
and the compose mapping, so the preflight cannot silently drift from what
the apps do at boot.

### 3.7 Enable auto-restart on reboot

Docker containers already have `restart: unless-stopped`. If Docker itself isn't
running on boot:

```bash
systemctl enable docker
systemctl start docker
```

### 3.8 Updates

> **Upgrading to this release (datetime contract)?** Follow
> [Upgrading an existing instance to this release](#upgrading-an-existing-instance-to-this-release)
> first: an existing database needs `DATETIME_LEGACY_ZONE` in `infra/.env`,
> and its first boot repairs the stored times once. Ship it before the DST
> change of **2026-10-25**.
>
> **Upgrading from before 2026-09-25 (Strapi 5.55.1)?** Follow
> [Upgrading to the Strapi 5.55.1 release (2026-09-25)](#upgrading-to-the-strapi-5551-release-2026-09-25)
> as well: take the pre-deploy backup, and do not deploy an instance that
> signs users in with Microsoft. Coming from a release before 2026-09-24,
> also follow [Upgrading from a release before 2026-09-24](#upgrading-from-a-release-before-2026-09-24):
> that deploy needs env changes and one `JWT_SECRET` rotation.
>
> **Deploying the release that turns draft & publish off for departments
> and teams (2026-09-26)?** Run the read-only preflight of
> [One-time: org draft/publish off](#one-time-org-draftpublish-off) first. With
> no department or team drafts it is a normal deploy; otherwise the database
> needs a one-time migration while cms and web are stopped.

On the Traefik host (mode B), pull and re-run the wrapper — it validates
`infra/.env`, backs up and rollback-tags before rebuilding:

```bash
cd /opt/sinnlos
git pull
infra/deploy.sh
```

On a standalone Caddy box (mode A):

```bash
cd /opt/sinnlos
git pull
cd infra
docker compose up -d --build
```

Either way Postgres and existing volumes are untouched. It is not a
zero-downtime restart: compose recreates the changed containers, so the site
is degraded while the new cms boots. For the manual production-safe sequence
(and rollback), see the
[update procedure](#74-update-procedure-production-safe).

#### Upgrading an existing instance to this release

"This release" is phase 1 of the [datetime contract](#310-datetime-contract)
(branch `feat/datetime-phase1`, deep-dive decision 04). It changes how the
cms stores and computes times:

- Every stored instant becomes `timestamptz(6)`. Until now the columns were
  `timestamp without time zone` and held the wall clock of whichever process
  wrote them: UTC before 2026-08-15 (commit `aadb2ea` pinned
  `TZ=Europe/Berlin`), Berlin time after it.
- The cms process runs in **UTC** and so does every database session.
  Business dates ("today", day and week windows, birthdays and anniversaries,
  classified expiry, digest days, the 03:30 / 03:35 / 07:30 cron times, all-day
  events in the ICS export) are computed in the new setting `APP_TIME_ZONE`
  (default `Europe/Berlin`), no longer in the process zone.
- The cms's **first boot repairs the stored values once** (a Strapi user
  migration, before the schema sync) and converts the columns. From then on
  a startup guard keeps every datetime column `timestamptz`, also for new
  fields and plugins, and refuses to start while one is left.
- The web changes only the poll close rule (below) and reads
  `APP_TIME_ZONE`; its container keeps rendering in `APP_TIME_ZONE`
  (compose sets its `TZ` from it) until the web's own port (phase 2).

No change to secrets, no `JWT_SECRET` rotation, nobody is signed out.

**What an instance needs.** The repair must know which zone the old cms
wrote in:

| Instance | `infra/.env` |
|---|---|
| Fresh install, or a SQLite-only setup | nothing (leave both `DATETIME_LEGACY_*` empty) |
| Existing instance first deployed on or after 2026-08-15 (compose with `TZ=Europe/Berlin`) | `DATETIME_LEGACY_ZONE=Europe/Berlin` |
| Existing instance that ran before 2026-08-15 (its cms ran in UTC) and took the `aadb2ea` deploy | `DATETIME_LEGACY_ZONE=Europe/Berlin` and `DATETIME_LEGACY_UTC_UNTIL=θ`, the switch instant (step 2) |
| The owner instance | `DATETIME_LEGACY_ZONE=Europe/Berlin`, `DATETIME_LEGACY_UTC_UNTIL=2026-08-15T21:46:42+02:00` (confirmed by the report in step 3) |

Without `DATETIME_LEGACY_ZONE` on a database with data, the new cms stops at
its first boot with `[datetime] This database holds datetime values written
before the datetime contract …`, changing nothing, and `infra/deploy.sh`
refuses to deploy.

**Deadline: deploy before 2026-10-25, 01:00 UTC** (the Berlin clocks go back
that night). Until the deploy the old cms keeps writing Berlin wall clocks;
values written during the repeated hour 02:00–03:00 cannot be told apart
afterwards (the repair reads them as the later, standard-time instant, and
the report lists them).

**Before the deploy**

1. **Pull and run the preflight**, deploying nothing:

   ```bash
   cd /opt/sinnlos && git pull      # your checkout on the host
   infra/deploy.sh --check
   ```

   On an existing instance it fails with
   `ERROR: the running database still stores datetimes in the pre-contract
   format …` until step 5 is done. Carry on with steps 2 to 5.

2. **Find θ** (only for an instance that ran in UTC first). θ is any instant
   between the last write of the UTC-era cms and the first write of the
   Berlin-era one. The pre-deploy backup of the switch deploy gives its lower
   bound B: `pg-backup.sh` logs each run with `date -Is` (with offset) in the
   off-site `backup.log`, for example

   ```bash
   grep '^2026-08-15' <offsite-dir>/sinnlos/backup.log
   ```

   θ = B + 1 h works whenever that deploy took less than an hour. The owner's
   B is `2026-08-15T20:46:42+02:00`, so θ = `2026-08-15T21:46:42+02:00`.

3. **Read-only report against the live database**, with the new image. It
   applies the repair's own rules and changes nothing (read-only session,
   read-only transaction). `build` only builds the image; the running
   containers keep serving:

   ```bash
   cd /opt/sinnlos/infra
   COMPOSE="docker compose -p infra -f docker-compose.yml -f docker-compose.traefik.yml"
   $COMPOSE build cms
   $COMPOSE run --rm --no-deps \
     -e DATETIME_LEGACY_ZONE=Europe/Berlin \
     -e DATETIME_LEGACY_UTC_UNTIL=2026-08-15T21:46:42+02:00 \
     cms node dist/scripts/datetime-migration-report.js --around 2026-08-15T20:46:42+02:00
   ```

   (Standalone Caddy box: drop the Traefik file from `COMPOSE`.) Check:
   - `Gap check: OK` — θ lies in an empty stretch of the stored write
     stamps at least as long as the zone offset (120 minutes in August). The
     `--around` list shows the stamps near B with the switch gap marked
     (`----- gap 2h10m -----` or so) and suggests a θ inside it. A
     `Gap check: FAILS` means θ is wrong: pick one inside the marked gap. The
     migration runs the same check and aborts (changing nothing) otherwise.
   - The class counts per table and column (`write-utc`, `write-legacy`,
     `A`, `B`, `C`, `C-allday`, …; see the
     [rules](#310-datetime-contract)).
   - **Ambiguous values**: event, poll and announcement times created before
     θ and saved again after it (class C). The repair reads them as UTC,
     which is right unless someone corrected the time by hand after
     2026-08-15; each open or upcoming one is listed with both readings.
     Note the ones whose "read as Europe/Berlin" line is the intended time:
     you fix those in step 10.

4. **Rehearse on a copy** (strongly recommended): restore a fresh dump into a
   throwaway Postgres 16, run the report there, optionally against the
   pre-switch dump of 2026-06-24 (`--baseline` says which ambiguous values are
   unchanged since then, so the UTC reading holds), and boot the new cms once
   against the copy:

   ```bash
   (
     umask 077; D=$(mktemp -d)
     trap 'docker rm -f -v dt-copy dt-june dt-cms >/dev/null 2>&1; docker network rm dt-rehearsal >/dev/null 2>&1; rm -rf "$D"' EXIT
     docker network create dt-rehearsal
     docker exec infra-db-1 sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner' > "$D/live.dump"
     for db in dt-copy dt-june; do
       docker run -d --name "$db" --network dt-rehearsal -e POSTGRES_USER=sinnlos \
         -e POSTGRES_PASSWORD=rehearsal -e POSTGRES_DB=sinnlos postgres:16-alpine
       until docker exec "$db" pg_isready -q -h 127.0.0.1 -U sinnlos -d sinnlos; do sleep 1; done
     done
     docker exec -i dt-copy pg_restore -U sinnlos -d sinnlos --no-owner --no-privileges < "$D/live.dump"
     docker exec -i dt-june pg_restore -U sinnlos -d sinnlos --no-owner --no-privileges \
       < /home/bigemo/backups/sinnlos/sinnlos-db-2026-06-24-143319.dump
     LEGACY="-e DATETIME_LEGACY_ZONE=Europe/Berlin -e DATETIME_LEGACY_UTC_UNTIL=2026-08-15T21:46:42+02:00"
     DB="-e DATABASE_CLIENT=postgres -e DATABASE_HOST=dt-copy -e DATABASE_NAME=sinnlos -e DATABASE_USERNAME=sinnlos -e DATABASE_PASSWORD=rehearsal"
     docker run --rm --network dt-rehearsal $LEGACY $DB infra-cms \
       node dist/scripts/datetime-migration-report.js --all \
       --baseline postgres://sinnlos:rehearsal@dt-june:5432/sinnlos
     S() { openssl rand -hex 16; }
     docker run -d --name dt-cms --network dt-rehearsal $LEGACY $DB \
       -e APP_KEYS="$(S),$(S)" -e API_TOKEN_SALT="$(S)" -e ADMIN_JWT_SECRET="$(S)" \
       -e TRANSFER_TOKEN_SALT="$(S)" -e JWT_SECRET="$(S)" -e ENCRYPTION_KEY="$(S)" \
       -e REVALIDATE_SECRET="$(S)" -e INTERNAL_UPLOAD_TOKEN="$(S)" \
       -e DIGESTS_DISABLED=1 -e LIVE_EVENTS_DISABLED=1 infra-cms
     until docker logs dt-cms 2>&1 | grep -qE 'Strapi started successfully|failed|Error:'; do sleep 2; done
     docker logs dt-cms 2>&1 | grep -E '\[datetime\]|failed|Error:|started successfully'
     docker exec dt-copy psql -U sinnlos -d sinnlos -c \
       "SELECT count(*) AS naive_left FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'timestamp without time zone';" \
       -c "SELECT class, zone, count(*) FROM datetime_migration_audit GROUP BY 1, 2 ORDER BY 1;" \
       -c "SELECT id, title, start AT TIME ZONE 'Europe/Berlin' AS start_berlin, all_day FROM events WHERE published_at IS NOT NULL ORDER BY start;"
   )
   ```

   The cms log must show `[datetime] legacy repair (run …): N value(s)
   rewritten …`, `[datetime] converted 3 column(s) to timestamptz:
   strapi_database_schema.time, strapi_migrations.time,
   strapi_migrations_internal.time` and `Strapi started successfully`;
   `naive_left` must be 0, and the event times in Berlin time must match what
   the events mean. Without the June dump drop `dt-june` and `--baseline`.
   The trap removes both containers, the network and the dump.

5. **Set the variables in `infra/.env`**, permanently (they only matter
   again if a pre-repair dump is ever restored, and then they must be right):

   ```dotenv
   DATETIME_LEGACY_ZONE=Europe/Berlin
   DATETIME_LEGACY_UTC_UNTIL=2026-08-15T21:46:42+02:00
   ```

   Leave `APP_TIME_ZONE` unset (or `Europe/Berlin`) unless the company is
   elsewhere. Then `infra/deploy.sh --check` prints `Preflight OK`.

6. **Host backup time.** The nightly `pg-backup.sh` runs from the host
   crontab at 03:00 **host time**; the uploads and search-log janitors run at
   03:30 and 03:35 **`APP_TIME_ZONE`**, and must run after the backup. On a
   host in `Europe/Berlin` (the owner's) nothing changes. On a host in UTC
   with `APP_TIME_ZONE=Europe/Berlin`, 03:00 UTC is 04:00 or 05:00 Berlin:
   move the crontab line to `0 1 * * *` UTC, or set the host zone
   (`timedatectl set-timezone Europe/Berlin`).

**Deploy**

7. Run `infra/deploy.sh` (it takes the mandatory pre-deploy backup first;
   keep that dump until step 10 is done). On a standalone Caddy box: take the
   backup, then `docker compose up -d --build` from `infra/`.

**What the first boot does** (`docker logs infra-cms-1`):

```
[datetime] process time zone UTC, APP_TIME_ZONE Europe/Berlin
[internal migration]: migrating 2026.10.05T00.00.00.datetime-timestamptz.js
[datetime] legacy repair (run …, legacy zone Europe/Berlin, θ 2026-08-15T19:46:42.000Z): N value(s) rewritten, M column(s) converted to timestamptz, K old value(s) kept in datetime_migration_audit. Classes: …
[datetime] gap check: … min between … and … (needs 120)
[internal migration]: migrated 2026.10.05T00.00.00.datetime-timestamptz.js (…s)
[datetime] converted 3 column(s) to timestamptz: strapi_database_schema.time, strapi_migrations.time, strapi_migrations_internal.time
Strapi started successfully
```

(Strapi labels user migrations `[internal migration]` too.) The repair runs
in one transaction: if it fails (missing variable, gap check, a lock held
for 30 s), nothing is changed, the cms exits, compose restarts it in a loop,
and `deploy.sh`'s smoke check fails. Fix the cause and deploy again, or roll
back ([Rolling back this release](#rolling-back-this-release)). It is
recorded in `strapi_migrations` and never runs again on this database.

**After the deploy**

8. **Checks.** `infra/deploy.sh` step 5 runs `infra/live-smoke.sh`, which now
   starts with `live-smoke: datetime contract OK (process time zone UTC,
   APP_TIME_ZONE Europe/Berlin)`. By hand:

   ```bash
   docker exec infra-db-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM information_schema.columns WHERE table_schema = '\''public'\'' AND data_type = '\''timestamp without time zone'\''"'
   ```

   must print `0`. In the web, an event created in July for 18:00 (which the
   old cms showed at 16:00 since 2026-08-15) shows 18:00 again.
9. **Poll check:** a poll created with "closes on D" closes at the end of D
   (23:59:59 `APP_TIME_ZONE`); the vote button and the vote endpoint now agree
   at that second.
10. **Review the ambiguous values.** The report now lists what the repair
    recorded (open or upcoming ones; `--all` for every one):

    ```bash
    $COMPOSE exec cms node dist/scripts/datetime-migration-report.js
    ```

    For each value where the `read as Europe/Berlin` line is the intended
    time (someone corrected it by hand after 2026-08-15), correct the time in
    the Strapi admin panel (it now shows the `read as UTC` time).
11. **Later:** after 90 days, and once step 10 is done, drop the audit table:
    `DROP TABLE datetime_migration_audit;` (psql as above). Keep the two
    `DATETIME_LEGACY_*` variables.

**What users and editors notice** (worth a short release note):

- Event, poll and announcement times entered before 2026-08-15 show their
  intended time again (since that date they showed two hours early, one
  hour for winter dates). A time corrected by hand since then is the
  exception (step 10).
- Downloaded calendar entries (`.ics`) of all-day events are all-day
  entries, no longer a zero-length appointment at 22:00 or 23:00 the day
  before.
- A poll closes exactly at the end of its closing day in both the page and
  the vote endpoint (the endpoint accepted votes in the very last second).
- Upcoming birthdays and anniversaries, classified expiry and digest days are
  the same as before on a Berlin deployment; anniversaries now need one full
  year, a Feb 29 birthday is shown on Feb 28 in other years, and blocked
  accounts get no card.
- The Strapi admin panel shows and takes times in the admin's **browser**
  zone, as before; the stored instant is correct either way.

#### One-time: org draft/publish off

The release of 2026-09-26 (branch `feat/org-dp-off`, decision 05) turns
draft & publish **off for departments and teams**. Each department and team
is then one row with a stable id, and the department and team checks rely on
that: department heads can update their own department and its teams
(FX07), and members see the announcements, wiki spaces, documents and quick
links targeted at their department or team. Before, a user was often linked
to a department's draft row while content was linked to its published row,
so these checks failed closed (403 for department heads, targeted content
hidden from its own audience).

What admins notice: the Department and Team edit views have **Save** only.
A save is live immediately; there is no Publish, Unpublish or Discard, and
hiding a unit means deleting it. What users notice: department members,
heads and team leads now see the content targeted at their department or
team, and they now count in acknowledgement reports, digests and new
notification fan-outs. Nothing is sent retroactively.

A database used by an earlier release can still hold **draft rows** for
departments or teams: a unit created in the admin panel and never
published, or one edited after its last publish. Strapi deletes those rows
when the new cms boots, and their links with them (users lose their
department, draft content loses its targeting, never-published units are
gone). The new cms therefore **refuses to boot while any exist**: the log
shows `[org-dp] departments still holds N draft row(s)` (or `teams`), compose
restarts it in a loop, and the data stays untouched. The one-time SQL in
`infra/migrations/org-dp/` (see the README there) merges the drafts first.
**A fresh install needs nothing**, and neither does a database that only
holds demo-seed departments and teams (the seed writes one published row
per unit).

Set these on the host, in your checkout (e.g. `/opt/sinnlos`):

```bash
cd /opt/sinnlos
COMPOSE=(docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml)
psql_db() { "${COMPOSE[@]}" exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@"; }
```

**0. Preflight** (read only; run it any time while the current release is
live):

```bash
git pull
psql_db < infra/migrations/org-dp/preflight.sql
```

- **FAST PATH:** if P0 shows `draft_rows` = 0 for both `departments` and
  `teams`, there is nothing to migrate. Deploy as usual with
  `infra/deploy.sh` and stop here (a look at P11 below does no harm). The
  guard passes and Strapi's own switch deletes nothing;
  `"${COMPOSE[@]}" logs cms | grep '\[org-dp\]'` prints nothing.
- These must be 0 before you continue: P0 `anomalies`, P4 (a user linked to
  more than one department), P7 (a duplicate department name or slug, or a
  duplicate team slug), P8 (a table the script does not handle) and P9 (a
  row the script refuses). Fix P4, P7 and a P9 "more than one head, lead or
  department" in the admin panel and rerun the preflight. P0 anomalies, P8
  and the other P9 rows need a closer look; do not continue.
- P1 lists draft-only units: never published, or unpublished in the admin
  to hide them (an unpublish deletes the live row). The migration
  **promotes** them, so they go live. Delete unwanted ones in the admin
  afterwards.
- P2 lists pending draft edits, one row per field. `discarded`: the
  **published value wins**; write the edit down and re-enter it afterwards.
  `ADOPTED (goes live)`: the live unit has no head, lead, department or
  image there, so the draft value goes live. An adopted head or lead can
  edit that department or team right after the deploy; if that is not
  wanted, change it in the admin afterwards. Team membership is merged
  (union): the draft-only members P2 names go live, and nobody loses access
  they have today.
- P10 lists media rows that point at a department or team that no longer
  exists. The migration deletes them; the files stay in the media library.
- P11 lists empty org relations: users without a department, departments
  without a head, users or teams, teams without a department or lead. On
  the old release, editing and publishing a department or team that had no
  draft yet (every demo-seed unit, until its first publish) in the admin
  silently dropped the unit's head or lead, its department, and the users
  and teams linked to it. The migration cannot bring those back. Compare
  P11 with the demo org chart in `apps/cms/src/seed-demo.ts` (every
  department has a head, users and teams; every team a department; every
  team except Recruiting and Payroll a lead; every demo user a department)
  or with an older backup, and note what is missing. Re-link it after the
  migration (step 9), not before: on the old release the next publish can
  drop it again.

**1. Rehearsal** (strongly recommended), on a throwaway copy of the live
database. Both `migrate.sql` runs must end with
`NOTICE:  org-dp: OK - departments=N, teams=M` (the second changes
nothing), and the final preflight must show `draft_rows` 0 and
`draft_links` 0 everywhere. A `RAISE` names what to fix in the live data
first.

```bash
(
  umask 077; D=$(mktemp -d)
  trap 'docker rm -f -v orgdp-rehearsal >/dev/null 2>&1; rm -rf "$D"' EXIT
  docker exec infra-db-1 sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner' > "$D/live.dump"
  docker run -d --name orgdp-rehearsal -e POSTGRES_USER=sinnlos -e POSTGRES_PASSWORD=rehearsal -e POSTGRES_DB=sinnlos postgres:16-alpine
  until docker exec orgdp-rehearsal pg_isready -q -h 127.0.0.1 -U sinnlos -d sinnlos; do sleep 1; done
  docker exec -i orgdp-rehearsal pg_restore -U sinnlos -d sinnlos --no-owner --no-privileges < "$D/live.dump"
  for run in 1 2; do
    docker exec -i orgdp-rehearsal psql -v ON_ERROR_STOP=1 --single-transaction -U sinnlos -d sinnlos < infra/migrations/org-dp/migrate.sql
  done
  docker exec -i orgdp-rehearsal psql -U sinnlos -d sinnlos < infra/migrations/org-dp/preflight.sql
)
```

The subshell keeps `umask 077` out of your shell, and the trap removes the
container and the dump even when a step fails.

**2. Pre-build** the new images; the running site keeps serving:

```bash
"${COMPOSE[@]}" build cms web
```

**3. Stop the apps.** No writes after this point; the site is down until
step 7.

```bash
"${COMPOSE[@]}" stop web cms
```

**4. Back up**, the same way `infra/deploy.sh` does, and keep a plain copy
on the host so a rollback does not need the off-box GPG key. This dump is
the rollback point.

```bash
infra/backup/pg-backup.sh
(umask 077; mkdir -p ~/orgdp-backup &&
  docker exec infra-db-1 sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner' > ~/orgdp-backup/pre-migration.dump)
docker exec -i infra-db-1 pg_restore --list < ~/orgdp-backup/pre-migration.dump > /dev/null && echo "dump OK"
```

**5. Migrate.** One transaction: any `RAISE` rolls everything back. The
script also refuses to run outside one transaction or while another session
is connected.

```bash
psql_db --single-transaction < infra/migrations/org-dp/migrate.sql
```

It must end with `NOTICE:  org-dp: OK - departments=N, teams=M`. After a
`RAISE` nothing has changed: fix what it names and rerun (the script is
idempotent), or give up and bring the old containers back with
`"${COMPOSE[@]}" start cms web` (`start`, not `up`: step 2 already tagged
the new images as `latest`).

**6. Verify:**

```bash
psql_db -c "SELECT 'departments' AS t, count(*) AS rows, count(DISTINCT document_id) AS documents, count(*) FILTER (WHERE published_at IS NULL) AS drafts FROM departments UNION ALL SELECT 'teams', count(*), count(DISTINCT document_id), count(*) FILTER (WHERE published_at IS NULL) FROM teams"
psql_db -c "SELECT user_id FROM up_users_department_lnk GROUP BY user_id HAVING count(*) > 1"
psql_db < infra/migrations/org-dp/preflight.sql    # optional
```

For both types `rows` must equal `documents` and `drafts` must be 0; the
second query must return no rows. In the optional preflight, P0
`draft_rows` and every P3 `draft_links` are 0, and P10 lists nothing.

**7. Deploy** with the unchanged wrapper, then check the cms log:

```bash
infra/deploy.sh
"${COMPOSE[@]}" logs cms | grep '\[org-dp\]'    # must print nothing
```

`deploy.sh` takes a second (post-migration) backup, tags the stopped
containers' images as `:rollback` (`docker inspect` works on stopped
containers), starts the new images from the warm build cache and runs its
smoke checks. Strapi's own draft & publish switch runs once on this first
boot and finds nothing to delete.

**8. Smoke:**

- Signed in as a plain member of a department, you see the announcements,
  wiki spaces, documents and quick links targeted at that department.
- In the admin panel, the Department and Team edit views show **Save**
  only.
- Optional: the department-head probe in
  [§6.4](#64-role-enforcement-optional).

**9. Afterwards:** in the admin (a save is live now and keeps every link),
re-enter the P2 edits marked `discarded`, re-link what you noted from P11,
and delete unwanted P1 units. Once you are satisfied with the release,
delete the plain dump: `rm -rf ~/orgdp-backup`.

**Rollback.** There is no reverse script: the rollback is a `pg_restore` of
the step-4 dump, together with the previous images. Org edits made after the
migration are lost.

- `migrate.sql` failed: nothing changed. `"${COMPOSE[@]}" start cms web`.
- Anything later:

  ```bash
  "${COMPOSE[@]}" stop web cms
  docker exec -i infra-db-1 sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < ~/orgdp-backup/pre-migration.dump
  docker tag infra-web:rollback infra-web:latest
  docker tag infra-cms:rollback infra-cms:latest
  "${COMPOSE[@]}" up -d --no-build web cms
  ```

  Without the plain copy, use the encrypted step-4 artifact of
  `pg-backup.sh` (decrypt it with the off-box key and gunzip it first).
- Rolling forward later means step 0 and steps 3 to 7 again. The same
  holds whenever a pre-migration dump (an older nightly backup, say) is
  restored under the new release, and after an image-only rollback: the old
  cms clones a draft of every department and team on its first boot. In
  each case the new cms refuses to boot until `migrate.sql` has run on that
  data. Step 0 matters here: draft-only edits made in the admin while the
  old image was running follow the P2 rules, so the ones marked
  `discarded` need re-entering afterwards.

**Local SQLite dev:** the guard also blocks a dev database that holds
department or team drafts. Delete `apps/cms/.tmp/data.db` and boot once
with `SEED_DEMO_DATA=1`.

#### Upgrading to the Strapi 5.55.1 release (2026-09-25)

This is hardening batch 2 of 2026-09-25 (branch
`feat/hardening-batch-2`). It moves the cms from Strapi 5.49.0 to **5.55.1**
(with sharp 0.35.4), limits content-API writes on wiki pages, departments and
teams to per-role field allowlists (FX07), and upgrades the test tooling to
vitest 4.1.11. The vitest upgrade is dev and CI only: nothing in either
production image changes, and developers run `pnpm install` after pulling.
Strapi changes the database on first boot, but only additively, and the
previous image still runs on the migrated database. **No env change and no
`JWT_SECRET` rotation**; users stay signed in.

An instance that still runs a release from before 2026-09-24 also needs
[Upgrading from a release before 2026-09-24](#upgrading-from-a-release-before-2026-09-24)
(env contract, one `JWT_SECRET` rotation). Do its "before" steps together
with the ones below; both releases then go out in one deploy.

> **Microsoft sign-in stops working with this release.** Strapi's
> users-permissions 5.51+ completes `/api/auth/:provider/callback` only from
> its own OAuth session, so it answers the web's server-side access-token
> exchange with `400 OAuth authentication requires a completed provider
> session`. Every Microsoft sign-in fails (closed); local e-mail + password
> sign-in is unaffected. An instance whose users sign in with Microsoft must
> stay on its current (Strapi 5.49) images until the planned Entra exchange
> ships. `infra/deploy.sh` enforces this (step 2).

**Before the deploy**

1. **Pull and validate, deploying nothing:**

   ```bash
   cd /opt/sinnlos && git pull      # your checkout on the host
   infra/deploy.sh --check
   ```

   Repeat after each fix until it prints `Preflight OK`.

2. **Microsoft sign-in.** The preflight now fails while `MS_CLIENT_ID` and
   `MS_CLIENT_SECRET` are both set and the client id is a real app
   registration (a GUID); a non-GUID value such as the `.env.example` text
   only warns, because that Microsoft button could never work either. Two
   ways out:
   - keep the running release, and do not deploy this one, until the Entra
     exchange ships; or
   - clear `MS_CLIENT_ID` and `MS_CLIENT_SECRET` in `infra/.env`, which
     switches both apps to local sign-in. Accounts created through Microsoft
     sign-in cannot sign in locally as they are: they have no password, and
     they carry `provider = microsoft`, while Strapi's local login only
     matches accounts with `provider = local`. A password alone is not
     enough: the sign-in page still answers "Invalid email or password". For
     each such account an admin opens it in the Strapi admin
     (**Content Manager → User**), sets a password and changes **Provider**
     from `microsoft` to `local`. To switch the provider of all of them at
     once, run this right before the deploy (the passwords are still set per
     account; the first query lists the accounts that need one, keep that
     list):

     ```bash
     cd /opt/sinnlos/infra
     docker compose exec -T db psql -U sinnlos -d sinnlos -c \
       "SELECT id, email FROM up_users WHERE provider = 'microsoft';"
     docker compose exec -T db psql -U sinnlos -d sinnlos -c \
       "UPDATE up_users SET provider = 'local' WHERE provider = 'microsoft';"
     ```

     The switch is one-way for the old (Strapi 5.49) Microsoft flow: it
     finds its users by provider, so a converted account's Microsoft sign-in
     fails there (the cms answers "Email is already taken"). Before
     re-enabling the `MS_*` keys on a rollback, set those accounts back to
     `microsoft` ([Rolling back the Strapi 5.55.1 release](#rolling-back-the-strapi-5551-release-2026-09-25)).

   An instance that already signs in locally only passes unchanged.

3. **Take the pre-deploy Postgres backup. This step is mandatory.**
   `infra/deploy.sh` runs `infra/backup/pg-backup.sh` before it touches a
   container. On a standalone Caddy box, run it (or the manual dump in
   [§7.1](#71-manual-postgres-backup)) yourself before
   `docker compose up -d --build`. It is the fallback should a rollback ever
   need a restore ([Rolling back the Strapi 5.55.1 release](#rolling-back-the-strapi-5551-release-2026-09-25)).

4. **Nothing else to change.** `JWT_SECRET` stays: users-permissions now pins
   the verification of its legacy-mode JWTs to HS256, the algorithm these
   tokens already use, so tokens issued by 5.49 are accepted by 5.55.1 and
   vice versa (verified). Nobody is signed out.

**Deploy**

5. Run `infra/deploy.sh` on the Traefik host. On a standalone Caddy box, run
   `docker compose up -d --build` from `infra/` once `infra/deploy.sh --check`
   passes. Deploy web and cms together, as compose does. The cms image no
   longer installs the system libvips (`vips-dev`, about 240 MiB): sharp
   0.35.4 loads its bundled libvips 8.18.6 through the prebuilt
   `@img/sharp-linuxmusl-x64` binding (verified in the built `node:24-alpine`
   image with a resize and a real `POST /api/upload` that generated every
   format).

**What the first boot changes in the database.** Strapi's schema sync applies
it on its own; there is no migration script to run:

- two new nullable columns, `admin_users.reset_password_token_expires_at` and
  `strapi_sessions.metadata`;
- one row in `strapi_migrations_internal`,
  `upload::unsign-richtext-and-blocks-urls` (a no-op with the local upload
  provider used here).

No data is rewritten, and there are no new tables or indexes.

**After the deploy**

6. **cms log** (`docker logs infra-cms-1`): one
   `[internal migration]: migrating upload::unsign-richtext-and-blocks-urls`
   line on this first boot, and no errors. Strapi's notice "The Media Library
   has been redesigned and is now the default…" does **not** appear:
   `apps/cms/config/features.ts` sets `useLegacyMediaLibrary: true`, so
   editors keep the Media Library they know (Strapi logs the notice only when
   that flag is absent). Switching to the redesigned one is a separate
   decision: set the flag to `false` or remove it, then rebuild the image.
   The MCP server that ships with Strapi 5.55.1 stays off
   (`server.mcp.enabled` defaults to `false`).
7. **Sessions and uploads:** users who were signed in before the deploy still
   are. Sign in with a local account, and post a marketplace ad with a photo.
   An instance that left Microsoft sign-in in step 2 signs in with one of the
   converted accounts at `/sign-in`.
8. **Cron:** Strapi's cron now runs on croner instead of node-schedule. The
   fire times are unchanged (uploads janitor 03:30, search-log janitor 03:35,
   digest mailer 07:30, Europe/Berlin), checked across both DST switches,
   including 2026-10-25. The next morning the 07:30 digest run logs as
   before (`[digest] run complete …`, or `[digest] skipped` without SMTP).
9. **Permissions (optional):** `infra/diagnostics/prod-perm-diff.sql` now lists
   two informational `MISSING_IN_DB` rows for `authenticated`:
   `plugin::users-permissions.auth.getSessions` and `…auth.revokeSession`.
   users-permissions grants them only on a fresh database
   (`plugin_default_first_boot`); on existing databases nobody holds them,
   their routes (`GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`)
   answer 404 in the legacy JWT mode used here, and the edge sends
   `/api/auth/*` to the web anyway. Nothing to fix. FX07 changes no grant,
   so nothing else in the snapshot moves.

**What users and editors notice** (worth a short release note):

- Nobody is signed out.
- Microsoft sign-in is unavailable until the Entra exchange ships (see above).
- A `%` or `_` in a search term now matches literally (Strapi escapes them in
  `$contains`/`$containsi` filters, which the web search uses).
- A text field longer than 255 characters is rejected with a 400 validation
  error instead of a database error (Postgres `varchar(255)` limited it
  before, too).
- An ad without photos comes back with `images: []` instead of `null`; the
  web handles both.
- Page-based pagination above 100 entries per page is clamped consistently.
- Strapi admin panel: the Media Library stays as it was (step 6). Admin
  reset-password tokens now expire, there is a new active-devices (sessions)
  view, and assets can no longer be edited or deleted on published entries.
- Content-API writes on wiki pages, departments and teams by department
  heads, team leads and members (Strapi JWT) are limited to allowlisted
  fields (FX07): a department head may change the description and colour of
  their own department, a team lead (or the head of the team's department)
  the team's description, and plain team members can no longer edit their
  team. The web has no write path for wiki pages, departments or teams, so
  nothing changes in the web UI; the Strapi admin panel and `admin_role` /
  `editor` API calls are unaffected. Direct API callers get:
  - `400 Invalid or disallowed data field(s): <keys>` for a refused key or
    value;
  - `403` for plain team members updating a team;
  - `403` for authors, department heads or team leads updating a page in a
    space they cannot read, or whose draft and published rows sit in
    different spaces.

  The policies were renamed from `global::is-department-head` /
  `global::is-team-member-or-lead` to `global::can-edit-department` /
  `global::can-edit-team`. No database state refers to them, but runbooks and
  log searches that use the old names need updating. On this release
  department heads should not rely on their write rights yet: department
  scope is compared by row id, so on departments created in the admin panel
  they get a 403. The release of 2026-09-26 fixes that
  ([One-time: org draft/publish off](#one-time-org-draftpublish-off)).
- Published reads through a read policy ignore `?publicationFilter=` and
  `?hasPublishedVersion=` for every role except `admin_role` / `editor`. The
  web sends neither.

#### Upgrading from a release before 2026-09-24

This checklist covers the hardening batch of 2026-09-24 (branch
`feat/hardening-batch-1`). An instance that runs an older release works
through it before (or together with) the steps above; the preflight enforces
both. That release has **no database schema change and no data
migration**, but it tightens the env contract, needs one `JWT_SECRET`
rotation, and signs every user out once. Work through the list in order. The
"before" steps only edit `infra/.env`; nothing on the running stack changes
until step 10.

**Before the deploy**

1. **Pull and validate the live env, deploying nothing:**

   ```bash
   cd /opt/sinnlos && git pull      # your checkout on the host
   infra/deploy.sh --check
   ```

   Repeat after each fix below until it prints `Preflight OK`. The rules are
   listed in [§3.6](#36-deploy). `--check` only renders the compose config and
   inspects the running containers, so it also validates the `infra/.env` of
   a standalone Caddy box.

2. **Fill in the newly required keys.** Compose now refuses to start while
   any of these is empty: `APP_KEYS`, `API_TOKEN_SALT`, `ADMIN_JWT_SECRET`,
   `TRANSFER_TOKEN_SALT`, `JWT_SECRET`, `ENCRYPTION_KEY` (cms), `AUTH_SECRET`
   (web), `REVALIDATE_SECRET` and `INTERNAL_UPLOAD_TOKEN` (cms and web, one
   value each), plus `DATABASE_PASSWORD` as before. Until they are set, the
   rollback commands in [§7.4](#74-update-procedure-production-safe) fail as
   well.

3. **Replace template placeholders.** With `NODE_ENV=production` the new cms
   refuses to boot (`[env-guard] … Refusing to start in production`) while a
   Strapi secret, `REVALIDATE_SECRET` or `INTERNAL_UPLOAD_TOKEN` holds a
   placeholder, and it would only do so after `up -d --build` has replaced the
   running container. The preflight also refuses a placeholder `AUTH_SECRET`,
   which would make web sessions forgeable. A placeholder `DATABASE_PASSWORD`
   only warns, because the Postgres volume keeps its password: run
   `ALTER ROLE … PASSWORD` first, then update the env. Rotate only what the
   preflight names (plus `JWT_SECRET`, step 4). New values have side effects:

   | Secret | Effect of a new value |
   |---|---|
   | `JWT_SECRET` | every user signs in again once |
   | `AUTH_SECRET` | every web session ends; users sign in again |
   | `ADMIN_JWT_SECRET` | Strapi admin-panel sessions end |
   | `APP_KEYS` | Strapi session cookies reset |
   | `API_TOKEN_SALT` / `TRANSFER_TOKEN_SALT` | existing API / transfer tokens stop working |
   | `ENCRYPTION_KEY` | encrypted admin data (e.g. viewable API-token keys) can no longer be decrypted |
   | `REVALIDATE_SECRET` / `INTERNAL_UPLOAD_TOKEN` | none, as long as cms and web get the same value (compose passes one value to both) |

4. **Rotate `JWT_SECRET` once. This step is mandatory.** Before this release
   every signed-in user could read their own Strapi JWT from
   `GET /api/auth/session`. Those JWTs are valid for 7 days, cannot be
   revoked one by one, and work against the public `/api/*` until they expire
   or `JWT_SECRET` changes. Put a fresh value in `infra/.env`
   (`openssl rand -base64 32`). Effect: everyone signs in once. Open tabs land
   on `/sign-in?expired=1` at their next page load, and signing in again
   works. `AUTH_SECRET` does not need rotating: the Auth.js cookie itself was
   never exposed. The preflight enforces this step. It fails while the
   running web image lacks the label `org.sinnlos.strapi-jwt=server-only` and
   `JWT_SECRET` is unchanged. The same holds after a web rollback to an older
   image: rolling forward again needs another rotation (see
   [Rolling back the 2026-09-24 release](#rolling-back-the-2026-09-24-release)).

5. **Set the digest sender.** The compose defaults
   `DIGEST_FROM=Sinnlos Intranet <noreply@yurtbay.dev>` and
   `DIGEST_REPLY_TO=noreply@yurtbay.dev` (the live instance's sender) are
   gone, and the cms has no built-in sender any more. With `SMTP_*` set, the
   preflight **fails** until `DIGEST_FROM` is set. Without it every digest
   run would be skipped with an error log, and Strapi's own admin mails
   (password reset) would have no default sender. To keep the previous
   behaviour of the live instance, add:

   ```dotenv
   DIGEST_FROM='Sinnlos Intranet <noreply@yurtbay.dev>'
   DIGEST_REPLY_TO=noreply@yurtbay.dev
   ```

   Or set `DIGESTS_DISABLED=1`. `PUBLIC_WEB_URL`, the digest link base, now
   defaults to `WEB_PUBLIC_URL` (before: `https://sinnlos.yurtbay.dev`). Set it
   only if digest links should point somewhere else.

6. **Check that the host Traefik overwrites `X-Forwarded-For`.** The
   preflight cannot check this. The cms now trusts `X-Forwarded-For`
   (`server.proxy.koa`, `apps/cms/config/server.ts`), so its sign-in throttles
   count per client IP: `POST /api/auth/local` (10 requests per minute,
   before: one bucket for the whole instance) and `/admin/login` (5 attempts
   per 5 minutes per e-mail and IP, before: one bucket per admin e-mail). That
   is only sound while the edge **overwrites** a client-supplied
   `X-Forwarded-For`. Caddy does by default. The host Traefik's static
   configuration is not in this repo; it can come from a file, CLI arguments
   or `TRAEFIK_*` environment variables, so check all three:

   ```bash
   docker inspect <traefik-container> | grep -i forwardedheaders     # CLI args + env
   grep -rin forwardedheaders <directory of the traefik static config>
   ```

   Expected on the `websecure` entrypoint: no `forwardedHeaders.insecure`, and
   `forwardedHeaders.trustedIPs` only for proxies in front of Traefik that
   overwrite the header rather than append to it (usually none). Otherwise
   every client can pick its own throttle bucket, and password guessing
   against `/admin/login` is effectively unthrottled. Never publish
   `cms:1337` on a host port either: a caller that reaches the cms directly
   can set the header itself.

7. **Keep `WEB_PUBLIC_URL` the real public `https://` URL.** Compose passes
   it to the web as `AUTH_URL`. Its scheme names the session cookie
   (`__Secure-authjs.session-token`), and the server-side reader of the Strapi
   JWT derives the cookie name the same way.

8. **Check for an admin seeded from the old template.** If the Strapi super
   admin was ever created from the old template (`admin@example.com` /
   `change-me-please`), change its e-mail and password in `/admin` (Settings →
   Users) and clear `STRAPI_ADMIN_*` in `infra/.env`. The cms logs an error on
   every boot while an admin with an `@example.com/.org/.net` e-mail exists.

9. **Optional clean-up.** `APP_NAME` is no longer read, and the web container
   no longer receives `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_APP_NAME` or
   `STRAPI_ADMIN_*`. Leaving them in `infra/.env` is harmless. Remove
   `STRAPI_ADMIN_*` once the admin exists.

**Deploy**

10. Run `infra/deploy.sh` on the Traefik host. On a standalone Caddy box, run
    `docker compose up -d --build` from `infra/` once `infra/deploy.sh --check`
    passes. Deploy web and cms together, as compose does. The web container is
    recreated, which also discards the old Next.js fetch cache
    (`.next/cache/fetch-cache`) in its writable layer. If the old web
    container was kept for some reason, recreate it:
    `docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml up -d --force-recreate web`.
    Mixed versions during the rollout are harmless: an old cms posting to the
    removed `/api/revalidate` gets a redirect, which it ignores.

**After the deploy**

11. **cms log** (`docker logs infra-cms-1`): no
    `[env-guard] … Refusing to start`; one
    `[bootstrap] revoked N obsolete permission(s)` line with N > 0 on this
    first boot (later boots log nothing); no `[digest] misconfigured` error
    when SMTP is set. `[bootstrap] STRAPI_ADMIN_* ignored …` means the keys
    can be removed (step 9).
12. **Sessions:** every user signs in once. While signed in,
    `curl -s -b '__Secure-authjs.session-token=<cookie value>' https://<host>/api/auth/session`
    returns only `user` (name, email, image, id), `provider` and `expires`, with
    no Strapi JWT, role or department.
13. **Role gates** (sign in as each role): admin sees *Admin* and
    `/manage*`; admin and editor see *New poll* and can create a poll; a guest
    sees no RSVP controls and no *New ad* button, and `/marketplace/new`
    redirects; a member can RSVP and post ads. This is a visible change:
    before this release the web had no role for local non-admin users (and
    for every Microsoft user), so editors never saw *New poll* and guests saw
    RSVP and marketplace controls that then failed. The `authenticated`
    fallback role no longer sees *New ad* either.
14. **Probes:**
    - `curl -i -X POST https://<host>/api/Auth/local` answers 404.
    - `curl -i --path-as-is https://<host>/api/../uploads/<file>` answers 404.
    - Uploaded images and documents under `/uploads` load for signed-in
      users. Posting a marketplace ad with 1–4 photos works, and the stored
      file URLs end in `.jpg`, `.png` or `.webp`.
    - Sign-in throttling is per client IP: a burst of sign-ins from one
      address does not block users at other addresses. When Strapi's own
      throttle answers, the sign-in form says "Too many sign-in attempts —
      please wait a minute…" instead of "Invalid email or password".
15. **Strapi admin → Settings → Users & Permissions → Roles:** no role has
    poll-vote find/findOne/create/update/delete (only the custom `vote` and
    `results` actions remain; guest has `results` only); admin and editor
    have no notification create/update and
    no comment/kudos/reaction update; admin has no lesson-progress
    update/delete.
16. **Live pipeline:** `infra/live-smoke.sh` passed (`deploy.sh` runs it when
    the demo credentials file is present; otherwise run it by hand).
17. **After a working day:**
    `docker exec infra-web-1 sh -c 'ls /app/apps/web/.next/cache/fetch-cache 2>/dev/null | wc -l'`
    prints `0`. If SMTP is configured, the 07:30 run logs
    `[digest] run complete …`, not `[digest] skipped: DIGEST_FROM unset …`.

**What users and editors notice** (worth a short release note):

- Everyone signs in once after the deploy.
- A Microsoft sign-in that was already in progress when the web container
  was replaced may fail once: next-auth 5.0.0-beta.32 (@auth/core 0.41.3)
  binds the OAuth state/nonce/PKCE check cookies (15-minute lifetime) to the
  provider, and cookies issued by the old build fail that check. The user
  lands on the Auth.js error page and the web log shows `InvalidCheck`.
  Signing in again works. E-mail/password sign-ins are not affected.
- A session lasts at most 7 days from sign-in, the lifetime of its Strapi
  JWT. Using the site does not extend it.
- A role change in the Strapi admin applies at the user's next page load,
  without signing in again.
- Edits in the Strapi admin show on the next page load. There is no 30–60 s
  cache delay any more. Pages make a few more internal requests to Strapi,
  and while Strapi is down, lists show an error banner instead of stale data.
- Kudos, comments, reactions, notifications and training receipts can no
  longer be edited through the REST API. Corrections happen in the Strapi
  admin panel.
- Strapi's sign-in throttle counts per client IP. An office behind one NAT
  address still shares one bucket.
- Unpublished events, polls, departments and teams can no longer be read
  through the API by anyone but admins and editors.

### 3.9 Production hardening

The live deployment applies these (already encoded in the compose files — no
extra steps):

- **Non-root containers.** Both `web` and `cms` run as an unprivileged user with
  `no-new-privileges`, the `web` container additionally drops all Linux
  capabilities (`cap_drop: ALL`). The Postgres and app services also carry
  `mem_limit` / `cpus` / `pids_limit` caps.
- **Security response headers** are set at the **Traefik** layer (override file),
  not in the app: `X-Content-Type-Options: nosniff`, `frameDeny`,
  `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive
  `Permissions-Policy` (`camera=(), microphone=(), geolocation=(), payment=(),
  usb=()`), and HSTS (`max-age=31536000; includeSubDomains`).
- **Rate limiting** guards brute-force / floods, again at Traefik
  (rateLimit middleware, **not** an IP allowlist): `sinnlos-ratelimit`
  (avg 100 req/s per client IP, burst 100) on the auth router (`/api/auth/*`)
  and the cms router (`/api`, `/admin`, `/upload`, … — not `/uploads`, which
  goes to web), and `sinnlos-authlimit` (10 req/s, burst 20) on the
  `sinnlos-signin` router (`POST /sign-in` and `POST /register`). The web
  catch-all router deliberately carries **no** rate limit. The authoritative
  login limiter lives in the app (`authorize()` in `apps/web/src/auth.ts`).
- **Client IP trust.** The cms trusts `X-Forwarded-For`/`-Proto`
  (`proxy: { koa: true }` in `apps/cms/config/server.ts`). Its sign-in
  throttles therefore count per client IP (users-permissions
  `/api/auth/local`: 10 requests per minute; `/admin/login`: 5 attempts per
  5 minutes per e-mail and IP), and the admin refresh cookie is `Secure`
  behind the TLS edge. This relies on the edge **overwriting** a
  client-supplied `X-Forwarded-For`: Caddy does by default; the host
  Traefik's `websecure` entrypoint must set no `forwardedHeaders.insecure`
  and list in `forwardedHeaders.trustedIPs` only proxies that overwrite the
  header. Never publish `cms:1337` on a host port. How to check: step 6 of
  the [2026-09-24 upgrade checklist](#upgrading-from-a-release-before-2026-09-24).
- **Auth-path guard.** Traefik's ``PathPrefix(`/api/auth`)`` is
  case-sensitive, Strapi's router is not, so `/api/Auth/local` would reach
  Strapi's own login past the web's login limiter. The cms middleware
  `global::auth-path-guard` answers every spelling other than the literal
  lowercase `/api/auth/…` (case variants, `%`-encoded, `//`, `..`) with 404.

> For a standalone Caddy box (mode A) only part of this applies: the
> Caddyfile sets `X-Content-Type-Options` and `Referrer-Policy` and removes
> `Server`, but has no HSTS, no `X-Frame-Options`/`Permissions-Policy` and
> no rate limit. Add equivalent directives or front the box with your own
> proxy if you need them. The cms-side guards and the app's login limiter
> apply either way.

### 3.10 Datetime contract

How times are stored and computed (deep-dive decision 04; phase 1 covers
the cms and the database, phase 2 the web):

- **Instants** (a point on the timeline: `createdAt`, event `start`/`end`,
  poll `closesAt`, …) are Strapi `datetime` fields, stored as Postgres
  `timestamptz(6)` and sent as ISO-8601 in UTC with `Z`. The cms accepts an
  instant only with `Z` or an offset.
- **Calendar dates** (classified `expiresAt`, announcement `ackDeadline`,
  `birthday`, `hireDate`) are Strapi `date` fields: `YYYY-MM-DD`, no zone,
  never turned into a midnight instant.
- **Zones.** The cms process runs in UTC (`TZ=UTC` in the image and in
  compose), and every database session runs in UTC (`-c TimeZone=UTC`, sent
  by `apps/cms/config/database.ts`). The business zone is `APP_TIME_ZONE`
  (IANA name, default `Europe/Berlin`, one per deployment): "today", day and
  week windows (weeks start on Monday), anniversaries (Feb 29 falls on Feb 28
  in other years), classified expiry, digest days, the cron times, all-day
  event days and poll deadlines ("closes on D" = D 23:59:59 there). Spell
  it as the tz database does (`Europe/Berlin`, not `europe/berlin`); a UTC
  offset such as `+02:00` is refused, because Postgres reads it with the
  opposite sign. With an unknown value or an offset the cms does not
  start, and the web answers every request with an error (Next.js logs `An
  error occurred while loading instrumentation hook: APP_TIME_ZONE must be
  …`). Changing it later moves those boundaries, not stored instants. Until
  the web's phase 2 the web container runs in `APP_TIME_ZONE` (compose
  passes the value on as its `TZ`) and renders dates in its process zone;
  when `TZ` is set, the web also refuses to serve if Node does not run in
  `APP_TIME_ZONE`, e.g. with a wrong-case name Node cannot find (`The web
  process runs in …, not in APP_TIME_ZONE …`). `DATETIME_LEGACY_ZONE`
  follows the same rules.
- **The guard.** Strapi creates every new `datetime` column as
  `timestamp without time zone`. At each boot the cms converts every such
  column of the app schema (`DATABASE_SCHEMA`, default `public`) to
  `timestamptz` right after Strapi's schema sync, one short transaction per
  table (lock timeout 5 s, statement timeout 60 s), reads the stored wall
  clock as UTC, and logs `[datetime] converted N column(s) …`. It **refuses to
  start** when a column is still naive after a retry, when the process is not
  in UTC while there is something to convert, when a boot creates or changes
  the schema in a non-UTC process, when the database session is not in UTC,
  or when a naive app column holds data before the one-time repair has run.
  An ordinary restart in a non-UTC process only warns. On SQLite (local
  development) all of this is skipped.
- **The one-time repair** (`apps/cms/database/migrations/`, logic in
  `apps/cms/src/database/datetime-legacy.ts`) runs on the first boot of a
  database written before the contract. It needs `DATETIME_LEGACY_ZONE`
  (the zone the old cms ran in) and, if that cms ran in UTC first,
  `DATETIME_LEGACY_UTC_UNTIL` (θ, the switch instant). Rules per value:
  write-time stamps (`created_at`, `updated_at`, `published_at`, `read_at`,
  …) by their own value (before θ: UTC wall clock, after: legacy zone);
  session and token expiries by their row's `created_at`; user-entered
  instants (`events.start`/`end`, `polls.closes_at`,
  `announcements.expires_at`, `strapi_releases.scheduled_at`) by provenance:
  **A** the document was created after θ (legacy zone), **B** the row was
  last saved before θ (UTC), **C** otherwise (ambiguous; UTC, except an
  all-day event stored as a legacy-zone midnight). A gap check requires θ to
  sit in an empty stretch of write stamps at least as long as the zone
  offset; old values stay in `datetime_migration_audit` (as text). Strapi's
  bookkeeping tables are left to the guard. The runbook is
  [Upgrading an existing instance to this release](#upgrading-an-existing-instance-to-this-release).
- **Report CLI** (read-only): `node dist/scripts/datetime-migration-report.js`
  in the cms container (`--help` for the options). Before the repair it shows
  what the repair would do; after it, the ambiguous values it recorded.
- **Connection rules.** `DATABASE_URL` must not carry its own `options`
  parameter (it would replace the UTC pin; the cms refuses it unless it sets
  `TimeZone=UTC` itself). A pooler that drops startup options (PgBouncer in
  transaction mode, Azure's built-in PgBouncer on port 6432) breaks the pin:
  connect the cms directly (port 5432).
- **Admin panel.** Strapi's admin panel shows and takes times in the
  admin's **browser** zone; the stored instant is right either way. Admins
  outside `APP_TIME_ZONE` see their own local times there.
- **Cron and backups.** The janitors run at 03:30 / 03:35 and the digest at
  07:30 `APP_TIME_ZONE`; the host crontab's 03:00 backup runs in the host's
  zone and must come first (keep the host in `APP_TIME_ZONE`, or shift the
  crontab line).
- **Local development.** SQLite needs nothing. With a local Postgres, set
  `TZ=UTC` in `apps/cms/.env` (a boot that creates or changes the schema
  refuses any other zone).
- **Tests.** `pnpm test:tz` runs the suite under `TZ=UTC`, `Europe/Berlin`
  and `Pacific/Auckland`. The Postgres 16 integration suites
  (`apps/cms/src/database/*.pg.test.ts`) run when `SINNLOS_TEST_PG_URL` points
  at a database they may create schemas in, e.g. a throwaway
  `docker run --rm -d -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=test postgres:16-alpine`
  with `SINNLOS_TEST_PG_URL=postgres://postgres:test@127.0.0.1:55432/postgres`.
  CI's `datetime` job runs both; rerun it for every Strapi, knex or pg upgrade.
- **New fields.** Instants are `"type": "datetime"`, calendar days
  `"type": "date"`, durations numbers with the unit in the name. Never put a
  `column` or `columnType` override on a `datetime` attribute: Strapi then
  re-creates the column naive through an `ALTER` (the guard converts it back
  at the same boot, but it is avoidable DDL).

---

## 4. Azure VM Deployment

The simplest Azure deployment: a Linux VM running Docker Compose, identical to
the VPS approach but using Azure infrastructure.

### 4.1 Login to Azure CLI

```bash
az login
az account set --subscription "<your-subscription-name-or-id>"
```

### 4.2 Create a resource group

```bash
az group create \
  --name rg-sinnlos \
  --location westeurope
```

### 4.3 Create the VM

```bash
az vm create \
  --resource-group rg-sinnlos \
  --name vm-sinnlos \
  --image Ubuntu2404 \
  --size Standard_B2s \
  --admin-username azureuser \
  --generate-ssh-keys \
  --public-ip-sku Standard \
  --output table
```

`Standard_B2s` = 2 vCPU / 4 GB RAM (~€30/month in West Europe).
Note the `publicIpAddress` in the output.

> **Memory warning:** Building Next.js and Strapi on the VM can peak near
> 3.5 GB. On `Standard_B2s` (4 GB) you should either:
>
> 1. **Add swap** to avoid OOM during build (recommended for 4 GB VMs):
>    ```bash
>    # On the VM after SSHing in
>    sudo fallocate -l 4G /swapfile
>    sudo chmod 600 /swapfile
>    sudo mkswap /swapfile
>    sudo swapon /swapfile
>    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
>    ```
> 2. **Or pick `Standard_B2ms`** (2 vCPU / 8 GB RAM, ~€55/month).
> 3. **Or build images on your laptop**, push to ACR, and run `docker compose pull`
>    on the VM — zero build work on the server.

### 4.4 Open ports

```bash
az vm open-port \
  --resource-group rg-sinnlos \
  --name vm-sinnlos \
  --port 80 \
  --priority 900

az vm open-port \
  --resource-group rg-sinnlos \
  --name vm-sinnlos \
  --port 443 \
  --priority 901
```

### 4.5 Connect and install Docker

```bash
ssh azureuser@<public-ip>

curl -fsSL https://get.docker.com | sh
usermod -aG docker azureuser
newgrp docker
```

### 4.6 Assign a static public IP (optional but recommended)

`az vm create` auto-generates a public IP named `<vm-name>PublicIP`. First,
discover the exact name, then make it static so it survives VM restarts:

```bash
# Find the public IP resource
az network public-ip list \
  --resource-group rg-sinnlos \
  --query "[].name" -o tsv

# Make it static (replace with the name you just saw)
az network public-ip update \
  --resource-group rg-sinnlos \
  --name vm-sinnlosPublicIP \
  --allocation-method Static
```

### 4.7 Add a custom domain (optional)

You can use Azure DNS or any registrar. In Azure DNS:

```bash
az network dns zone create \
  --resource-group rg-sinnlos \
  --name example.com

az network dns record-set a add-record \
  --resource-group rg-sinnlos \
  --zone-name example.com \
  --record-set-name intranet \
  --ipv4-address <public-ip>
```

Or add an A record pointing `intranet.example.com` → `<public-ip>` in your
existing DNS provider.

### 4.8 Deploy (same as VPS from here)

On the VM:

```bash
git clone https://github.com/yurtbayemre/sinnlos.git /opt/sinnlos
cd /opt/sinnlos/infra
cp .env.example .env
# Edit .env with your domain and secrets; leave MS_* empty on this release (see §3.5)
docker compose up -d --build
```

Caddy requests TLS automatically. Visit **https://intranet.example.com**.

### 4.9 Persistent disk (recommended for production)

By default, the Postgres data volume lives on the OS disk.
For production, attach a dedicated managed disk:

```bash
az vm disk attach \
  --resource-group rg-sinnlos \
  --vm-name vm-sinnlos \
  --name disk-sinnlos-data \
  --new \
  --size-gb 64 \
  --sku Premium_LRS

# On the VM — format and mount
sudo mkfs.ext4 /dev/sdc
sudo mkdir /mnt/data
echo '/dev/sdc /mnt/data ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a
```

Then move the Docker volumes root or update `docker-compose.yml` to bind-mount
the Postgres data directory to `/mnt/data/pgdata`.

### 4.10 Auto-shutdown to reduce cost (dev VMs)

```bash
az vm auto-shutdown \
  --resource-group rg-sinnlos \
  --name vm-sinnlos \
  --time 2200 \
  --timezone "W. Europe Standard Time"
```

---

## 5. Azure Container Apps (Advanced)

Container Apps is a managed serverless platform — no VM to patch, scales to
zero when idle, pay-per-request. More setup but no server management.

> **Prerequisites:** Azure CLI, Docker, a private Azure Container Registry (ACR).

### 5.1 Create a Container Registry

```bash
az acr create \
  --resource-group rg-sinnlos \
  --name acrsinnlos \
  --sku Basic \
  --admin-enabled true
```

### 5.2 Build and push images

```bash
# Login to ACR
az acr login --name acrsinnlos

# From the repo root
docker build -f apps/cms/Dockerfile -t acrsinnlos.azurecr.io/sinnlos-cms:latest .
docker build -f apps/web/Dockerfile -t acrsinnlos.azurecr.io/sinnlos-web:latest .

docker push acrsinnlos.azurecr.io/sinnlos-cms:latest
docker push acrsinnlos.azurecr.io/sinnlos-web:latest
```

### 5.3 Create a Container Apps Environment

```bash
az containerapp env create \
  --name env-sinnlos \
  --resource-group rg-sinnlos \
  --location westeurope
```

### 5.4 Deploy Postgres on Azure Database for PostgreSQL

```bash
az postgres flexible-server create \
  --resource-group rg-sinnlos \
  --name db-sinnlos \
  --location westeurope \
  --admin-user sinnlos \
  --admin-password "<strong-password>" \
  --sku-name Standard_B1ms \
  --tier Burstable \
  --version 16 \
  --public-access None
```

Note the hostname: `db-sinnlos.postgres.database.azure.com`.

> ⚠ **Do not use `--public-access 0.0.0.0`** — that opens your database to the
> entire internet. Either:
>
> - **Preferred:** Create the Container Apps environment in a VNet and peer
>   the Postgres flexible server into the same VNet (private access). See
>   [Azure docs](https://learn.microsoft.com/en-us/azure/container-apps/networking).
> - **Simpler alternative:** After deploying the containers (steps 5.5–5.6),
>   read the outbound IPs from your Container Apps environment and whitelist
>   only those:
>   ```bash
>   # Get the Container Apps environment's outbound IPs
>   az containerapp env show \
>     --name env-sinnlos --resource-group rg-sinnlos \
>     --query "properties.staticIp" -o tsv
>
>   # Whitelist that single IP on Postgres
>   az postgres flexible-server firewall-rule create \
>     --resource-group rg-sinnlos \
>     --name db-sinnlos \
>     --rule-name allow-container-apps \
>     --start-ip-address <static-ip> \
>     --end-ip-address <static-ip>
>   ```

**Create the database** (Strapi needs it to exist):

```bash
az postgres flexible-server db create \
  --resource-group rg-sinnlos \
  --server-name db-sinnlos \
  --database-name sinnlos
```

### 5.5 Create persistent storage for uploads

Container filesystems are ephemeral — without persistent storage, every
Strapi redeploy would wipe user uploads (avatars, images, attachments).
Mount an **Azure Files** share onto `/app/apps/cms/public/uploads`:

```bash
# Create a storage account
az storage account create \
  --resource-group rg-sinnlos \
  --name stsinnlos$RANDOM \
  --location westeurope \
  --sku Standard_LRS

STORAGE_NAME=$(az storage account list \
  --resource-group rg-sinnlos \
  --query "[?starts_with(name, 'stsinnlos')].name" -o tsv)

STORAGE_KEY=$(az storage account keys list \
  --resource-group rg-sinnlos \
  --account-name $STORAGE_NAME \
  --query "[0].value" -o tsv)

# Create a file share
az storage share-rm create \
  --resource-group rg-sinnlos \
  --storage-account $STORAGE_NAME \
  --name uploads \
  --quota 50

# Register the share with the Container Apps environment
az containerapp env storage set \
  --resource-group rg-sinnlos \
  --name env-sinnlos \
  --storage-name uploads \
  --azure-file-account-name $STORAGE_NAME \
  --azure-file-account-key $STORAGE_KEY \
  --azure-file-share-name uploads \
  --access-mode ReadWrite
```

### 5.6 Deploy the CMS container

```bash
az containerapp create \
  --name cms-sinnlos \
  --resource-group rg-sinnlos \
  --environment env-sinnlos \
  --image acrsinnlos.azurecr.io/sinnlos-cms:latest \
  --registry-server acrsinnlos.azurecr.io \
  --registry-username acrsinnlos \
  --registry-password "$(az acr credential show --name acrsinnlos --query passwords[0].value -o tsv)" \
  --target-port 1337 \
  --ingress internal \
  --min-replicas 1 \
  --max-replicas 2 \
  --env-vars \
      NODE_ENV=production \
      HOST=0.0.0.0 \
      PORT=1337 \
      DATABASE_CLIENT=postgres \
      DATABASE_HOST=db-sinnlos.postgres.database.azure.com \
      DATABASE_PORT=5432 \
      DATABASE_NAME=sinnlos \
      DATABASE_USERNAME=sinnlos \
      "DATABASE_PASSWORD=<db-password>" \
      DATABASE_SSL=true \
      DATABASE_SSL_REJECT_UNAUTHORIZED=false \
      "APP_KEYS=<secret>,<secret>" \
      "API_TOKEN_SALT=<secret>" \
      "ADMIN_JWT_SECRET=<secret>" \
      "TRANSFER_TOKEN_SALT=<secret>" \
      "JWT_SECRET=<secret>" \
      "ENCRYPTION_KEY=<secret>" \
      "REVALIDATE_SECRET=<openssl rand -hex 32>" \
      "INTERNAL_UPLOAD_TOKEN=<openssl rand -hex 32>" \
      "MS_CLIENT_ID=<client-id>" \
      "MS_CLIENT_SECRET=<client-secret>" \
      "MS_TENANT_ID=<tenant-id>" \
      "LIVE_EVENTS_DISABLED=0" \
      "APP_TIME_ZONE=Europe/Berlin" \
      "SMTP_HOST=<mail.example.com>" \
      "SMTP_PORT=587" \
      "SMTP_USER=<noreply@example.com>" \
      "SMTP_PASS=<mailbox-app-password>" \
      "DIGEST_FROM=Intranet <noreply@example.com>"
```

> The `SMTP_*` block is optional — without it the 07:30 digest cron is a
> logged no-op. With it, `DIGEST_FROM` and `PUBLIC_WEB_URL` (the digest link
> base, back-filled in §5.7) are required, or every run is skipped with an
> error log. `LIVE_EVENTS_DISABLED` must be set to the SAME value on the
> web container (the kill switch is read on both sides), and
> `INTERNAL_UPLOAD_TOKEN` must be identical on both containers. Replace every
> `<…>` stand-in: the cms refuses to start in production with a placeholder
> secret. The cms image runs in UTC by itself; `APP_TIME_ZONE` is the
> business zone ([datetime contract](#310-datetime-contract)), and
> `DATABASE_HOST` must be the server itself on port 5432, not Azure's built-in
> PgBouncer (port 6432), which drops the cms's UTC session setting.

> **Note on `WEB_INTERNAL_URL`:** the CMS also needs this to send its
> live-event pings to the Next.js `/api/live/emit` ingest, but the web app's
> FQDN only exists after it's deployed. We set it in a follow-up step at the
> end of section 5.7.

**Attach the uploads volume** (must be done via YAML because the CLI create
doesn't accept volume mounts directly):

```bash
# Export the current spec
az containerapp show \
  --name cms-sinnlos --resource-group rg-sinnlos \
  -o yaml > cms.yaml

# Edit cms.yaml — under properties.template, add:
#   volumes:
#     - name: uploads-vol
#       storageType: AzureFile
#       storageName: uploads
# And under properties.template.containers[0], add:
#   volumeMounts:
#     - volumeName: uploads-vol
#       mountPath: /app/apps/cms/public/uploads

az containerapp update \
  --name cms-sinnlos --resource-group rg-sinnlos \
  --yaml cms.yaml
```

> **Why `DATABASE_SSL_REJECT_UNAUTHORIZED=false`?** Azure PostgreSQL uses a
> managed CA that is trusted by modern Node runtimes, but the Strapi Postgres
> driver can fail cert validation in some environments. Setting this to `false`
> keeps SSL encryption on but relaxes CA verification. For strict validation,
> download the Baltimore/DigiCert root via `DATABASE_SSL_CA` instead.

### 5.7 Deploy the Web container

The web container needs `AUTH_URL` to match its own public FQDN — but the FQDN
only exists *after* creation. We deploy once with a placeholder, then update
the env vars with the real FQDN.

```bash
# Get the internal CMS URL (known already)
CMS_URL=$(az containerapp show \
  --name cms-sinnlos \
  --resource-group rg-sinnlos \
  --query "properties.configuration.ingress.fqdn" -o tsv)

# First creation — AUTH_URL placeholder
az containerapp create \
  --name web-sinnlos \
  --resource-group rg-sinnlos \
  --environment env-sinnlos \
  --image acrsinnlos.azurecr.io/sinnlos-web:latest \
  --registry-server acrsinnlos.azurecr.io \
  --registry-username acrsinnlos \
  --registry-password "$(az acr credential show --name acrsinnlos --query passwords[0].value -o tsv)" \
  --target-port 3000 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 5 \
  --env-vars \
      NODE_ENV=production \
      "STRAPI_URL=https://$CMS_URL" \
      AUTH_TRUST_HOST=true \
      "AUTH_SECRET=<secret>" \
      "REVALIDATE_SECRET=<same-value-as-cms>" \
      "INTERNAL_UPLOAD_TOKEN=<same-value-as-cms>" \
      "AUTH_MICROSOFT_ENTRA_ID_ID=<client-id>" \
      "AUTH_MICROSOFT_ENTRA_ID_SECRET=<client-secret>" \
      "AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0" \
      "LIVE_EVENTS_DISABLED=0" \
      "APP_TIME_ZONE=Europe/Berlin" \
      "TZ=Europe/Berlin"

# TZ: the web still renders dates in its process zone until its datetime
# port (phase 2), so it must equal APP_TIME_ZONE (compose does the same).

# Now read the FQDN assigned to the web app
WEB_FQDN=$(az containerapp show \
  --name web-sinnlos --resource-group rg-sinnlos \
  --query "properties.configuration.ingress.fqdn" -o tsv)

echo "Web app URL: https://$WEB_FQDN"

# Update env vars on the web app with the real URL
az containerapp update \
  --name web-sinnlos --resource-group rg-sinnlos \
  --set-env-vars \
      "AUTH_URL=https://$WEB_FQDN"

# Back-fill WEB_INTERNAL_URL on the CMS so its live-event pings can
# reach the Next.js /api/live/emit ingest. Traffic between the two
# Container Apps stays inside the environment's virtual network even
# though we're using the public FQDN. PUBLIC_WEB_URL is the link base
# of the digest e-mails (no default outside compose).
az containerapp update \
  --name cms-sinnlos --resource-group rg-sinnlos \
  --set-env-vars "WEB_INTERNAL_URL=https://$WEB_FQDN" "PUBLIC_WEB_URL=https://$WEB_FQDN"
```

**Add the Entra redirect URI.** Go to your App registration →
**Authentication** → **Redirect URIs** and add:

```
https://<web-fqdn>/api/auth/callback/microsoft-entra-id
```

Where `<web-fqdn>` is the value `$WEB_FQDN` printed above. Without this,
Microsoft sign-in will fail with `AADSTS50011`.

The web app gets a public FQDN (`*.azurecontainerapps.io`). Add a custom domain
via **Container Apps → Custom domains** and Azure will provision a managed TLS
certificate automatically. If you add a custom domain later, re-run the
`AUTH_URL` update step with the new hostname.

### 5.8 Update images after a code change

```bash
docker build -f apps/web/Dockerfile -t acrsinnlos.azurecr.io/sinnlos-web:latest . \
  && docker push acrsinnlos.azurecr.io/sinnlos-web:latest

az containerapp update \
  --name web-sinnlos \
  --resource-group rg-sinnlos \
  --image acrsinnlos.azurecr.io/sinnlos-web:latest
```

---

## Live-event ingest (cms → web)

The web keeps **no server-side cache** of Strapi responses: every Strapi read
is sent with `cache: "no-store"`, so a content edit shows on the next page
load and there is nothing to invalidate. The cache-revalidation webhook
(`POST /api/revalidate`, `apps/cms/src/utils/revalidate.ts`) was removed on
2026-09-24; that path now falls under the normal session guard.

The one internal cms → web call left is the live-update ping of the SSE
pipeline: the cms posts content-free events to `POST /api/live/emit`, the only
web endpoint that needs no session. It is guarded by a shared secret sent as
the `x-revalidate-secret` header (the names are historical):

| Var                  | On CMS | On Web | Purpose                                              |
| -------------------- | :----: | :----: | ---------------------------------------------------- |
| `REVALIDATE_SECRET`  |   ✓    |   ✓    | Shared secret for `/api/live/emit`; must match on both sides |
| `WEB_INTERNAL_URL`   |   ✓    |   —    | How the CMS reaches Next.js (e.g. `http://web:3000`) |

Generate the secret once (`openssl rand -hex 32`) and paste the same value
into both services' env. If either variable is unset on the cms, it sends no
pings; if the secret is unset on the web, `/api/live/emit` answers 503 (and
401 on a mismatch). The app keeps working either way: live updates stop, and
open pages only refresh through the polling fallback. From outside, `/api/live/emit`
is unreachable: the edge sends every `/api/*` path except `/api/auth/*` to
the cms.

---

## Post-Deployment Verification

After any deployment, run through this smoke test to confirm everything works
end-to-end. Replace `<URL>` with your deployment's base URL
(`http://localhost:3000`, `http://localhost`, or `https://intranet.example.com`).

### 6.1 Health checks

```bash
# Next.js responds
curl -I <URL>/
# Expect: HTTP/1.1 200 OK   (or 307 redirect to /sign-in)

# SSE live pipeline (the one subsystem that can be silently dead while
# every container looks healthy): expect an open stream emitting hb events
# — or run infra/live-smoke.sh for the full comment→ping proof.
curl -N -H 'Accept: text/event-stream' <URL>/live/stream --max-time 30
# Expect (signed-in cookie required): "event: hello" then "event: hb" frames

# Strapi API responds
curl -I <URL>/api/departments
# Expect: HTTP/1.1 200 OK (or 401 if the endpoint requires auth)

# Strapi admin loads
curl -I <URL>/admin
# Expect: HTTP/1.1 200 OK

# Datetime contract (Docker Compose): the cms runs in UTC and no column is
# left as timestamp without time zone (infra/live-smoke.sh checks both).
docker logs infra-cms-1 2>&1 | grep '\[datetime\] process time zone'
# Expect: [datetime] process time zone UTC, APP_TIME_ZONE Europe/Berlin
docker exec infra-db-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM information_schema.columns WHERE data_type = '\''timestamp without time zone'\'' AND table_schema = '\''public'\''"'
# Expect: 0
```

### 6.2 Content bootstrap

1. Open `<URL>/admin` → create your first Strapi admin user.
2. **Settings → Users & Permissions plugin → Roles** — confirm all six roles
   exist: `admin_role`, `editor`, `department_head`, `team_lead`, `member`, `guest`.
3. **Content Manager → Department → Create new entry** — create a test
   department (name: "Engineering", slug: "engineering"), save. Departments
   and teams have no Publish step: a save is live.
4. Open `<URL>/departments` → the test department should render.

### 6.3 Microsoft sign-in flow

> **Skip this on the current release.** Microsoft sign-in cannot complete on
> Strapi 5.51+ (see the [Entra section](#microsoft-entra-id-app-registration));
> check local sign-in instead: `<URL>/` redirects to `/sign-in`, and e-mail +
> password lands on the dashboard with your display name in the top-right.
> The steps below apply once the Entra exchange ships.

1. Open `<URL>/` → you should be redirected to `/sign-in`.
2. Click **Sign in with Microsoft** → complete the OIDC flow.
3. You should land on the dashboard with your display name in the top-right.
4. In Strapi admin → **Content Manager → User** — confirm your account was
   auto-created (e-mail = your lowercased user principal name, role
   `member`).

> **Current state (verified 2026-09-25):** on Strapi 5.55.1 step 2 already
> fails: the cms answers the web's token exchange with a 400, and the web
> shows the Auth.js error page. On Strapi 5.49 (the previous release) the
> sign-in completed, but the Graph enrichment and group → role mapping did
> not run (the users-permissions extension is inert, see the README note
> under step 4), so `microsoftOid` and `displayName` stayed empty and roles
> were assigned in the Strapi admin. A new user's first Microsoft sign-in
> there also needs `LOCAL_REGISTRATION=1` on the cms, and the Microsoft
> provider must be enabled in the Strapi admin (**Settings → Providers**);
> the `MS_*` env alone does not enable it.

### 6.4 Role enforcement (optional)

As a non-admin user, try to edit a wiki page you don't own via the Strapi API.
You need that user's Strapi JWT. The web no longer hands it out
(`/api/auth/session` has not carried it since 2026-09-24), and the edge sends
`/api/auth/*` to Auth.js, so get one for a local test account from inside the
stack:

```bash
docker exec infra-web-1 wget -qO- \
  --header 'Content-Type: application/json' \
  --post-data '{"identifier":"<test-user-email>","password":"<password>"}' \
  http://cms:1337/api/auth/local
# → {"jwt":"<your-strapi-jwt>","user":{…}}
```

Then:

```bash
curl -X PUT <URL>/api/wiki-pages/1 \
  -H "Authorization: Bearer <your-strapi-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"data":{"title":"Hijacked"}}'
# Expect: 403 Forbidden
```

Field-level write allowlist (FX07): with the JWT of a team lead, change the
description of their own team, then try to add members:

```bash
curl -X PUT <URL>/api/teams/<team-documentId> \
  -H "Authorization: Bearer <team-lead-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"data":{"description":"Updated by the lead"}}'
# Expect: 200 OK

curl -X PUT <URL>/api/teams/<team-documentId> \
  -H "Authorization: Bearer <team-lead-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"data":{"members":[1]}}'
# Expect: 400 "Invalid or disallowed data field(s): members"
```

A plain member of the team gets 403 for both. Demo-seed teams work as well:
since departments and teams lost draft & publish (2026-09-26), an update
changes the one row in place. Before that, REST updates of seed rows failed
for every caller (FX38).

A department head can change their own department, not another one:

```bash
curl -X PUT <URL>/api/departments/<own-department-documentId> \
  -H "Authorization: Bearer <department-head-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"data":{"description":"Updated by the head"}}'
# Expect: 200 OK (403 for any other department)
```

### 6.5 Common failure signals

| Symptom | Likely cause |
|---|---|
| `/admin` returns 502 for 60+ seconds | Strapi still building admin panel — wait and check `docker compose logs -f cms` |
| `/sign-in` redirects loop | `AUTH_URL` doesn't match the host header — check env vars |
| MS login `AADSTS50011` | Redirect URI missing in Entra app registration — go back to Step 5 and add it |
| Every MS login fails; the web log shows `Could not exchange Microsoft access token…` and the cms answered `400 OAuth authentication requires a completed provider session` | Expected on Strapi 5.51+ (this release): Microsoft sign-in is unavailable until the Entra exchange ships. Clear `MS_CLIENT_ID`/`MS_CLIENT_SECRET` for local sign-in (Microsoft-created accounts also need a password and `provider = local`, [upgrade step 2](#upgrading-to-the-strapi-5551-release-2026-09-25)), or roll back ([Rolling back the Strapi 5.55.1 release](#rolling-back-the-strapi-5551-release-2026-09-25)) |
| `infra/deploy.sh` stops with `ERROR: Microsoft sign-in is configured …` | The preflight's Microsoft rule ([§3.6](#36-deploy)): keep the running release, or clear `MS_CLIENT_ID`/`MS_CLIENT_SECRET` in `infra/.env` and convert Microsoft-created accounts ([upgrade step 2](#upgrading-to-the-strapi-5551-release-2026-09-25)) |
| Local sign-in answers "Invalid email or password" for an account created through Microsoft sign-in, although an admin set its password | The account still has `provider = microsoft`; Strapi's local login only matches `provider = local`. Change **Provider** to `local` in **Content Manager → User** ([upgrade step 2](#upgrading-to-the-strapi-5551-release-2026-09-25)) |
| MS login succeeds but lands on a Strapi error page (Strapi 5.49 images only) | Microsoft provider not enabled in the Strapi admin (**Settings → Providers**; the `MS_*` env does not enable it on Strapi 5.49), or a new user's first sign-in while `LOCAL_REGISTRATION` is not `1` on the cms |
| Dashboard shows "0 departments" even after creating one | Strapi permissions — confirm `public` role has `find` access to departments, OR you're signed in |
| cms restarts in a loop, log says `[env-guard] placeholder value in … Refusing to start in production` | A secret in the env still holds a template placeholder — generate real values (`infra/deploy.sh --check` names the keys) |
| cms restarts in a loop, log says `[org-dp] departments still holds N draft row(s)` (or `teams`) | The database still has department/team drafts from an earlier release (not migrated, a pre-migration dump restored, or a roll-forward after an image rollback). The data is untouched; run [One-time: org draft/publish off](#one-time-org-draftpublish-off) step 0 (preflight), then steps 3 to 7 |
| `docker compose up` fails with `… must be set` | A required key in `infra/.env` is empty (see [§3.6](#36-deploy)) |
| Every signed-in user lands on `/sign-in?expired=1` right after a deploy | Expected once after a `JWT_SECRET` rotation — signing in again fixes it |
| Every uploaded image/document answers 404 | `INTERNAL_UPLOAD_TOKEN` unset on the cms or different on cms and web |
| Sign-in form says "Too many sign-in attempts" for everyone | Strapi's throttle sees one client IP for all users: the edge does not pass the client's `X-Forwarded-For` (see [§3.9](#39-production-hardening)) |
| Admin link / `/manage` missing for an admin | `GET /api/me` failed for that request (check the web log for `[viewer]`), or the web was rolled back past 2026-09-24 and the user has not signed in again ([Rolling back the 2026-09-24 release](#rolling-back-the-2026-09-24-release)) |
| `[digest] misconfigured` / `[digest] skipped: DIGEST_FROM unset` in the cms log | SMTP is set without `DIGEST_FROM` or `PUBLIC_WEB_URL` |
| cms restarts in a loop, log says `[datetime] This database holds datetime values written before the datetime contract …` | First boot on a pre-contract database without `DATETIME_LEGACY_ZONE`; nothing was changed. Follow [Upgrading an existing instance to this release](#upgrading-an-existing-instance-to-this-release) |
| cms restarts in a loop, log says `DATETIME_LEGACY_UTC_UNTIL (θ = …) is not inside an empty stretch of write-time stamps` | θ is wrong; nothing was changed. Run the report with `--around <pre-deploy backup time>` and pick θ inside the marked gap (upgrade step 3) |
| `[datetime] … needs a UTC process` or `… only correct in a UTC process` | The cms runs with another `TZ` (a custom compose file or orchestrator). Set `TZ=UTC` ([§3.10](#310-datetime-contract)) |
| `[datetime] The database session runs in "…", not UTC` | A pooler or proxy drops the startup options (PgBouncer in transaction mode, Azure's port 6432): connect the cms to Postgres directly |
| cms refuses to start: `DATABASE_URL sets its own \`options\` query parameter …` | Remove `options` from `DATABASE_URL` (or include `-c TimeZone=UTC` in it) |
| `[datetime] N column(s) are still timestamp without time zone after two conversion attempts` | Another session held a lock on those tables (a long `psql` transaction, a dump). End it and restart the cms; the guard converts them then |
| cms refuses to start, or every web page answers 500 with `An error occurred while loading instrumentation hook: APP_TIME_ZONE must be an IANA time zone name …` in the web log | Fix `APP_TIME_ZONE` in `infra/.env` (an IANA name such as `Europe/Berlin`, no UTC offset) or leave it empty |
| every web page answers 500, web log: `… instrumentation hook: The web process runs in …, not in APP_TIME_ZONE …` | The web container's `TZ` is not the zone Node runs in: spell `APP_TIME_ZONE` exactly as the tz database does (`Europe/Berlin`, not `europe/berlin`); with a custom orchestrator set `TZ` to the same name |
| `infra/deploy.sh` stops with `ERROR: the running database still stores datetimes in the pre-contract format …` | Set `DATETIME_LEGACY_ZONE` (and on some instances `DATETIME_LEGACY_UTC_UNTIL`), see the upgrade section |
| `live-smoke: FAIL — timestamp without time zone columns remain` | The guard did not run or failed: check `docker logs infra-cms-1 \| grep datetime` |

---

## Backup & Restore

For any production deployment (VPS or Azure VM with Docker Compose), you are
responsible for backing up two things:

1. **Postgres database** — all content, users, revisions, announcements
2. **Uploads volume** — images, avatars, file attachments

> For Azure Container Apps, use **Azure Database for PostgreSQL automated
> backups** (7–35 days, enabled by default) and **Azure Files snapshots**
> for the uploads share. No manual setup needed beyond confirming backup
> retention in the Azure portal.

### 7.1 Manual Postgres backup

From the Docker Compose host:

```bash
cd /opt/sinnlos/infra

# Dump to a timestamped file
docker compose exec -T db \
  pg_dump -U sinnlos -d sinnlos --format=custom \
  > backups/sinnlos-$(date +%Y%m%d-%H%M%S).dump
```

Restore:

```bash
# ⚠ This drops the existing database first
docker compose exec -T db \
  pg_restore -U sinnlos -d sinnlos --clean --if-exists \
  < backups/sinnlos-20260415-120000.dump
```

### 7.2 Backup uploads volume

```bash
# Copy uploads out of the named volume
docker run --rm \
  -v sinnlos_cms_uploads:/uploads \
  -v "$(pwd)/backups":/backup \
  alpine tar czf /backup/uploads-$(date +%Y%m%d-%H%M%S).tar.gz -C /uploads .
```

Restore:

```bash
docker run --rm \
  -v sinnlos_cms_uploads:/uploads \
  -v "$(pwd)/backups":/backup \
  alpine sh -c "cd /uploads && tar xzf /backup/uploads-20260415-120000.tar.gz"
```

### 7.3 Automated daily backups (cron)

The live host ships a ready-made script: **`infra/backup/pg-backup.sh`**. It is
the canonical backup for the `infra` project and does more than the manual
snippets above:

- dumps Postgres from `infra-db-1` (`pg_dump -Fc --no-owner`) and **verifies**
  the dump with `pg_restore --list` before keeping it;
- tars the `infra_cms_uploads` volume;
- gzips each artifact, then **GPG-encrypts** it to the VPS backup public key
  (asymmetric — a host/NAS compromise can't decrypt; the private key lives
  off-box);
- writes into the offsite dir under a `sinnlos/` namespace so the existing
  NAS `rrsync` pull replicates it automatically;
- keeps the **newest 7** of each artifact.

It reads its paths from the backup keyring env (`SINNLOS_BACKUP_DIR`,
`SINNLOS_GNUPGHOME`, `SINNLOS_BACKUP_KEYID`), defaulting to the shared
`/home/bigemo/backups/momsbest` keyring. `infra/deploy.sh` runs it once as a
**pre-deploy** snapshot; register it nightly with cron:

```bash
( crontab -l 2>/dev/null ; \
  echo "0 3 * * * /opt/sinnlos/infra/backup/pg-backup.sh >> /var/log/sinnlos-backup.log 2>&1" ) \
  | crontab -
```

> Self-hosting without the GPG/NAS keyring? Use the manual `pg_dump` + volume-tar
> commands in §7.1–§7.2 on a cron instead, and push the output off-site with
> `rsync`/`rclone`.

> **Order matters:** the crontab runs in the **host's** zone, while the
> uploads and search-log janitors run at 03:30 / 03:35 **`APP_TIME_ZONE`**
> ([datetime contract](#310-datetime-contract)). The backup must come first,
> so every swept file is still in the previous backup. With the host in
> `APP_TIME_ZONE` the line above is right; on a UTC host with
> `APP_TIME_ZONE=Europe/Berlin` use `0 1 * * *`.

### 7.4 Update procedure (production-safe)

On the live Traefik host the wrapper handles backup, rollback-tagging, build and
smoke-check in one shot:

```bash
cd /opt/sinnlos && git pull
infra/deploy.sh
```

The manual equivalent (e.g. on a standalone Caddy box):

```bash
# 1. Always back up first
/opt/sinnlos/infra/backup/pg-backup.sh

# 2. Pull latest code and validate infra/.env (deploys nothing)
cd /opt/sinnlos && git pull
infra/deploy.sh --check

# 3. Rebuild and restart (no data loss)
cd infra && docker compose up -d --build

# 4. Watch the logs until both containers report healthy
docker compose -p infra logs -f --tail=50 cms web
```

**Rollback.** `deploy.sh` tags the previously-running images `infra-web:rollback`
and `infra-cms:rollback` before each build, so a bad deploy can be reverted
**without** rebuilding — retag and re-up just the affected service:

```bash
docker tag infra-web:rollback infra-web:latest
docker tag infra-cms:rollback infra-cms:latest
docker compose -p infra \
  -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
  up -d --no-build web cms
```

If a code revert is needed instead, reset and rebuild:

```bash
cd /opt/sinnlos
git reset --hard <previous-commit-sha>
infra/deploy.sh
```

If the database schema changed, restore from the pre-deploy backup (decrypt the
GPG artifact first with the off-box private key):

```bash
docker exec -i infra-db-1 pg_restore -U sinnlos -d sinnlos --clean --if-exists \
  < sinnlos-db-<timestamp>.dump
```

A dump taken before the org draft/publish migration, restored under a
release from 2026-09-26 on, makes the cms refuse to boot (`[org-dp]`) until
`migrate.sql` has run on it again
([One-time: org draft/publish off](#one-time-org-draftpublish-off), step 0, then
steps 3–7).

#### Rolling back this release

Re-upping the previous cms image (the 2026-09-26 release) after the datetime
repair is safe **without** a `pg_restore`. Rehearsed on Postgres 16 with that
image against a repaired database: it boots without any schema change (its
schema sync finds the same schema; the unknown `strapi_migrations` record is
ignored), reads every instant unchanged, and writes correct instants even in
a Berlin process (pg sends a `Date` with its offset, and `timestamptz` keeps
the instant). Rolling forward again is a no-op: the repair is recorded and
never runs twice. Use the retag commands above.

- The rollback commands run with the **new** compose file, so the old cms
  then runs in UTC: until you roll forward, its date logic (birthday cards,
  digest days, classified expiry) uses UTC days, off by one day between
  midnight and 02:00 Berlin time. Its cron times stay Berlin (hard-coded
  there). To avoid that, re-up it with the previous compose file:
  `git show <previous-commit>:infra/docker-compose.yml > /tmp/compose-prev.yml`
  and use `-f /tmp/compose-prev.yml` instead of `-f infra/docker-compose.yml`.
- Do **not** restore the pre-deploy dump just to roll back. If you restore it
  anyway (it predates the repair), keep `DATETIME_LEGACY_ZONE` /
  `DATETIME_LEGACY_UTC_UNTIL` set: the next boot of the new cms then repairs
  it again, correctly. Values written between the deploy and the restore are
  lost with the restore, as with any restore.
- A web-only rollback brings back the old poll close rule (the card treats the
  closing second as open) and nothing else.

#### Rolling back the Strapi 5.55.1 release (2026-09-25)

Re-upping the previous (Strapi 5.49) cms image after 5.55.1 has migrated the
database is safe **without** a `pg_restore`. This was verified on Postgres 16
(5.49, then 5.55.1, then 5.49, then the 5.55.1 image again): the old image
boots without errors, `forceMigration: false` keeps the two new columns, the
unknown `strapi_migrations_internal` record is ignored, and sign-ins, existing
tokens and uploads work in both directions. Use the retag commands above;
`pg_restore` of the pre-deploy dump stays the fallback.

- Do **not** boot the old image with `DATABASE_FORCE_MIGRATION=true`. It
  would drop the two new columns: harmless, but not intended.
- JWTs stay valid across the rollback in both directions, so nobody is signed
  out.
- Until the new images are deployed again, the old cms runs sharp 0.33.5
  (open advisories in the upload path), has no field-level write allowlist
  (department heads, team leads and members can again write every field of
  the rows their old policies let them edit), and honours
  `?publicationFilter=` for every reader.
- A web-only rollback changes nothing but the error text and boot log for
  Microsoft sign-ins.
- An instance that switched Microsoft-created accounts to `provider = local`
  (upgrade step 2) and re-enables the `MS_*` keys on the old images sets
  those accounts back to `microsoft` first (the ids from the step 2 list):
  `UPDATE up_users SET provider = 'microsoft' WHERE id IN (…);`. Otherwise
  their Microsoft sign-in fails (the cms answers "Email is already taken").
- If the previous images predate 2026-09-24 (the instance took both releases
  in one deploy), the caveats of
  [Rolling back the 2026-09-24 release](#rolling-back-the-2026-09-24-release)
  apply as well.

#### Rolling back the 2026-09-24 release

Rolling back the 2026-09-24 hardening release to the previous images is
database-safe: it has no schema change and no migration, so no restore is
needed. The rollback commands above run with the **new** compose file, so the
newly required keys must stay set. Expect these side effects until the new
images are deployed again:

- **Web rollback — roles disappear until users sign in again.** The new web
  writes no role or department into the session cookie; the old web reads
  them from there. Every session created by the new web therefore has no
  role in the old web: an admin loses the *Admin* link and `/manage` until
  they sign out and in again.
- **Web rollback — the Strapi JWT is exposed again.** The old web serves each
  user's Strapi JWT on `/api/auth/session`. When you roll forward, the
  preflight demands another `JWT_SECRET` rotation (the running web lacks the
  `org.sinnlos.strapi-jwt=server-only` label), and everyone signs in once
  more.
- **Web rollback — the per-user Next.js data cache comes back** (one entry
  per JWT on disk, possibly stale until its timer expires); the
  new web discards it again when its container is recreated.
- **cms rollback — the removed routes and grants come back.** The old
  bootstrap only adds permissions, so the generic `/api/poll-votes` routes
  (forged and duplicate votes), notification create/update, comment, kudos
  and reaction update and lesson-progress update/delete are live again until
  the new cms is redeployed; its first boot revokes them again. The global
  relation guard, the root query-key allowlist, the upload body allowlist,
  `published-only` and the `/api/auth` case guard are gone for that time, too.
- **cms rollback — the digest sender.** Under the new compose file the old
  cms receives the `DIGEST_FROM` value from `infra/.env` and no longer its old
  built-in default. Keep `DIGEST_FROM` set (the preflight requires it with
  SMTP), or set `DIGESTS_DISABLED=1`.

---

## Comparison

| | Bare-metal local | Docker local | VPS | Azure VM | Container Apps |
|---|---|---|---|---|---|
| TLS | none | none | Auto (Let's Encrypt) | Auto (Let's Encrypt) | Managed by Azure |
| Scaling | single process | single host | single host | single VM | auto-scales |
| Cost | free | free | €5–30/mo | €30–60/mo | pay-per-use |
| Setup effort | low | low | medium | medium | high |
| Managed Postgres | SQLite | Docker volume | Docker volume | Docker volume or managed | Azure Database |
| Best for | development | full-stack testing | production, small team | production, Azure tenant | production, Azure-native |

---

## Common Issues

**`docker compose up` fails with "port 80 already in use"**

```bash
# Find what's on port 80
sudo lsof -i :80
# Stop it (e.g. nginx, apache2)
sudo systemctl stop nginx
```

**Strapi fails to start: "Cannot find module"**

Usually means the builder stage ran against a stale or incomplete lockfile.
Clear the build cache and rebuild from scratch:

```bash
cd infra
docker compose build --no-cache cms
docker compose up -d cms
```

Both Dockerfiles install with `pnpm install --frozen-lockfile`, so the root
`pnpm-lock.yaml` must match the package manifests. After changing any
`package.json`, run `pnpm install` locally and commit the updated lockfile.

**Caddy "certificate authority not found" on localhost**

For local Docker, use `http://localhost` — don't use HTTPS for `localhost` without
a local CA. The Caddyfile's `{$DOMAIN:localhost}` block serves HTTP on localhost
automatically.

**Microsoft sign-in returns "AADSTS50011: The redirect URI does not match"**

The redirect URI in your Entra app registration must match exactly (including
trailing slash) what Auth.js sends:
- `<WEB_URL>/api/auth/callback/microsoft-entra-id`
- `<CMS_URL>/api/connect/microsoft/callback` (Strapi's own OAuth redirect;
  not used by the current flow, harmless to keep)

On this release Microsoft sign-in fails later anyway, at the token exchange
(see the [Entra section](#microsoft-entra-id-app-registration)).

**Strapi admin blank / 502 after first deploy**

Strapi takes 30–60 seconds to build its admin panel on first start. Check:

```bash
docker compose logs -f cms
```

Wait for `Strapi is listening on: http://0.0.0.0:1337` before opening the admin.

**Container Apps: CMS not reachable from Web**

Make sure `cms-sinnlos` uses `--ingress internal` (not `external`). The web
container connects to it via the internal FQDN provided by the Container Apps
environment.
