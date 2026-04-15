# Deployment Guide

This guide walks through every supported deployment method for **Sinnlos Intranet**.

| Method | Best for |
|---|---|
| [Bare-metal local](#1-bare-metal-local-development) | Day-to-day development, quick feature testing |
| [Docker local](#2-docker-local-full-stack) | Full-stack smoke tests before deploying |
| [VPS (any provider)](#3-vps-deployment) | Self-hosted production on any Linux VM |
| [Azure (VM)](#4-azure-vm-deployment) | Production on Azure using the same Docker Compose approach |
| [Azure (Container Apps)](#5-azure-container-apps-advanced) | Cloud-native, autoscaling, no VM management |

All methods share the same [prerequisites](#prerequisites) and
[Microsoft Entra ID setup](#microsoft-entra-id-app-registration) — do those first.

---

## Prerequisites

Install these on any machine you are deploying **from**:

| Tool | Minimum version | Install |
|---|---|---|
| Node.js | 20.11 LTS | [nodejs.org](https://nodejs.org) |
| pnpm | 9.x | `corepack enable && corepack prepare pnpm@9.12.0 --activate` |
| Git | any recent | system package manager |
| Docker + Docker Compose | Docker 24 / Compose v2 | [docs.docker.com](https://docs.docker.com/get-docker/) |
| Azure CLI *(Azure only)* | 2.60 | [learn.microsoft.com/cli/azure/install](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) |

Check versions:

```bash
node -v          # v20.x.x
pnpm -v          # 9.x.x
docker -v        # Docker version 24.x.x
docker compose version  # Docker Compose version v2.x.x
```

---

## Microsoft Entra ID App Registration

Sinnlos uses **Microsoft Entra ID (formerly Azure AD)** for SSO. You need one
app registration and you'll reference it in every deployment method.

### Step 1 — Create the app registration

1. Open [portal.azure.com](https://portal.azure.com) → search **App registrations** → **New registration**.
2. **Name**: `Sinnlos Intranet` (or any name you prefer).
3. **Supported account types**: *Accounts in this organizational directory only* (single-tenant).
4. Leave Redirect URI blank for now → **Register**.

### Step 2 — Copy the IDs

On the app overview page, copy:

- **Application (client) ID** → this is `MS_CLIENT_ID`
- **Directory (tenant) ID** → this is `MS_TENANT_ID`

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

**`apps/cms/.env`** — fill in:

```dotenv
DATABASE_CLIENT=sqlite        # easiest for local dev (no Postgres needed)
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
```

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

Runs Postgres + Strapi + Next.js + Caddy in containers, exactly as production.
Requires Docker Desktop (Mac/Windows) or Docker Engine (Linux).

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

```bash
cd /opt/sinnlos/infra
docker compose up -d --build
```

Caddy automatically requests a **Let's Encrypt TLS certificate** for your domain.
Wait ~30 seconds, then visit **https://intranet.example.com**.

### 3.7 Enable auto-restart on reboot

Docker containers already have `restart: unless-stopped`. If Docker itself isn't
running on boot:

```bash
systemctl enable docker
systemctl start docker
```

### 3.8 Updates

```bash
cd /opt/sinnlos
git pull
cd infra
docker compose up -d --build
```

This performs a rolling restart — Postgres and existing volumes are untouched.

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

```bash
# Make the dynamic IP static so it survives VM restarts
az network public-ip update \
  --resource-group rg-sinnlos \
  --name vm-sinnlosPPublicIP \
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
  --public-access 0.0.0.0
```

Note the hostname: `db-sinnlos.postgres.database.azure.com`.

### 5.5 Deploy the CMS container

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
      "APP_KEYS=<secret>,<secret>" \
      "API_TOKEN_SALT=<secret>" \
      "ADMIN_JWT_SECRET=<secret>" \
      "TRANSFER_TOKEN_SALT=<secret>" \
      "JWT_SECRET=<secret>" \
      "ENCRYPTION_KEY=<secret>" \
      "MS_CLIENT_ID=<client-id>" \
      "MS_CLIENT_SECRET=<client-secret>" \
      "MS_TENANT_ID=<tenant-id>"
```

### 5.6 Deploy the Web container

```bash
# Get the internal CMS URL
CMS_URL=$(az containerapp show \
  --name cms-sinnlos \
  --resource-group rg-sinnlos \
  --query "properties.configuration.ingress.fqdn" -o tsv)

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
      "NEXT_PUBLIC_APP_URL=https://web-sinnlos.<env-default-domain>" \
      AUTH_TRUST_HOST=true \
      "AUTH_SECRET=<secret>" \
      "AUTH_MICROSOFT_ENTRA_ID_ID=<client-id>" \
      "AUTH_MICROSOFT_ENTRA_ID_SECRET=<client-secret>" \
      "AUTH_MICROSOFT_ENTRA_ID_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0"
```

The web app gets a public FQDN (`*.azurecontainerapps.io`). Add a custom domain
via **Container Apps → Custom domains** and Azure will provision a managed TLS
certificate automatically.

### 5.7 Update images after a code change

```bash
docker build -f apps/web/Dockerfile -t acrsinnlos.azurecr.io/sinnlos-web:latest . \
  && docker push acrsinnlos.azurecr.io/sinnlos-web:latest

az containerapp update \
  --name web-sinnlos \
  --resource-group rg-sinnlos \
  --image acrsinnlos.azurecr.io/sinnlos-web:latest
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

The build step in the Dockerfile runs `pnpm install --frozen-lockfile`. If you
recently changed `pnpm-lock.yaml` locally, commit and push the updated lockfile
before building.

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
