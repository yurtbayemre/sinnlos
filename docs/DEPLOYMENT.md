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
[Microsoft Entra ID setup](#microsoft-entra-id-app-registration) — do those first.

---

## Prerequisites

Install these on any machine you are deploying **from**:

| Tool | Minimum version | Install |
|---|---|---|
| Node.js | 20.11 LTS *(or 22 LTS / 24 LTS)* | [nodejs.org](https://nodejs.org) |
| pnpm | 9.x | `corepack enable && corepack prepare pnpm@9.12.0 --activate` |
| Git | any recent | system package manager |
| openssl | any recent | preinstalled on macOS/Linux; on Windows use Git Bash or WSL |
| curl | any recent | preinstalled on macOS/Linux |
| Docker + Docker Compose | Docker 24 / Compose v2 | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Mac/Win) or [Docker Engine](https://docs.docker.com/engine/install/) (Linux) |
| Azure CLI *(Azure only)* | 2.60 | [learn.microsoft.com/cli/azure/install](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) |

Check versions:

```bash
node -v          # v20.x.x, v22.x.x, or v24.x.x
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

**`apps/cms/.env`** — fill in. The `.env.example` defaults to Postgres; override
with **SQLite** for the simplest local setup (no external database needed):

```dotenv
# Use SQLite locally — zero-config, file-based
DATABASE_CLIENT=sqlite
DATABASE_FILENAME=.tmp/data.db

APP_KEYS=key1,key2            # two random strings, comma-separated
API_TOKEN_SALT=               # openssl rand -base64 32
ADMIN_JWT_SECRET=             # openssl rand -base64 32
TRANSFER_TOKEN_SALT=          # openssl rand -base64 32
JWT_SECRET=                   # openssl rand -base64 32
ENCRYPTION_KEY=               # openssl rand -base64 32

PUBLIC_URL=http://localhost:1337

MS_CLIENT_ID=<your-client-id>
MS_CLIENT_SECRET=<your-client-secret>
MS_TENANT_ID=<your-tenant-id>

# Optional — enables instant cache invalidation on content edits.
# See "Revalidation webhook" below. Must match REVALIDATE_SECRET in
# apps/web/.env.local. Skip for bare-metal dev if you don't mind
# waiting for the ISR timer (30–60s).
REVALIDATE_SECRET=<openssl rand -hex 32>
WEB_INTERNAL_URL=http://localhost:3000
```

> **Prefer Postgres locally?** Run one with Docker in a single command and keep
> the default `DATABASE_CLIENT=postgres`:
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
AUTH_URL=http://localhost:3000
AUTH_TRUST_HOST=true
AUTH_MICROSOFT_ENTRA_ID_ID=<your-client-id>
AUTH_MICROSOFT_ENTRA_ID_SECRET=<your-client-secret>
AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/<your-tenant-id>/v2.0

# Must match REVALIDATE_SECRET in apps/cms/.env (or leave both unset
# to disable webhook revalidation locally).
REVALIDATE_SECRET=<same-value-as-cms>
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

### 1.4 First-time Strapi setup

1. Open **http://localhost:1337/admin** → create your first admin account.
2. The bootstrap script automatically creates the six roles (`admin_role`, `editor`,
   `department_head`, `team_lead`, `member`, `guest`). Verify them under
   *Settings → Users & Permissions → Roles*.

### 1.5 Verify login

1. Open **http://localhost:3000** → you are redirected to `/sign-in`.
2. Click **Sign in with Microsoft** → complete the Microsoft OIDC flow.
3. Strapi auto-creates your user, pulls display name + job title from Graph, and
   maps your Entra group membership to a role.
4. You land on the dashboard with your name in the top-right corner.

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

DATABASE_PASSWORD=<strong-random-password>

APP_KEYS=<openssl rand -base64 32>,<openssl rand -base64 32>
API_TOKEN_SALT=<openssl rand -base64 32>
ADMIN_JWT_SECRET=<openssl rand -base64 32>
TRANSFER_TOKEN_SALT=<openssl rand -base64 32>
JWT_SECRET=<openssl rand -base64 32>
ENCRYPTION_KEY=<openssl rand -base64 32>
AUTH_SECRET=<openssl rand -base64 32>

# Shared secret used by the Strapi → Next.js revalidation webhook.
# Both services read this; without it, content edits take 30–60s to
# appear on the frontend (the ISR cache timer) instead of instantly.
REVALIDATE_SECRET=<openssl rand -hex 32>

MS_TENANT_ID=<your-tenant-id>
MS_CLIENT_ID=<your-client-id>
MS_CLIENT_SECRET=<your-client-secret>
```

> **Tip:** For localhost, Caddy runs without HTTPS (no domain ownership proof
> needed). Redirect URIs in Entra should use `http://localhost/...`.

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

DATABASE_PASSWORD=<strong-random-password>

APP_KEYS=<secret>,<secret>
API_TOKEN_SALT=<secret>
ADMIN_JWT_SECRET=<secret>
TRANSFER_TOKEN_SALT=<secret>
JWT_SECRET=<secret>
ENCRYPTION_KEY=<secret>
AUTH_SECRET=<secret>

# Shared secret for the Strapi → Next.js revalidation webhook.
# Generate with: openssl rand -hex 32
REVALIDATE_SECRET=<secret>

MS_TENANT_ID=<your-tenant-id>
MS_CLIENT_ID=<your-client-id>
MS_CLIENT_SECRET=<your-client-secret>
```

Update Entra ID redirect URIs:

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

`deploy.sh` does, in order: (1) pre-deploy Postgres + uploads backup, (2) tags the
currently running `infra-web` / `infra-cms` images as `:rollback`, (3) rebuilds +
restarts the stack with the Traefik override, (4) curl smoke-checks
`https://sinnlos.yurtbay.dev` (override with `SMOKE_URL=`). It is `set -euo
pipefail` and re-run safe.

### 3.7 Enable auto-restart on reboot

Docker containers already have `restart: unless-stopped`. If Docker itself isn't
running on boot:

```bash
systemctl enable docker
systemctl start docker
```

### 3.8 Updates

On the Traefik host (mode B), pull and re-run the wrapper — it backs up and
rollback-tags before rebuilding:

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

Either way this is a rolling restart — Postgres and existing volumes are
untouched. For the manual production-safe sequence (and rollback), see the
[update procedure](#74-update-procedure-production-safe).

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
  `Permissions-Policy`, and HSTS (`max-age=31536000; includeSubDomains; preload`).
- **Rate limiting** guards brute-force / floods, again at Traefik
  (rateLimit middleware, **not** an IP allowlist): a general limit on the web
  router (avg 100/s, burst 50) and a stricter one on the cms router covering
  `/api/auth` + `/admin` (avg 30/s, burst 15).

> For a standalone Caddy box (mode A) these headers/limits are **not** applied —
> Caddy only does TLS + routing here. Add equivalent directives to the Caddyfile
> or front the box with your own proxy if you need them.

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
# Edit .env with your domain, secrets and MS_ credentials (see §3.5)
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
      "MS_CLIENT_ID=<client-id>" \
      "MS_CLIENT_SECRET=<client-secret>" \
      "MS_TENANT_ID=<tenant-id>"
```

> **Note on `WEB_INTERNAL_URL`:** the CMS also needs this to call the Next.js
> revalidation webhook, but the web app's FQDN only exists after it's deployed.
> We set it in a follow-up step at the end of section 5.7.

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
      "AUTH_MICROSOFT_ENTRA_ID_ID=<client-id>" \
      "AUTH_MICROSOFT_ENTRA_ID_SECRET=<client-secret>" \
      "AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0"

# Now read the FQDN assigned to the web app
WEB_FQDN=$(az containerapp show \
  --name web-sinnlos --resource-group rg-sinnlos \
  --query "properties.configuration.ingress.fqdn" -o tsv)

echo "Web app URL: https://$WEB_FQDN"

# Update env vars on the web app with the real URL
az containerapp update \
  --name web-sinnlos --resource-group rg-sinnlos \
  --set-env-vars \
      "AUTH_URL=https://$WEB_FQDN" \
      "NEXT_PUBLIC_APP_URL=https://$WEB_FQDN"

# Back-fill WEB_INTERNAL_URL on the CMS so its lifecycle hooks can
# reach the Next.js /api/revalidate webhook. Traffic between the two
# Container Apps stays inside the environment's virtual network even
# though we're using the public FQDN.
az containerapp update \
  --name cms-sinnlos --resource-group rg-sinnlos \
  --set-env-vars "WEB_INTERNAL_URL=https://$WEB_FQDN"
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

## Revalidation Webhook

Strapi content changes flow to the frontend immediately via a lightweight
webhook instead of waiting for the Next.js ISR cache to expire (30–60s).

**Flow:**

```
┌──────────────┐  afterCreate /      ┌──────────────────────┐
│   Strapi     │  afterUpdate /      │  Next.js             │
│   (CMS)      │  afterDelete    →   │  POST /api/revalidate │
│              │  lifecycle hooks    │  (revalidateTag)     │
└──────────────┘                     └──────────────────────┘
     `revalidate()` helper                 `x-revalidate-secret`
     uses WEB_INTERNAL_URL                 header must match
     + REVALIDATE_SECRET                   REVALIDATE_SECRET
```

**Env vars on both services:**

| Var                  | On CMS | On Web | Purpose                                              |
| -------------------- | :----: | :----: | ---------------------------------------------------- |
| `REVALIDATE_SECRET`  |   ✓    |   ✓    | Shared bearer-style secret; must match on both sides |
| `WEB_INTERNAL_URL`   |   ✓    |   —    | How the CMS reaches Next.js (e.g. `http://web:3000`) |

**Generate the secret once:**

```bash
openssl rand -hex 32
```

Paste the same value into both services' env files.

**Graceful fallback:** if either variable is unset, the CMS helper at
`apps/cms/src/utils/revalidate.ts` silently skips the webhook call —
the app still works, but edits take up to 60s to appear on the frontend
(the normal ISR timer). The `/api/revalidate` endpoint also refuses
requests whose header doesn't match, so a mismatched pair fails closed.

**Affected content types:** announcement, department, team, wiki-space,
wiki-page — each has a `lifecycles.ts` that calls `revalidate([...tags])`
with the cache tags defined in `apps/web/src/lib/strapi.ts`.

Wiki endpoints bypass the Next.js fetch cache entirely (`cache: 'no-store'`)
because the `wiki-visibility` policy filters results per user; caching by
URL alone would leak restricted pages across users. The webhook is
therefore a no-op for those tags, but still invalidates the non-wiki
content tags when wiki pages touch related data.

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

# Strapi API responds
curl -I <URL>/api/departments
# Expect: HTTP/1.1 200 OK (or 401 if the endpoint requires auth)

# Strapi admin loads
curl -I <URL>/admin
# Expect: HTTP/1.1 200 OK
```

### 6.2 Content bootstrap

1. Open `<URL>/admin` → create your first Strapi admin user.
2. **Settings → Users & Permissions plugin → Roles** — confirm all six roles
   exist: `admin_role`, `editor`, `department_head`, `team_lead`, `member`, `guest`.
3. **Content Manager → Department → Create new entry** — create a test
   department (name: "Engineering", slug: "engineering"), publish.
4. Open `<URL>/departments` → the test department should render.

### 6.3 Microsoft sign-in flow

1. Open `<URL>/` → you should be redirected to `/sign-in`.
2. Click **Sign in with Microsoft** → complete the OIDC flow.
3. You should land on the dashboard with your display name in the top-right.
4. In Strapi admin → **Content Manager → User** — confirm your account was
   auto-created with `microsoftOid`, `displayName`, and an assigned role.

### 6.4 Role enforcement (optional)

As a non-admin user, try to edit a wiki page you don't own via the Strapi API:

```bash
curl -X PUT <URL>/api/wiki-pages/1 \
  -H "Authorization: Bearer <your-strapi-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"data":{"title":"Hijacked"}}'
# Expect: 403 Forbidden
```

### 6.5 Common failure signals

| Symptom | Likely cause |
|---|---|
| `/admin` returns 502 for 60+ seconds | Strapi still building admin panel — wait and check `docker compose logs -f cms` |
| `/sign-in` redirects loop | `AUTH_URL` doesn't match the host header — check env vars |
| MS login `AADSTS50011` | Redirect URI missing in Entra app registration — go back to Step 5 and add it |
| MS login succeeds but lands on a Strapi error page | Strapi users-permissions Microsoft provider not enabled or `MS_*` env vars not set |
| Dashboard shows "0 departments" even after creating one | Strapi permissions — confirm `public` role has `find` access to departments, OR you're signed in |

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

# 2. Pull latest code
cd /opt/sinnlos && git pull

# 3. Rebuild and restart (rolling, no data loss)
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

The Dockerfiles use `pnpm install --frozen-lockfile=false`, so a locally-edited
lockfile will still install — but committing the updated lockfile keeps builds
reproducible.

**Caddy "certificate authority not found" on localhost**

For local Docker, use `http://localhost` — don't use HTTPS for `localhost` without
a local CA. The Caddyfile's `{$DOMAIN:localhost}` block serves HTTP on localhost
automatically.

**Microsoft sign-in returns "AADSTS50011: The redirect URI does not match"**

The redirect URI in your Entra app registration must match exactly (including
trailing slash) what Auth.js and Strapi send. Add both:
- `<WEB_URL>/api/auth/callback/microsoft-entra-id`
- `<CMS_URL>/api/connect/microsoft/callback`

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
