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

All methods share the same [prerequisites](#prerequisites); the optional
[Microsoft Entra ID sign-in](#microsoft-entra-id-sign-in) is off by default
(`ENTRA_ENABLED=1` switches it on) and set up the same way for each.

> **Upgrading an existing instance?** On an instance that runs `main`
> `03d4ea0` (batch 8), batch 9 (the policy primitives, the live contract
> and poll documentIds, and the optional Entra sign-in, switched off) is
> one normal deploy of cms and web together with `ENTRA_ENABLED` unset,
> with read-only checks before and after it: follow
> [Deploying batch 9 (2026-09-28)](#deploying-batch-9-2026-09-28). Its first
> boot adds four empty user columns and one index and revokes the anonymous
> forgot/reset-password endpoints; nothing else in the database changes,
> and a rollback re-ups both images, never one alone.
> On an instance that runs `main`
> `c219034` (batch 7; the owner instance since 2026-09-28 15:03 CEST),
> batch 8 is one normal deploy of cms and web together, with read-only
> checks before and after it: follow
> [Deploying batch 8 (2026-09-28)](#deploying-batch-8-2026-09-28). No
> schema or permission change; check `SMTP_PORT` and `DIGESTS_DISABLED`
> in `infra/.env` first, and a rollback re-ups both images, the web with
> `-f infra/docker-compose.web-legacy-tz.yml`. On an instance that runs
> `main` `a88d45a` (batch 6), batch 7 comes first, in a deploy of its
> own (the web's switch to UTC should not share a deploy with it), again
> one normal deploy of cms and web together with read-only checks before
> and after it: follow
> [Deploying batch 7 (2026-09-28)](#deploying-batch-7-2026-09-28). Its first
> boot adds one permission and one nullable column by itself; never deploy
> or roll back the cms or the web alone. On an instance that runs `main`
> `afc1506`, batch 6 comes first or in the same deploy (the batch 6 note
> in [3.8 Updates](#38-updates), with its optional poll query
> of the
> [cms input hardening (2026-09-28)](#upgrading-to-the-cms-input-hardening-2026-09-28)).
> On an instance that already runs the
> datetime release (the owner instance since 2026-09-27), the current release
> is a normal deploy with read-only checks first. Work through the notes of
> what the instance does not run yet, newest first: batch 9, batch 8, batch 7, batch 6,
> [Upgrading to poll department targeting](#upgrading-to-poll-department-targeting)
> (read-only checks before the deploy; polls that have departments become
> visible to those departments' members only, plus admins and editors, and
> **guests no longer see any poll** until an admin or editor turns on
> "Visible to guests" for it) and
> [Upgrading to the ICS and cms start fixes (2026-09-27)](#upgrading-to-the-ics-and-cms-start-fixes-2026-09-27)
> (the checks after the deploy and the rollback note). Deploying all of them
> up to batch 7 together is one normal deploy plus the read-only pre-deploy
> queries of the poll targeting note, the optional poll query of the cms
> input hardening and the checks of batch 7; batch 8 follows once batch 7
> runs. Coming from an older release,
> work through the datetime runbook,
> [Upgrading an existing instance to this release](#upgrading-an-existing-instance-to-this-release),
> before you deploy: the datetime release introduces the
> [datetime contract](#310-datetime-contract): the cms runs in UTC, every
> stored instant becomes `timestamptz`, and the **first boot repairs the times
> the old cms stored**, once. An existing database needs
> `DATETIME_LEGACY_ZONE` (and on some instances `DATETIME_LEGACY_UTC_UNTIL`) in
> `infra/.env`; the new cms refuses to start without it, and `infra/deploy.sh`
> refuses to deploy. Coming from a release before 2026-09-26, also work through
> the older notes, newest first:
> [Upgrading to the draft-twin repair (FX38)](#upgrading-to-the-draft-twin-repair-fx38)
> (a normal deploy; the first boot creates the missing draft rows),
> [One-time: org draft/publish off](#one-time-org-draftpublish-off) (a
> database with department or team drafts needs a one-time migration first),
> [Upgrading to the Strapi 5.55.1 release (2026-09-25)](#upgrading-to-the-strapi-5551-release-2026-09-25)
> (additive database changes; **Microsoft sign-in stops working**, so an
> instance that uses it must stay on its current release until it moves to
> the [Entra sign-in](#microsoft-entra-id-sign-in) of batch 9) and
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

## Microsoft Entra ID sign-in

Sinnlos signs users in with e-mail and password (local sign-in) by default.
**Microsoft Entra ID** (formerly Azure AD) single sign-on is optional and
**off unless `ENTRA_ENABLED=1`** is set; without it every `MS_*` and
`ENTRA_*` value is ignored (leftover `MS_*` lines in `infra/.env` only earn
a note from `infra/deploy.sh`, or a warning when they are a real app
registration; see [the upgrade notes](#upgrading-to-the-entra-sign-in-batch-9-lane-4a)).
The owner's instance runs without it.

How it works (D-ENTRA-01): Auth.js runs the OIDC code flow against exactly
one tenant. The web then POSTs the ID token and the Graph access token to the
cms (`POST /api/auth/entra/exchange`, server to server, authenticated by
`ENTRA_EXCHANGE_SECRET`). The cms verifies the ID token itself against the
tenant's signing keys, reads Graph `/me`, finds the user by **tenant id +
object id** (backed by a unique index, never by e-mail), creates new users on
the spot with the role of their **app role**, syncs the Entra-owned profile,
and answers with a Strapi JWT that lasts `ENTRA_SESSION_TTL` (12 hours by
default). The web session ends with that JWT, and every sign-in re-syncs
roles and profile. The cms therefore needs outbound HTTPS to
`login.microsoftonline.com` (signing keys) and `graph.microsoft.com`;
without it Microsoft sign-ins fail with *entra_unavailable* and local
sign-in is unaffected.

### Step 1 — Create the app registration

1. Open the [Microsoft Entra admin center](https://entra.microsoft.com) →
   **App registrations** → **New registration**.
2. **Name**: `Sinnlos Intranet` (or any name).
3. **Supported account types**: *Accounts in this organizational directory
   only* (single tenant). Multi-tenant registrations are not supported: the
   apps refuse `common`, `organizations` and `consumers`.
4. **Redirect URI** (platform *Web*):
   `${WEB_PUBLIC_URL}/api/auth/callback/microsoft-entra-id`, for example
   `https://intranet.example.com/api/auth/callback/microsoft-entra-id` (and
   `http://localhost:3000/...` for local development). There is **no** cms
   redirect URI: Strapi's own Microsoft provider is not used and is forced
   off at every boot.
5. **Register**. On the overview page copy the **Directory (tenant) ID**
   (`MS_TENANT_ID`) and the **Application (client) ID** (`MS_CLIENT_ID`),
   both GUIDs.

### Step 2 — Sign-out redirect URI

**Authentication** → platform **Web** → **Add URI**:
`${WEB_PUBLIC_URL}/sign-in`, a second redirect URI next to the callback of
step 1 (and `http://localhost:3000/sign-in` for local development). *Sign
out* ends the intranet session, then sends Microsoft users to
`https://login.microsoftonline.com/<tenant>/oauth2/v2.0/logout` with
`post_logout_redirect_uri=${WEB_PUBLIC_URL}/sign-in`, which ends their
Microsoft session as well. Microsoft only sends them back to that address
when it is one of the app's registered redirect URIs; without it they stay
on Microsoft's generic "You signed out" page (the intranet session is gone
either way).

Leave the **Front-channel logout URL** empty. It is a different mechanism
(single sign-out: Microsoft calls it when the user signs out of *another*
app), which Sinnlos does not implement: signing out elsewhere does not end
an intranet session, `ENTRA_SESSION_TTL` does.

### Step 3 — Client secret

**Certificates & secrets** → **New client secret** → set an expiry → copy the
**Value** (shown only once) → `MS_CLIENT_SECRET`. Only the web uses it; the cms
never needs it. Note the expiry date: an expired secret makes every Microsoft
sign-in fail at the token step.

### Step 4 — API permissions

**API permissions** → **Add a permission** → **Microsoft Graph** →
**Delegated**:

| Permission | Why |
|---|---|
| `openid`, `profile`, `email` | The OIDC sign-in and its ID token |
| `User.Read` | Graph `/me` (display name, job title, department, office, phone, member or guest) and `/me/checkMemberGroups` for `ENTRA_GROUP_ROLES` |
| `User.Read.All` | **Only with `ENTRA_SYNC_MANAGER=1`**: `/me/manager` |

Then **Grant admin consent for \<tenant\>**. `GroupMember.Read.All` (the old
group-name mapping) is not needed; remove it from existing registrations.

### Step 5 — App roles and assignment

**App roles** → **Create app role**, six times, *Allowed member types*:
*Users/Groups*:

| Value | Intranet role |
|---|---|
| `Intranet.Admin` | `admin_role` |
| `Intranet.Editor` | `editor` |
| `Intranet.DepartmentHead` | `department_head` |
| `Intranet.TeamLead` | `team_lead` |
| `Intranet.Member` | `member` |
| `Intranet.Guest` | `guest` |

Then **Enterprise applications** → the app → **Properties** → *Assignment
required?* = **Yes** (recommended: without it every member of the tenant can
sign in, with `ENTRA_DEFAULT_ROLE`) → **Users and groups** → assign the roles
to users, or to security groups (needs Entra ID P1; nested groups are **not**
expanded). Never assign public Microsoft 365 groups or Teams to a privileged
role: their members can add themselves. The roles arrive in the signed ID
token; a user with several gets the highest. Use `ENTRA_GROUP_ROLES` only for
nested groups or tenants without P1 (it asks Graph `/me/checkMemberGroups`
for up to 20 group object ids; group names never count).

### Step 6 — Configuration

Set these in `infra/.env` (compose hands each app the keys it reads); for
bare-metal development put the cms keys into `apps/cms/.env` and the web keys
(`AUTH_MICROSOFT_ENTRA_ID_TENANT_ID`, `AUTH_MICROSOFT_ENTRA_ID_ID`,
`AUTH_MICROSOFT_ENTRA_ID_SECRET`, `ENTRA_ENABLED`, `ENTRA_EXCHANGE_SECRET`,
`ENTRA_SYNC_MANAGER`) into `apps/web/.env.local`:

| Name | Default | Effect |
|---|---|---|
| `ENTRA_ENABLED` | 0 | Master switch for cms and web. With anything but `1`, Entra is fully off and `MS_*` values are ignored. With `1`, the config is validated and an invalid one refuses the start (the cms at boot, the web on its first request) and the deploy (`infra/deploy.sh --check`), naming the variable. |
| `MS_TENANT_ID` | (unset) | Tenant GUID (required). Web: `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID`; the issuer is computed from it. |
| `MS_CLIENT_ID` | (unset) | Application (client) GUID (required); the cms checks the ID token's audience against it. Web: `AUTH_MICROSOFT_ENTRA_ID_ID`. |
| `MS_CLIENT_SECRET` | (unset) | Web only (`AUTH_MICROSOFT_ENTRA_ID_SECRET`, required). |
| `ENTRA_EXCHANGE_SECRET` | (unset) | At least 32 characters, the same for web and cms (`openssl rand -hex 32`); distinct from every other secret. |
| `ENTRA_SYNC_MODE` | dry-run | cms. `on` applies Entra's roles and departments. `dry-run` logs them, never changes an existing user, and creates new users at most as `member`. |
| `ENTRA_DEFAULT_ROLE` | member | cms. Role of tenant members with no recognised app role or group: `member`, `guest` or `deny`. Unassigned B2B guests are always refused. |
| `ENTRA_GROUP_ROLES` | (empty) | cms, optional. `<roleType>:<groupObjectId>,…`, at most 20 groups (see step 5). |
| `ENTRA_SYNC_DEPARTMENT` | 0 | cms. `1` sets the user's department to the one published department whose name equals Entra's `department` (case-insensitive); an empty value, no match or several matches clear it, so access does not survive a move. Only admins and editors can rename departments. |
| `ENTRA_SYNC_MANAGER` | 0 | cms and web. `1` requests `User.Read.All` (admin consent) and syncs the manager from `/me/manager`; a manager who has not signed in yet is linked on their first sign-in. |
| `ENTRA_SESSION_TTL` | 12h | cms. Lifetime of an Entra sign-in's session, `<n>m`, `<n>h` or `<n>d`, at most `7d`. Local sign-ins keep 7 days. |
| `AUTH_LOCAL_ENABLED` | 0 | Web and cms. `1` keeps local e-mail + password sign-in next to Microsoft (break-glass admin account). Without Entra, local sign-in is always on. |
| `LOCAL_REGISTRATION` | 0 | Unchanged: local self-registration only; it does not affect Entra users. Next to Entra it logs one warning at boot: a registered address is not verified, so check such an account before binding it ([the 409 procedure](#an-e-mail-address-that-already-has-an-account-409)). |

The cms logs one line at every boot: `[entra] disabled`, or
`[entra] enabled tenant=<guid> mode=<on|dry-run> default=<role> groupRules=<n>
syncDepartment=<0|1> syncManager=<0|1> ttl=<ttl> local=<0|1>`.

### What Entra owns

- **Identity**: tenant id + object id, stored in the private user fields
  `entraTenantId` and `microsoftOid`. A new user's username is
  `entra-<object id>`, the e-mail is `mail` (else the UPN), and `provider` is
  `microsoft`; such accounts have no password.
- **Role**, per user (`roleSource`, private): users the sign-in created are
  `entra` and follow Entra at every sign-in (also downwards). Every account
  that existed before is `manual`, and so is every account whose role an
  admin changes in the admin panel (detected at the next sign-in): the
  sign-in never touches a manual role, and a manual user is not refused for
  a missing assignment. A Graph failure never changes any role. To hand a
  user back to Entra, set *Role source* = `entra` and clear *Entra applied
  role* on the user; the next sign-in applies Entra's role.
- **Profile**: display name (only overwritten with a non-empty value), job
  title, phone (first business phone) and office location are copied from
  Entra at every sign-in (an empty value clears them; a value over 255
  characters is cut to 255, the column size, e.g. Entra's 256-character
  display names) and are read-only on
  `/profile` (`PUT /api/me` ignores them). Accounts the sign-in created also
  get their e-mail from Entra, unless another account uses that address.
- **Department** and **manager** only with `ENTRA_SYNC_DEPARTMENT=1` /
  `ENTRA_SYNC_MANAGER=1` (table above).
- **Blocking** a user in the admin panel takes effect on their next request
  (Strapi refuses a blocked user's JWT) and refuses their next sign-in
  (*entra_blocked*). Offboarding in Entra takes effect at the latest when
  the session ends (`ENTRA_SESSION_TTL`).

### Staging dry-run, then on

1. Configure a staging instance with `ENTRA_ENABLED=1` and
   `ENTRA_SYNC_MODE=dry-run` (the default), on its own host or behind its
   own Traefik, never behind the production one
   ([§3.6 B](#b-shared-traefik-live-production-layout)); run `infra/deploy.sh --check`
   until it prints `Preflight OK`, then deploy with `SMOKE_URL` and
   `BASE_URL` set to the staging address (both default to the owner's
   site, [§3.6 B](#b-shared-traefik-live-production-layout)). The cms logs
   `[entra] enabled … mode=dry-run`.
   `infra/deploy.sh` ends with `infra/live-smoke.sh`, which signs in with
   local demo accounts. On an Entra-only instance (`ENTRA_ENABLED=1`
   without `AUTH_LOCAL_ENABLED=1`, as the web container runs) live-smoke
   runs its datetime check, then prints `live-smoke: SKIPPED the sign-in
   steps: Entra-only instance …` and passes; `deploy.sh` runs it there
   even without the demo credentials file. Check the live pings in a
   browser instead: a comment from a second session refreshes the card in
   the first. This holds for every deploy of an Entra-only instance, step 5
   included. (Before batch 10 the sign-in failed and with it the deploy;
   the workaround was `PASSWORDS_FILE=/nonexistent infra/deploy.sh`, or
   keeping `AUTH_LOCAL_ENABLED=1` for the break-glass account, see
   [the rollback notes](#rolling-back-after-switching-microsoft-sign-in-on),
   step 3.)
2. Let a few users sign in: an app-role user, a user in an
   `ENTRA_GROUP_ROLES` group (if used), a B2B guest without and then with
   `Intranet.Guest`, a user without a manager, a user whose Entra department
   matches no published department (with `ENTRA_SYNC_DEPARTMENT=1`).
3. Review the audit lines, one per sign-in, without tokens:

   ```bash
   docker logs infra-cms-1 2>&1 | grep '\[entra\]'
   ```

   `[entra] user=<id|new> oid=<first 8> result=<created|existing|conflict|denied|blocked|unavailable> role=<…> via=<approle:X|group:<guid>|default> mode=dry-run graph=me:ok,groups:…,manager:…`,
   plus `department=` / `manager=` when those syncs are on. In dry-run,
   `role=would member->editor` or `role=new->member would new->admin_role`
   shows what `on` would do; nothing is changed for existing users.
4. Sign out as a Microsoft user: the browser passes Microsoft's sign-out and
   lands on `/sign-in`. Staying on Microsoft's "You signed out" page means
   `${WEB_PUBLIC_URL}/sign-in` is missing from the redirect URIs (step 2).
5. Switch to `ENTRA_SYNC_MODE=on` and deploy. The next sign-in of each user
   applies the role (`role=member->editor`); new users get their full role.
6. Check a manual override: change a user's role in the admin panel, sign
   them in again: `role=manual-override`, and the role stays.
7. Then production, the same way (dry-run first if it holds existing users).

### Rolling back after switching Microsoft sign-in on

Every cms boot of this release writes the sign-in providers into Strapi's
database (the users-permissions *grant* store): e-mail sign-in on exactly
when local sign-in is (`AUTH_LOCAL_ENABLED=1`, or Entra off), and Strapi's
own Microsoft provider off with its client id and secret cleared. An older
cms image does not write them back.

1. **Prefer the env rollback.** Set `ENTRA_ENABLED=0` (Microsoft off, local
   sign-in on) or `AUTH_LOCAL_ENABLED=1` (both) in `infra/.env` and deploy
   again (`infra/deploy.sh`). The cms of this release restores e-mail
   sign-in at its next boot.
2. **An image rollback to a cms from before batch 9** after running with
   `ENTRA_ENABLED=1` and `AUTH_LOCAL_ENABLED` unset keeps e-mail sign-in
   **off** (`This provider is disabled`): nobody can sign in, and the old
   5.49 Microsoft flow is off as well, its client id and secret cleared.
   The web needs a change as well: a web from before batch 9 decides local
   sign-in from `MS_CLIENT_ID` and `MS_CLIENT_SECRET`, not from
   `ENTRA_ENABLED`. With both set and `AUTH_LOCAL_ENABLED` not `1` it hides
   the e-mail form and shows only a Microsoft button, which cannot complete
   against a cms on Strapi 5.55.1 (batch 8 and every release since
   2026-09-25). The simplest order:
   1. Set `AUTH_LOCAL_ENABLED=1` in `infra/.env`. (Rolling back to batch 8
      or another release since 2026-09-25, deleting `MS_CLIENT_ID` and
      `MS_CLIENT_SECRET` works as well and also hides that button; for the
      old 5.49 flow keep them.)
   2. Restart only the cms of this release on it, **not** with
      `infra/deploy.sh`: a re-run rebuilds and redeploys web and cms (and,
      before batch 10, tagged the running images `:rollback`, replacing
      the images you want to go back to). From the checkout:
      `docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml up -d --no-build cms`
      (on a standalone Caddy box, drop the second `-f`). Its boot turns
      e-mail sign-in back on and logs `[bootstrap] users-permissions
      providers synced (email=on, microsoft=off)`.
   3. Roll both images back to the pair you are going back to, then
      `up -d --no-build web cms` (with the overrides the target needs,
      [§7.4](#74-update-procedure-production-safe)). From the first
      recorded batch-10 deploy on, `deploy.sh` no longer moves `:rollback`:
      the target its rollback hint names is the last-known-good SHA tag
      (`grep '^TAG=' .git/sinnlos-deploy/infra.state`, then
      `docker tag infra-web:<sha> infra-web:latest` and the same for the
      cms), and an older release is one of the SHA tags
      `docker images infra-web` still lists. `:rollback` names the images
      that ran before the first deploy with the batch-10 `deploy.sh`; use
      it only for those, or before that first deploy was recorded. E-mail
      sign-in works in the cms and the web shows its form.

   Rolled back without that cms restart, the old cms keeps e-mail sign-in
   off: re-enable it in the Strapi admin panel (its admin accounts are not
   affected): **Settings → Users & Permissions plugin → Providers →
   Email** → *Enable* on → *Save*; the web still needs
   `AUTH_LOCAL_ENABLED=1`. For the old Microsoft flow of a 5.49 image also
   open **Microsoft** there, turn it on and enter its client id and secret
   again (this release cleared them).
3. For the first rollout (the employer migration) keep a break-glass local
   account: `AUTH_LOCAL_ENABLED=1` and one local admin user whose password
   is known, until Microsoft sign-in has worked for a while. Then the
   provider store keeps e-mail sign-in on, and step 2 is only needed for
   the old Microsoft flow.

### An e-mail address that already has an account (409)

A new Microsoft identity whose e-mail address (case-insensitive) an existing
account already uses is **not** linked automatically (that would let
whoever controls the address take the account over). The sign-in page says
*"An intranet account with your e-mail address already exists"*, and the
cms logs `result=conflict`. Binding hands that account, with everything
it holds, to the Microsoft user. An admin:

1. **checks whose account it is.** Bind only an account you know belongs
   to this person: one an admin created for them, or one they have used
   themselves. The cms never verifies the address of a self-registered
   account: with `LOCAL_REGISTRATION=1`, now or at any earlier time,
   anyone could have registered the address first. Do not bind such an
   account while you cannot confirm its owner; **delete it** instead
   (**Content Manager → User** → the user → *Delete*). The cms refuses
   the sessions of a deleted user at their next request, and the next
   Microsoft sign-in creates a fresh account;
2. looks up the user's **Object ID** in the Entra admin center (*Users* →
   the user → *Overview*) and the tenant's **Directory (tenant) ID**;
3. opens the existing user in the Strapi admin (**Content Manager → User**)
   and sets **entraTenantId** and **microsoftOid** to those two GUIDs, in
   **lower case**, then saves;
4. asks the user to sign in with Microsoft again.

User id, password, provider, e-mail and role stay as they were; the role
stays **manual** until an admin sets *Role source* = `entra`, and the
Entra-owned profile fields are synced from then on (and read-only on
`/profile`). The binding ends nothing that existed before it: the kept
password still signs in while `AUTH_LOCAL_ENABLED=1`, and sessions issued
earlier stay valid until they expire (7 days; a password change does not
end them either). So when anyone else might know the password, set a new
one on the user in the same Content Manager form (or have the owner change
it on `/profile` after a local sign-in). A row with a `microsoftOid` but
no `entraTenantId` (from an old release or a self-registration) is never
trusted.

### Sign-in errors

| The sign-in page says | Cause |
|---|---|
| *belongs to another organisation* (`entra_tenant`) | An account of another tenant; Auth.js' own issuer check usually refuses it earlier |
| *already exists* (`entra_account_exists`) | See the 409 procedure above |
| *has no access* (`entra_not_assigned`) | No app role and `ENTRA_DEFAULT_ROLE=deny`, or a B2B guest without `Intranet.Guest` |
| *is blocked* (`entra_blocked`) | The account is blocked in the admin panel |
| *could not be verified* (`entra_invalid`) | The ID token was refused (clock skew over 5 minutes, another app's token) or Graph `/me` is another user |
| *unavailable right now* (`entra_unavailable`) | The cms is unreachable or cannot reach Microsoft, the two `ENTRA_EXCHANGE_SECRET` values differ (the web logs it), `ENTRA_ENABLED` is not `1` for the cms, or a new user's role could not be decided because the Graph group check failed |

A failed database write shows in the cms log as `[entra] exchange failed (<code>)`
(the sign-in answered *unavailable*) or `[entra] user=<id>: <step> failed (<code>)`
(an optional profile, department or manager write; the sign-in went on).
`<code>` is a Postgres SQLSTATE such as `22001` (value too long), a SQLite or
Node error code, or an error class name; the SQL and the profile values are
never logged.

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

# Optional Microsoft sign-in (off unless ENTRA_ENABLED=1; see "Microsoft
# Entra ID sign-in" above). The cms never needs the client secret.
# ENTRA_ENABLED=1
# MS_TENANT_ID=<your-tenant-guid>
# MS_CLIENT_ID=<your-client-guid>
# ENTRA_EXCHANGE_SECRET=<openssl rand -hex 32, same as the web>
# ENTRA_SYNC_MODE=dry-run

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
# Optional Microsoft sign-in (off unless ENTRA_ENABLED=1; local sign-in is
# on by itself without it). The issuer is computed from the tenant GUID.
# ENTRA_ENABLED=1
# AUTH_MICROSOFT_ENTRA_ID_TENANT_ID=<your-tenant-guid>
# AUTH_MICROSOFT_ENTRA_ID_ID=<your-client-guid>
# AUTH_MICROSOFT_ENTRA_ID_SECRET=<your-client-secret>
# ENTRA_EXCHANGE_SECRET=<same value as the cms>
# AUTH_LOCAL_ENABLED=1   # keep e-mail + password next to Microsoft

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
   boot once with `SEED_DEMO_DATA=1` for demo users. With `ENTRA_ENABLED=1`
   (both apps), *Sign in with Microsoft* works too (see
   [Microsoft Entra ID sign-in](#microsoft-entra-id-sign-in)).
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
# Plain HTTP on port 80 for local use. DOMAIN=localhost (or unset) serves
# HTTPS with a certificate from Caddy's internal CA instead; then use
# https:// in the two URLs below.
DOMAIN=http://localhost

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

# Optional Microsoft sign-in: off unless ENTRA_ENABLED=1 (both apps then
# offer local sign-in only). See "Microsoft Entra ID sign-in" above.
# ENTRA_ENABLED=1
# MS_TENANT_ID=<your-tenant-guid>
# MS_CLIENT_ID=<your-client-guid>
# MS_CLIENT_SECRET=<your-client-secret>
# ENTRA_EXCHANGE_SECRET=<openssl rand -hex 32>

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

> **Tip:** Compose passes `DOMAIN` to Caddy as its site address. With
> `DOMAIN=http://localhost` (above) Caddy serves plain HTTP, and Entra
> redirect URIs use `http://localhost/...`. With `DOMAIN=localhost` or no
> `DOMAIN`, Caddy serves HTTPS on `localhost` with a certificate from its
> internal CA (the browser warns until you import that CA's root,
> `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`,
> into the browser or OS trust store, or accept the warning) and
> redirects HTTP to HTTPS; set both URLs to `https://localhost` then. Only a
> real host name gets a Let's Encrypt certificate (§3.6 A). Caddy sends the
> same security headers as the production Traefik, HSTS only for a real
> host name over HTTPS.

> **Time zone:** set `APP_TIME_ZONE` in `.env` if your company is not in
> `Europe/Berlin` (the default). It is the zone of every business date: "today",
> ad expiry, birthdays, digest days, the cron times, all-day events and poll
> deadlines. Do not set the containers' `TZ`: compose runs the cms and the
> web in UTC (required for the cms, see the
> [datetime contract](#310-datetime-contract)); both compute and show every
> date in `APP_TIME_ZONE`.

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
# The bare public host name (no scheme, no port): Caddy's certificate in
# mode A, every router's Host rule in mode B (§3.6). Required in mode B.
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

# Optional Microsoft sign-in: off unless ENTRA_ENABLED=1, then validated by
# infra/deploy.sh --check and at start ("Microsoft Entra ID sign-in" above;
# start with ENTRA_SYNC_MODE=dry-run).
# ENTRA_ENABLED=1
# MS_TENANT_ID=<your-tenant-guid>
# MS_CLIENT_ID=<your-client-guid>
# MS_CLIENT_SECRET=<your-client-secret>
# ENTRA_EXCHANGE_SECRET=<openssl rand -hex 32>
# ENTRA_SYNC_MODE=dry-run

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

With Microsoft sign-in, register both production redirect URIs (platform
*Web*) in the app registration (no cms redirect URI, no front-channel logout
URL):

```
https://intranet.example.com/api/auth/callback/microsoft-entra-id
https://intranet.example.com/sign-in   (where sign-out returns to)
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

Compose passes `DOMAIN` from `infra/.env` to Caddy as its site address. With
`DOMAIN` set to your public host name (and DNS plus ports 80/443 pointing at
the box) Caddy requests a **Let's Encrypt TLS certificate** for it by itself
and redirects HTTP to HTTPS. Wait ~30 seconds, then visit
**https://intranet.example.com**. Without `DOMAIN` Caddy only serves
`localhost`, with a certificate from its internal CA that browsers do not
trust: there is no Let's Encrypt certificate without a `DOMAIN`. Caddy sends
the same security headers as the Traefik layout of mode B (`nosniff`,
`Referrer-Policy`, `X-Frame-Options: DENY`, the `Permissions-Policy`, and HSTS
for a real host name over HTTPS), but has no edge rate limit
([§3.9](#39-production-hardening)).

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

**`DOMAIN` is required here.** Every router matches ``Host(`$DOMAIN`)`` from
`infra/.env`, so the overlay file is the same for every instance (it named
`sinnlos.yurtbay.dev` literally until batch 10). Set it to the bare host name,
without scheme or port, equal to the host of `WEB_PUBLIC_URL`. Without it
`docker compose` refuses to render the file
(`required variable DOMAIN is missing a value`), and `infra/deploy.sh` stops in
its preflight before anything is touched.

**Nothing checks the value itself.** Compose and `infra/deploy.sh --check`
only reject a missing or empty `DOMAIN`. A value with a scheme
(`https://…`), with a port, with a typo, or the example
`intranet.example.com` renders and passes the preflight, and then no router
matches: the whole site answers Traefik's `404 page not found`. The deploy's
smoke check fails and prints the image rollback, which does not help, because
the router rules come from `infra/.env`, not from the images. Correct
`DOMAIN` and recreate web and cms with the corrected labels:
`docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml up -d --no-build web cms`.
Before a deploy that sets or changes `DOMAIN`, check what compose renders
(it prints five times the same host, yours):

```bash
docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
  config --format json | grep -o 'Host(`[^`]*`)' | sort | uniq -c
```

The smoke checks do not follow `DOMAIN` either: `deploy.sh` curls `SMOKE_URL`
and `infra/live-smoke.sh` signs in against `BASE_URL`, and both default to
the owner's `https://sinnlos.yurtbay.dev`. On any other instance, set both to
its own address, for example
`SMOKE_URL=https://intranet.example.com BASE_URL=https://intranet.example.com infra/deploy.sh`,
or the deploy tests the owner's site and can pass while its own is down.

**One Sinnlos stack per Traefik.** The router, service and middleware names
are fixed (`sinnlos-*`), and a Traefik docker provider keeps one set of names
for every container it watches. A second instance (the employer instance, a
staging copy such as the [Entra dry-run](#staging-dry-run-then-on)) needs its
own host or its own Traefik; never start it behind the production Traefik.
With a different `DOMAIN`, the routers of both stacks conflict and Traefik
drops all of them (both sites answer 404; the Traefik log says
`Router defined multiple times with different configurations`). With the same
`DOMAIN`, the same-named services merge their servers, and production requests
are load-balanced onto the other stack's containers and database. Neither
case fails at deploy time.

The routers, highest priority first (a request goes to the highest-priority
router whose rule matches; `infra/routing-parity.test.ts` pins all of them):

| Router | Rule (besides the host) | Priority | Target | Middlewares |
|---|---|---|---|---|
| `sinnlos-auth` | `PathPrefix(/api/auth)` | 100 | web | headers, ratelimit, compress |
| `sinnlos-signin` | `POST` on `/sign-in` or `/register` | 90 | web | headers, authlimit, compress |
| `sinnlos-cms` | `/api`, `/admin`, `/upload`, `/upload/…`, `/email`, `/content-manager`, `/content-type-builder`, `/users-permissions`, `/i18n`, `/content-api` | 50 | cms | cms-headers, cms-ratelimit, cms-compress |
| `sinnlos-live` | `PathPrefix(/live/)` (the SSE stream and subscribe) | 10 | web | headers only |
| `sinnlos-web` | everything else, `/uploads/…` included | 1 | web | headers, compress |

Each container defines the middlewares its own routers use in its own labels
(`sinnlos-headers`, `-ratelimit`, `-authlimit`, `-compress` on web;
`sinnlos-cms-headers`, `-cms-ratelimit`, `-cms-compress` on cms, with the same
values). Traefik drops all labels of a container while it is starting,
unhealthy or stopped; until batch 10 the cms router used the web's middlewares,
so `/admin` and `/api` answered 404 during every web restart. The live router
carries no compression: Traefik 3.7's `compress` middleware gzips a
`text/event-stream` response despite `Cache-Control: no-transform`, and both
compress middlewares also exclude that content type.

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

Inside the stack the containers reach each other by the network aliases
`sinnlos-db`, `sinnlos-cms` and `sinnlos-web` (`DATABASE_HOST`, `STRAPI_URL`
and `WEB_INTERNAL_URL` in the compose file), which exist on the project's own
network only. The plain service names `db`, `cms` and `web` resolve on every
network a container joins, in this layout also on the shared `frontend`
network, where another project's `web` or `cms` container could answer them.
Container names (`infra-cms-1`, …) are unchanged; `deploy.sh`, `live-smoke.sh`
and the backup address the containers by those.

In practice you don't run that by hand — use the wrapper:

```bash
infra/deploy.sh
```

`deploy.sh` does, in order:

0. An env preflight that stops before anything is touched
   (`infra/deploy.sh --check` runs only this step, see
   [§3.8](#upgrading-an-existing-instance-to-this-release)), then the deploy
   checks: one deploy per compose project at a time (`flock`, from
   util-linux), a clean checkout (a changed tracked file refuses the
   deploy, and so does an untracked file or directory, an empty one
   included, where the Dockerfiles copy from, `apps/cms`, `apps/web`,
   `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and
   `tsconfig.base.json`, since the images would contain it: an empty
   `apps/web/app/` alone makes Next.js build that instead of `src/app`, and
   every page answers 500; `git -C <checkout> clean -n -d` lists them without
   removing anything; other untracked files only earn a note) and the GitHub CI
   result of the commit (a warning by default; `--require-green-ci` refuses a commit
   without green CI; `GITHUB_TOKEN` is optional, public repositories need
   none).
1. A pre-deploy Postgres + uploads + `.env` backup
   (`infra/backup/pg-backup.sh` with `SINNLOS_BACKUP_KIND=predeploy`: its
   artifacts are named `…-predeploy…` and kept apart from the nightly
   ones, [§7.3](#73-automated-daily-backups-cron)). A first install, with
   neither the db container nor its volume, has nothing to back up.
2. The rollback target: the images of the **last-known-good** deploy,
   `infra-{web,cms}:<sha>` (the first 12 characters of its commit), from
   the state file `.git/sinnlos-deploy/infra.state` of the checkout.
   Without a usable state (the first run of this version of `deploy.sh`,
   or those images are gone) it tags the running images `:rollback`, as
   before, and a re-run before the first recorded deploy keeps that
   `:rollback` (`.git/sinnlos-deploy/infra.bootstrap`). On every run it also tags the running images
   `infra-{web,cms}:pre-deploy` (moved each run, never pruned, never a
   rollback target): on Docker's containerd image store an image that no
   tag names can no longer be resolved by its id, and without that tag a
   re-run after a deploy that failed after `up` could not tag what runs.
3. Builds web and cms with `BUILDX_NO_DEFAULT_ATTESTATIONS=1` (without
   BuildKit's default provenance attestation an unchanged rebuild keeps its
   image id), then restarts the stack with the Traefik override
   (`up -d --no-build`).
4. Curl smoke-checks `https://sinnlos.yurtbay.dev` (override with
   `SMOKE_URL=`; any other instance sets it, and `BASE_URL` for
   live-smoke, to its own address, see
   [§3.6 B](#b-shared-traefik-live-production-layout)), then runs `infra/live-smoke.sh`: first the
   [datetime contract](#310-datetime-contract) check (no
   `timestamp without time zone` column left, the cms boot log reports the
   process zone UTC), then the end-to-end SSE pipeline probe (one comment
   posted through the cms → the ping frame on a subscribed stream, which
   must be uncompressed, and, when the comment lands on the stream user's
   own announcement, the notification frame; see [§6.1](#61-health-checks)).
   The stream user is `SMOKE_EMAIL`, by default the first of
   `alex.morgan@sinnlos.local` (an announcement author in the demo data)
   and `casey.jones@sinnlos.local` with a line in the credentials file; when
   it owns no visible announcement, the notification frame goes unchecked,
   live-smoke and `deploy.sh` print a warning, and the state records
   `LIVE_SMOKE=passed (notification frame not checked)`. A failed live-smoke
   **fails the deploy**; it is skipped with `LIVE_EVENTS_DISABLED=1` (read
   from the env compose hands the apps) or when the demo credentials file
   is not readable, and on an Entra-only instance it runs the datetime
   check only.
5. Only after both passed: tags the images web and cms now run as
   `infra-{web,cms}:<sha>`, records them in the state file as
   last-known-good, and removes the SHA tags beyond the newest five
   (`DEPLOY_KEEP_TAGS`). A skip for `LIVE_EVENTS_DISABLED=1` and the
   datetime check alone on an Entra-only instance count as passed. A
   live-smoke skipped for want of the credentials file (a typo in
   `PASSWORDS_FILE`, the wrong user) records **nothing**: the deploy ends
   with `WARNING: live-smoke did not run; this deploy is NOT recorded as
   last-known-good`, and the rollback target stays the previous one. Run
   `infra/live-smoke.sh` by hand, then re-run with a readable
   `PASSWORDS_FILE`, or with `--record-without-live-smoke` to record it
   anyway. A state file that cannot be written only warns (the state keeps
   naming the previous deploy), and then no SHA tag is removed; the prune
   never removes the tag the state names.

A failure from step 3 on prints the rollback commands for the target of
step 2 (an ERR trap catches the unexpected ones, a failed tag included);
before step 3 the running containers are untouched. `infra/deploy.sh
--dry-run` runs every check and prints this plan with its rollback target
and the tags it would remove, and changes nothing. The script is
`set -Eeuo pipefail` and re-run safe; its parameters (environment, the
defaults are the owner's host): `SMOKE_URL`, `PASSWORDS_FILE`,
`SINNLOS_CHECKOUT` (the checkout it lives in), `COMPOSE_PROJECT` (`infra`),
`DEPLOY_STATE_DIR` (state, history, bootstrap marker and lock; by default
`sinnlos-deploy` in the clone's `.git`, which its linked worktrees share: a
second clone that deploys the same project must point `DEPLOY_STATE_DIR`
at that same directory, or the two deploys neither share the lock nor the
rollback target) and `DEPLOY_KEEP_TAGS`. A second compose project (a
staging copy) needs its own backup dir, smoke URL and edge: `deploy.sh`
refuses a project other than `infra` without `SMOKE_URL` and
`SINNLOS_BACKUP_DIR` (passed on to the pre-deploy backup, whose
quick-access `.env` copy then defaults to a file of that project that does
not exist, so production's is never refreshed), and, on a Docker host that
runs containers of project `infra`, without `DEPLOY_SEPARATE_EDGE=1`: the
Traefik overlay's router names are fixed, so set it only when that project
has a Traefik of its own.

The preflight fails (naming keys, never values) when:

- a required key in `infra/.env` is empty (`docker compose config` rejects it);
- a secret still holds a template placeholder (`change-me…`, `changeme`,
  `toBeModified…`, `generate-with-openssl…`, `placeholder`, or a `<…>`
  stand-in) in `APP_KEYS`, `API_TOKEN_SALT`, `ADMIN_JWT_SECRET`,
  `TRANSFER_TOKEN_SALT`, `JWT_SECRET`, `ENCRYPTION_KEY`, `REVALIDATE_SECRET`,
  `INTERNAL_UPLOAD_TOKEN` or `AUTH_SECRET` (a placeholder
  `DATABASE_PASSWORD` only warns);
- `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` are set, `DIGESTS_DISABLED` is off
  (read as the cms reads it: `1`, `true`, `yes` or `on`, any case, switch it
  on), and `DIGEST_FROM` or `PUBLIC_WEB_URL` is empty;
- `JWT_SECRET` must be rotated: the running `infra-web-1` lacks the image
  label `org.sinnlos.strapi-jwt=server-only` (i.e. it is a web from before
  2026-09-24 that handed users their Strapi JWT) and the `JWT_SECRET` about to
  be deployed equals the one the running cms uses. A fresh install (no
  running web/cms) skips this check;
- `ENTRA_ENABLED=1` and an Entra setting the cms or the web would refuse to
  start with: `MS_TENANT_ID` or `MS_CLIENT_ID` not a GUID (`common` and
  domain names included), `MS_CLIENT_SECRET` empty, `ENTRA_EXCHANGE_SECRET`
  under 32 characters or a template placeholder, `ENTRA_SYNC_MODE` not
  `on`/`dry-run`, `ENTRA_DEFAULT_ROLE` not `member`/`guest`/`deny`,
  `ENTRA_SESSION_TTL` not `<n>m|h|d` up to `7d`, or `ENTRA_GROUP_ROLES`
  malformed or over 20 groups. It prints the key names, never the values.
  Without `ENTRA_ENABLED=1`, leftover `MS_CLIENT_ID`/`MS_CLIENT_SECRET` lines
  only earn a note (they are ignored), or a warning when they are a real app
  registration (a GUID client id plus a secret: Microsoft sign-in of the
  running release, if any, is off after the deploy); neither stops it;
- the running database still holds datetime columns in the pre-contract
  format (`timestamp without time zone` outside Strapi's bookkeeping tables)
  and `DATETIME_LEGACY_ZONE` is empty: the new cms would refuse to start
  ([Upgrading an existing instance to this release](#upgrading-an-existing-instance-to-this-release)).
  No running database (a fresh install) skips this check.

`apps/cms/src/utils/deploy-preflight.test.ts` pins the preflight's key lists,
placeholder markers and digest rule to the cms guards (`env-guard.ts`,
`send-digests.ts`), and the Entra rules to the cms's `parseEntraConfig`
(`apps/cms/src/entra/config.ts`), the web's `auth-config.ts` and the compose
mapping, so the preflight cannot silently drift from what the apps do at
boot. `infra/deploy-flow.test.ts` runs the whole script against a throwaway
checkout with docker, curl and flock stubbed (tags, state, rollback target,
failures, checks, dry run).

### 3.7 Enable auto-restart on reboot

Docker containers already have `restart: unless-stopped`. If Docker itself isn't
running on boot:

```bash
systemctl enable docker
systemctl start docker
```

### 3.8 Updates

> **Deploying the CI and edge changes (batch 10, lane 5A)?** First make sure
> `infra/.env` sets `DOMAIN` to the bare public host name (the owner
> instance: `DOMAIN=sinnlos.yurtbay.dev`): the Traefik overlay now takes
> every router's host from it, and compose, and with it
> `infra/deploy.sh --check`, refuses to render without it. Then a normal
> `infra/deploy.sh`. It recreates all containers, Postgres included (new
> labels, log rotation, network aliases, no capabilities for the cms), so
> the site is down for a Postgres restart plus a cms boot. No schema,
> permission, data or app code change. See
> [Upgrading to the CI and edge changes (batch 10, lane 5A)](#upgrading-to-the-ci-and-edge-changes-batch-10-lane-5a).
>
> **Deploying the deploy, backup and cron hardening (batch 10, lane 5B)?**
> A normal `infra/deploy.sh` run, with the new script itself: no schema,
> grant or env change, and it needs lane 5A's edge (its live-smoke refuses
> a compressed stream); the cms image changes only its cron wiring.
> Its first run has no last-known-good state yet and rolls back to
> `:rollback` as before; from its success on, a failed deploy rolls back
> to the SHA tags of the last good one. It refuses a checkout with changed
> tracked files or untracked files or directories under `apps/`, needs
> `flock`, and checks the notification frame when the demo credentials
> file has a line for `alex.morgan`. The next morning, check `backup.log`
> and the new `last-success` file. Follow
> [Upgrading to the deploy, backup and cron hardening (batch 10, lane 5B)](#upgrading-to-the-deploy-backup-and-cron-hardening-batch-10-lane-5b).
>
> **Deploying batch 9 (2026-09-28)?** The policy primitives, the live
> contract and poll documentIds, and the (switched off) Entra sign-in (the
> three notes below) ship as one normal deploy of cms and web **together**
> (`infra/deploy.sh`) once batch 8 runs, with `ENTRA_ENABLED` left unset:
> no env, edge or Traefik change. The first boot adds four empty user
> columns and one index and revokes the anonymous forgot/reset-password
> endpoints by itself. Read-only checks before it: `deploy.sh --check`
> (what its notes about leftover `MS_*` lines mean), the permission diff,
> the old Microsoft accounts (expected none) and the poll baseline. After
> it: the boot lines, the columns and the index, the exchange and the
> reset flow closed, the permission diff, local sign-in and a password
> change, the poll baseline and one vote, live-smoke and an hour of the cms
> log. A rollback re-ups both images and needs no database step; never
> roll back one alone (a new web in front of the batch 8 cms shows no poll
> card). Follow [Deploying batch 9 (2026-09-28)](#deploying-batch-9-2026-09-28).
>
> **Deploying the policy primitives (batch 9, lane 4B)?** A normal deploy:
> only the cms changes, no schema, env, edge or grant change. Comment and
> reaction threads of wiki pages follow the published space; watch the cms
> log for `[policy]` lines in the first hour. Batch 9 ships it with lanes
> 4C and 4A, so deploy and roll back cms and web together (see
> [Deploying batch 9](#deploying-batch-9-2026-09-28)). See
> [Upgrading to the policy primitives (batch 9, lane 4B)](#upgrading-to-the-policy-primitives-batch-9-lane-4b).
>
> **Deploying the live contract and poll documentIds (batch 9, lane 4C)?**
> A normal deploy of cms and web **together** (`infra/deploy.sh`): no
> schema, permission, env, route or edge change. Polls are addressed by
> documentId, poll results are counted in one SQL statement (same totals),
> the cms sends live events in POSTs of at most 1000, and `/announcements`
> loads its comment sections in one batch. Note the poll results before,
> run `infra/live-smoke.sh` after, then have a member vote and compare. A
> rollback takes back both images, never the cms alone. Batch 9 ships it
> with lanes 4B and 4A (see [Deploying batch 9](#deploying-batch-9-2026-09-28)). See
> [Upgrading to the live contract and poll documentIds (batch 9, lane 4C)](#upgrading-to-the-live-contract-and-poll-documentids-batch-9-lane-4c).
>
> **Deploying the Entra sign-in (batch 9, lane 4A)?** A normal deploy of cms
> and web together with `ENTRA_ENABLED` unset: the first boot adds four
> empty, private user columns and one unique index, forces Strapi's own
> Microsoft provider off and revokes the anonymous forgot/reset-password
> endpoints (`[bootstrap] revoked 2 obsolete permission(s)`); the cms logs
> `[entra] disabled`. Leftover `MS_*` lines in `infra/.env` become inert
> (`deploy.sh` notes them, or warns when they are a real app registration
> whose Microsoft sign-in goes off; optional cleanup). Run
> `infra/diagnostics/prod-perm-diff.sql` afterwards. A rollback needs no
> database step. Switching Microsoft sign-in on is a separate, later step.
> Batch 9 ships it with lanes 4B and 4C (see [Deploying batch 9](#deploying-batch-9-2026-09-28)).
> See [Upgrading to the Entra sign-in (batch 9, lane 4A)](#upgrading-to-the-entra-sign-in-batch-9-lane-4a).
>
> **Deploying batch 8 (2026-09-28)?** The cms bootstrap split, the web
> datetime port and one fix to poll results (the two notes below; the
> integration suite is test-only) ship as one normal deploy of cms and web
> **together** (`infra/deploy.sh`): no schema, permission, edge or Traefik
> change. Read-only checks before it: the permission diff, `SMTP_PORT` and
> `DIGESTS_DISABLED` in `infra/.env` (their meaning changes) and the polls
> with votes stored more than once (their totals drop to one vote per
> voter). After it: the cms boot's single drift line, the web's
> `[datetime]` line, no `X-Powered-By`, `/events` and the poll results.
> A rollback re-ups both images, the web with
> `-f infra/docker-compose.web-legacy-tz.yml` (`deploy.sh` prints it).
> Follow [Deploying batch 8 (2026-09-28)](#deploying-batch-8-2026-09-28).
>
> **Deploying the cms bootstrap split (batch 8, lane 3B)?** A normal
> deploy: only the cms code changes, no schema, edge or grant change. Check
> `SMTP_PORT` and `DIGESTS_DISABLED` in `infra/.env` first; afterwards
> the boot logs one `[bootstrap] permission drift` line. Batch 8 ships it
> with the web datetime port, so deploy and roll back cms and web together
> (see [Deploying batch 8](#deploying-batch-8-2026-09-28)). See
> [Upgrading to the cms bootstrap split (batch 8, lane 3B)](#upgrading-to-the-cms-bootstrap-split-batch-8-lane-3b).
>
> **Deploying the web datetime port (batch 8, lane 3A)?** A normal deploy
> (`infra/deploy.sh`) once batch 7 runs: the web container is recreated,
> now in UTC; the database and `infra/.env` stay as they are. Batch 8
> ships it with the cms bootstrap split, so deploy and roll back cms and
> web together (see [Deploying batch 8](#deploying-batch-8-2026-09-28)).
> From then on, a rollback of the web to an image from before it needs
> `-f infra/docker-compose.web-legacy-tz.yml` (`deploy.sh` prints it);
> without it that web answers every request with 500, or, if it predates
> the datetime release of 2026-09-27 (such as `:pre-datetime`), shows every
> date and time in UTC. See
> [Upgrading to the web datetime port (batch 8, lane 3A)](#upgrading-to-the-web-datetime-port-batch-8-lane-3a).
>
> **Deploying batch 7 (2026-09-28)?** The notification pipeline fixes, the
> user data and search hardening and the RSVP summary and reports (the three
> notes below) ship as one normal deploy of cms and web **together**
> (`infra/deploy.sh`): no env, edge or Traefik change; the first boot adds
> one permission (the RSVP summary) and one nullable column on the manager
> link table by itself. Read-only checks before it, and after it the boot
> grant line, a clean permission diff, the manager links, an RSVP probe,
> ⌘K as member and guest, an hour of watching `[sensitive-query-guard]`
> and the next morning's digest line: follow
> [Deploying batch 7 (2026-09-28)](#deploying-batch-7-2026-09-28), which
> also has the rollback (both images together; the RSVP summary
> permission rows a rollback leaves behind).
>
> **Deploying the notification pipeline fixes (2026-09-28)?** A normal
> deploy of cms and web (`infra/deploy.sh`): no env, schema or permission
> change of its own; batch 7 ships it with the RSVP summary (lane 2B), so
> deploy and roll back cms and web together (see
> [Deploying batch 7](#deploying-batch-7-2026-09-28)). Guests and blocked
> users stop getting announcement bells and digests, live pings and
> notifications follow the save, a failing notification no longer discards
> a comment or kudos, and weekly digests missed on a Monday are caught up
> the next morning.
> Optional read-only checks first, and the next morning the 07:30
> `[digest] run complete` line: see
> [Upgrading to the notification pipeline fixes (2026-09-28)](#upgrading-to-the-notification-pipeline-fixes-2026-09-28).
>
> **Deploying the user data and search hardening (batch 7, lane 2C)?** A
> normal deploy of cms and web together (`infra/deploy.sh`): no env, edge or
> permission change. Its one schema change (a nullable column on the manager
> link table) is covered by the pre-deploy backup `deploy.sh` takes. In the
> first hour, watch the cms log for `[sensitive-query-guard]`: a hit from a
> web page is a web query the new guard refuses. See
> [Upgrading to the user data and search hardening (batch 7, lane 2C)](#upgrading-to-the-user-data-and-search-hardening-batch-7-lane-2c).
>
> **Deploying the RSVP summary and reports (batch 7, lane 2B)?** A normal
> deploy of cms and web **together** (`infra/deploy.sh` does both): no env,
> schema or edge change. The first boot adds one permission (the RSVP
> summary, logged as `[bootstrap] granted 6 permission(s) across intranet
> roles`). Never deploy or roll back the cms alone: an older web against
> the new cms shows every user only their own RSVP. See
> [Upgrading to the RSVP summary and reports (batch 7, lane 2B)](#upgrading-to-the-rsvp-summary-and-reports-batch-7-lane-2b).
>
> **Deploying batch 6 (2026-09-28)?** The test safety nets, the web
> correctness fixes and the cms input hardening (the two notes below and
> the "Uploads gate" and live-event notes further down) ship as one normal
> deploy of cms and web together (`infra/deploy.sh`): no env, schema or
> permission change, and the order of web and cms does not matter. Before
> it, run `infra/deploy.sh --check` and, optionally, the read-only poll
> query (step 2 of
> [Upgrading to the cms input hardening (2026-09-28)](#upgrading-to-the-cms-input-hardening-2026-09-28)).
> After it, check:
>
> - `infra/live-smoke.sh` passed (`deploy.sh` runs it; the live-event
>   receiver moved into `apps/web/src/lib/live-emit.ts` unchanged);
> - the calendar file of an event with a non-ASCII title downloads (200,
>   no `ERR_INVALID_CHAR` in the cms log; step 4 of the cms input
>   hardening);
> - a lesson quiz can be typed, saved and cleared in the admin panel
>   (step 5 there), and the authorless polls are re-linked by hand
>   (step 6);
> - a lesson video plays on production (no player "Error 153");
> - the web items of the README's
>   [verification checklist](../README.md#8-verification-checklist):
>   `/people/abc` shows the *Page not found* card, the first Tab shows
>   *Skip to content*, the theme toggle switches on the first click.
>
> Nothing in the database needs undoing for a rollback; follow the hint
> `deploy.sh` prints.
>
> **Deploying the web correctness fixes (2026-09-28)?** A normal deploy of
> web and cms together (`infra/deploy.sh`): no env, schema or permission
> change. The cms part is the stricter `PUT /api/me` (trimmed strings, 400
> above 255 characters, `locale` `en` or `de` only); the web sends the
> desired reaction state as `data.reacted`, which a cms without that
> support ignores (it toggles as before), so the order of web and cms does
> not matter. After the deploy, play the video of a lesson on production:
> YouTube refused to play embedded videos without the Referer ("Error
> 153"), and localhost can hide that effect. This change leaves nothing to
> undo in the database; for a rollback follow the hint `deploy.sh` prints.
>
> **Deploying the cms input hardening (2026-09-28)?** A normal deploy: no
> env, schema or permission change. One optional read-only query lists the
> polls whose answers the new check refuses; after the deploy, download the
> calendar file of an event with a non-ASCII title (it answered 500 before)
> and re-link the authorless polls. See
> [Upgrading to the cms input hardening (2026-09-28)](#upgrading-to-the-cms-input-hardening-2026-09-28).
>
> **Deploying poll department targeting?** A normal deploy (cms and web
> together, as `infra/deploy.sh` does). Run the read-only checks of
> [Upgrading to poll department targeting](#upgrading-to-poll-department-targeting)
> first: they list the polls that become restricted, the users who have
> no department and the guests, who see no poll after the deploy until an
> admin or editor turns on "Visible to guests" for it. If the first boot
> cannot set Audience on the existing polls, the new cms does not start and
> `deploy.sh` stops (step 8 there). A rollback to the previous cms first
> stops the cms and removes the guest vote permission this release adds,
> then retags and starts, then removes it once more (it must find nothing),
> whatever the database or the admin panel shows at the time (`deploy.sh`
> prints the whole sequence when a deploy fails; see **Rollback** there).
> Never roll the cms back to `808e2e7` alone.
>
> **Deploying the ICS and cms start fixes (2026-09-27)?** A normal deploy on
> an instance that runs the datetime release: no env change, no migration.
> The cms image no longer contains pnpm and starts without registry access;
> cms images from before it (Cmd `["pnpm","start"]`, including the
> `:rollback` image this deploy tags) still download pnpm at every start,
> which matters for a rollback. See
> [Upgrading to the ICS and cms start fixes (2026-09-27)](#upgrading-to-the-ics-and-cms-start-fixes-2026-09-27)
> for the checks after the deploy and the rollback note.
>
> **Deploying both at once** (on an instance that runs the datetime
> release)? Still one normal deploy, cms and web together: the read-only
> checks of the poll targeting note before it, the checks of both notes
> after it. The `:rollback` images it tags are from before both, so a
> rollback re-ups web and cms together, and that cms image starts with
> `pnpm start` (see the rollback note of the ICS and cms start fixes).
>
> **Upgrading to this release (datetime contract)?** Follow
> [Upgrading an existing instance to this release](#upgrading-an-existing-instance-to-this-release)
> first: an existing database needs `DATETIME_LEGACY_ZONE` in `infra/.env`,
> and its first boot repairs the stored times once. Ship it before the DST
> change of **2026-10-25**.
>
> **Upgrading from before 2026-09-25 (Strapi 5.55.1)?** Follow
> [Upgrading to the Strapi 5.55.1 release (2026-09-25)](#upgrading-to-the-strapi-5551-release-2026-09-25)
> as well: take the pre-deploy backup, and do not deploy an instance that
> signs users in with the old Microsoft flow before it can move to the
> [Entra sign-in](#microsoft-entra-id-sign-in) (batch 9). Coming from a release before 2026-09-24,
> also follow [Upgrading from a release before 2026-09-24](#upgrading-from-a-release-before-2026-09-24):
> that deploy needs env changes and one `JWT_SECRET` rotation.
>
> **Deploying the release that turns draft & publish off for departments
> and teams (2026-09-26)?** Run the read-only preflight of
> [One-time: org draft/publish off](#one-time-org-draftpublish-off) first. With
> no department or team drafts it is a normal deploy; otherwise the database
> needs a one-time migration while cms and web are stopped.
>
> **Deploying the draft-twin repair (FX38)?** A normal deploy: the first boot
> gives every published entry that has no draft its draft twin, on its own.
> See [Upgrading to the draft-twin repair (FX38)](#upgrading-to-the-draft-twin-repair-fx38)
> for the read-only checks to run first (steps 2 to 5), the log lines and
> what editors notice.

On the Traefik host (mode B), pull and re-run the wrapper — it validates
`infra/.env`, checks the checkout and CI, backs up, and tags the images by
commit once the smoke checks passed ([§3.6](#36-deploy)):

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

#### Upgrading to the CI and edge changes (batch 10, lane 5A)

This release (branch `ops/ci-and-edge`, on `batch/9` `5be7dc7`) changes the
compose files, the Traefik labels, the Caddyfile, the `.env.example` files
and CI. The app code does not change.

- **The Traefik host comes from `DOMAIN`.** The five routers of
  `infra/docker-compose.traefik.yml` match ``Host(`$DOMAIN`)`` instead of
  the owner's host name, so the same overlay file serves another instance
  on its own host or Traefik. One Sinnlos stack per Traefik: the router,
  service and middleware names stay fixed (`sinnlos-*`), and a second
  stack behind the production Traefik would delete production's routers
  (different `DOMAIN`) or share its services (same `DOMAIN`), see
  [§3.6 B](#b-shared-traefik-live-production-layout).
  `DOMAIN` is required: without it `docker compose` refuses to render the
  overlay (`required variable DOMAIN is missing a value`), and
  `infra/deploy.sh` stops in its preflight before touching anything.
- **The cms routes no longer depend on the web container (FX34).** The cms
  labels define their own `sinnlos-cms-headers`, `sinnlos-cms-ratelimit`
  and `sinnlos-cms-compress` with the web's values. Traefik drops all
  labels of a container while it is starting, unhealthy or stopped, and
  until now the cms router used the web's middlewares, so `/admin` and
  `/api` answered 404 during every web restart (a web-only deploy, a web
  crash, a slow web start).
- **The live stream is no longer compressed (FX34).** A new router
  `sinnlos-live` (priority 10) serves `/live/*` with the security headers
  only. Traefik 3.7's `compress` gzipped the `text/event-stream` response
  despite its `Cache-Control: no-transform`; it still streamed, because
  Traefik flushes, but through a gzip layer. Both compress middlewares
  also exclude `text/event-stream`.
- **Caddy mode (FX33).** Compose passes `DOMAIN` to Caddy (before, a
  standalone install always served `localhost`), the Caddyfile sends the
  Traefik security headers (`X-Frame-Options: DENY`, the
  `Permissions-Policy`, HSTS for a real host name over HTTPS, none on
  `localhost`), and the caddy service runs with `no-new-privileges` and
  memory, CPU and pid limits ([§3.6](#36-deploy) A, [§2.1](#21-clone-and-prepare-env)).
- **Log rotation (IN05).** db, cms, web and caddy log through `json-file`
  with at most 5 files of 10 MB each. Log lines older than the newest
  50 MB of a container are gone.
- **Network aliases (IN04).** `DATABASE_HOST`, `STRAPI_URL` and
  `WEB_INTERNAL_URL` use `sinnlos-db`, `sinnlos-cms` and `sinnlos-web`,
  aliases on the project network only; the plain names `db`, `cms` and
  `web` also resolve on the shared `frontend` network, where another
  project's container could answer. Container names stay `infra-*-1`.
- **No capabilities for the cms (IN02).** `cap_drop: [ALL]`, as the web
  already had.
- **cms environment (B05, LF03).** `STRAPI_TELEMETRY_DISABLED=true` (no
  usage telemetry to Strapi; a stop on a host without DNS no longer waits
  for its lookups) and `CRON_ENABLED` (default `true`) for the cms's cron
  registry of batch 10. Leave `CRON_ENABLED` unset or `true` on
  production: `false` stops the nightly janitors and the digest mailer.
  `apps/cms/.env.example` now lists every setting `apps/cms/config` reads.
- **CI.** New jobs `infra · shellcheck · compose config` and
  `images · cms`/`images · web` (buildx, no push), a blocking critical
  `pnpm audit`, `pnpm format:check` and shellcheck (both reporting only
  until the format sweep after batch 10), a read-only token, timeouts, and
  push builds on `main` only (pull requests as before, a branch without
  one through "Run workflow"). Dependabot opens weekly grouped update pull
  requests for npm, the Dockerfile base image and the GitHub Actions.
  Nothing of this runs on the host.

**Owner steps (mode B).** In the checkout (`/opt/sinnlos` in this guide;
the owner instance uses its own path):

1. **Before (read-only, mandatory):** fast-forward and check `DOMAIN`:

   ```bash
   git pull --ff-only
   grep -E '^DOMAIN=' infra/.env
   ```

   It must print the bare host name of `WEB_PUBLIC_URL`, without scheme or
   port (owner instance: `DOMAIN=sinnlos.yurtbay.dev`). If the line is
   missing, add it: the only `infra/.env` change of this lane. Do not skip
   the rest of this step: `deploy.sh --check` only rejects a missing or
   empty `DOMAIN`, and any other wrong value (a scheme, a port, the example
   host) passes it and leaves all five routers without a match
   ([§3.6 B](#b-shared-traefik-live-production-layout)). Then:

   ```bash
   infra/deploy.sh --check
   docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
     config --format json | grep -o 'Host(`[^`]*`)' | sort | uniq -c
   ```

   `deploy.sh --check` prints `Preflight OK`; the second command prints
   ``5 Host(`sinnlos.yurtbay.dev`)`` (your host) and nothing else, without
   printing any other value of `infra/.env`.
2. **Deploy:** `infra/deploy.sh`. All containers are recreated, Postgres
   included (its logging and network alias change): expect the site to be
   down for a Postgres restart plus a cms boot, somewhat longer than a
   code-only deploy. `live-smoke.sh` at the end exercises the new live
   router and the cms-to-web ping over `sinnlos-web`.
3. **After (read-only):**

   ```bash
   docker inspect -f '{{.Name}} {{json .HostConfig.LogConfig}}' infra-db-1 infra-cms-1 infra-web-1
   docker inspect -f '{{json .HostConfig.CapDrop}}' infra-cms-1
   docker exec infra-cms-1 getent hosts sinnlos-web
   docker exec infra-cms-1 getent hosts sinnlos-db
   docker exec infra-web-1 getent hosts sinnlos-cms
   docker exec infra-cms-1 printenv STRAPI_TELEMETRY_DISABLED CRON_ENABLED
   curl -sI https://sinnlos.yurtbay.dev/admin | grep -iE '^(HTTP|strict-transport-security|x-frame-options|permissions-policy)'
   curl -s -o /dev/null -w '%{http_code}\n' https://sinnlos.yurtbay.dev/api/events
   ```

   Expect `json-file` with `max-file` `5` and `max-size` `10m` on all three,
   `["ALL"]`, one address line per alias, `true` twice, a 200 with HSTS,
   `X-Frame-Options: DENY` and the `Permissions-Policy`, and `403` from Strapi for the
   anonymous `/api/events` (a `404` would mean the cms router is missing).
   In the host Traefik's dashboard, if it has one, the routers
   `sinnlos-auth`, `-signin`, `-cms`, `-live` and `-web` are enabled. In a
   browser's developer tools, `/live/stream` has no `content-encoding`.

**Rollback:** the images do not change with this lane, so there is nothing
to retag for it. The previous compose files also work with these images. To
return to the previous edge configuration, check out the previous commit and
re-create the containers from its files without building:
`git checkout <previous commit>`, then
`docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml up -d --no-build`,
and back to `main` once the cause is fixed. (The old overlay names
`sinnlos.yurtbay.dev` literally and ignores `DOMAIN`.) If the whole site
answers `404 page not found` right after the deploy, check `DOMAIN` first:
correct it and run
`docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml up -d --no-build web cms`;
the image rollback that the failed smoke check prints does not change the
router rules ([§3.6 B](#b-shared-traefik-live-production-layout)).

**Rehearsal (throwaway compose project with its own volumes, behind a local
Traefik v3.7.13 reading the labels, images built from this branch):** all
five routers enabled; with the web container stopped, `/admin` and
`/admin/init` answered 200 and `/api/events` 403 (with a member's JWT 200),
where the batch 9 overlay answered 404 on all of them; the security headers
of 15 edge paths were identical to the batch 9 overlay's, the only change
being no gzip on `/live/*`; `/live/stream` with a session and
`curl --compressed` came back as `text/event-stream` without
`content-encoding`; `infra/live-smoke.sh` passed (ping over `sinnlos-web`);
`getent` resolved all three aliases, which exist on the project network
only; `LogConfig` as above on every container; the cms with no capabilities
stored a member's image upload with all four sharp formats, answered
`/_health` with 204 and stopped in under a second. Caddy mode: with a
non-localhost `DOMAIN` it served that host with HSTS, `DENY` and the
policy on `/` and `/admin`, on `localhost` without HSTS (Strapi's own
included); `/live/stream` uncompressed under both.

#### Upgrading to the deploy, backup and cron hardening (batch 10, lane 5B)

Lane 5B of batch 10 (branch `ops/deploy-backup-cron`, on `batch/9`
`5be7dc7`) changes the host scripts and the cms's cron wiring. No schema,
grant, env, compose or edge change; web and cms images are rebuilt as
usual. It does depend on one edge change: live-smoke now requires an edge
that does not compress `text/event-stream`, which is lane 5A's
`sinnlos-live` router (Traefik; Caddy's `encode` already leaves the
stream alone). A deploy of this lane without it fails at live-smoke by
design (`came back compressed (content-encoding: gzip)`) and prints the
rollback; merged in order (5A, then 5B), batch 10 ships both together.

- **`infra/deploy.sh`** ([§3.6](#36-deploy)): after the env preflight it
  takes a lock per compose project, refuses a checkout with changed tracked
  files or with untracked files or directories where the images are built
  from (`apps/cms`, `apps/web`, the root manifests) and checks the GitHub CI result of the commit (a warning;
  `--require-green-ci` refuses). It builds, starts without a build, runs
  the smoke check and live-smoke, and only then tags the images
  `infra-{web,cms}:<sha>` and records them as last-known-good in
  `.git/sinnlos-deploy/infra.state` (history next to it; the newest five
  SHA tags are kept). A failed deploy prints the rollback to those tags
  (with every override the target needs), also for a failed live-smoke or
  tag. The running images keep a `:pre-deploy` tag through the build, which
  runs without BuildKit's default attestations (a re-run after a failed
  deploy then records what runs, also on the containerd image store).
  `--dry-run` shows the plan. `DIGESTS_DISABLED` is read like the cms
  reads it (`true`, `yes` and `on` count, not only `1`), and
  `LIVE_EVENTS_DISABLED` comes from `infra/.env` through compose, no longer
  from the shell.
- **`infra/backup/pg-backup.sh`** ([§7.3](#73-automated-daily-backups-cron)):
  no plaintext survives a run (umask 077, a cleanup trap, also on errors and
  signals); retention keeps everything younger than 7 days and at least the
  newest 7 per series, pre-deploy artifacts (`…-predeploy…`) in series of
  their own; `backup.log` gains `skip`, `FAIL`, `pruned` and `done` lines;
  a `last-success` file records the last complete nightly run
  (`last-success-predeploy` the last pre-deploy run). Same paths, same
  cron line.
- **`infra/backup/restore-drill.sh`** (new): restores the newest encrypted
  dump into a throwaway Postgres 16, off-box.
- **`infra/live-smoke.sh`** ([§6.1](#61-health-checks)): finds its target
  with GETs only, removes the comment notifications it causes, checks the
  stream is uncompressed, keeps passwords off the command line, and skips
  its sign-in steps on an Entra-only instance. It checks the notification
  frame by default: the stream user is the first of `alex.morgan` (who
  authors seeded announcements) and `casey.jones` with a line in the
  credentials file, and an unchecked frame is a warning that `deploy.sh`
  repeats and records. The comment author signs in to the cms once per run
  (the comment and the cleanup reuse that token, passed through the
  environment), so back-to-back runs stay under the cms sign-in limit of
  10 per minute; a `HTTP 429` from that sign-in says to wait 60 s.
- **cms crons**: one registry (`apps/cms/src/cron/registry.ts`) with a
  `[cron] <name> took <n>ms` line per run, an in-process overlap guard and
  the kill switch `CRON_ENABLED` (unset or blank = on; `0`, `false`, `no`
  or `off` = off). The compose file passes it from batch 10 lane 5A on;
  without that the crons stay on. It switches off the app's three tasks
  (Strapi's `server.cron.tasks`), not Strapi's own jobs: @strapi/core still
  starts its cron service, so its telemetry ping (`sendPingEvent`, stopped
  by `STRAPI_TELEMETRY_DISABLED=true`, lane 5A's compose default), the
  admin's daily `sendProjectInformation` and the upload plugin's weekly
  `uploadWeekly` (which writes its own schedule into Strapi's core store)
  run on. None of them mails, sweeps or deletes anything, so a second cms
  on the same database (a rehearsal) is safe with `CRON_ENABLED=0`.

**Before the deploy**

1. The checkout must be clean: `git -C /home/bigemo/git/sinnlos status`
   (your checkout path) lists no modified tracked file, and
   `git -C /home/bigemo/git/sinnlos clean -n -d -- apps package.json
   pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json` (a dry run that
   removes nothing) lists no untracked file or directory, an empty one
   included, where the Dockerfiles copy from. `deploy.sh` now refuses
   either: commit, stash, move or delete them first. Other untracked files
   only earn a note.
2. `command -v flock` prints a path (util-linux; Debian and Ubuntu ship it).
   Note which image store the host uses: `docker info -f '{{.DriverStatus}}'`
   showing `io.containerd.snapshotter.v1` means the containerd image store,
   where an image that no tag names cannot be resolved by its id any more
   (plain `overlay2` keeps it until it is pruned). `deploy.sh` handles both
   (the `:pre-deploy` tags, [§3.6](#36-deploy)); on the containerd store
   roll back by tag, never by a bare image id.
3. The credentials file (`PASSWORDS_FILE`, by default
   `/home/bigemo/.sinnlos-env-backup/demo-account-passwords.txt`) holds a
   line for an announcement author: live-smoke now signs in as the first of
   `alex.morgan@sinnlos.local` and `casey.jones@sinnlos.local` that has one,
   and only a stream user with a visible announcement of their own gets the
   notification frame checked. `grep -c '^alex.morgan@' <file>` prints 1;
   otherwise add that account's line, or set `SMOKE_EMAIL` (and
   `SMOKE_PASSWORD`) to another author. Without one the deploy still passes,
   with a warning and `LIVE_SMOKE=passed (notification frame not checked)`
   in the state.
4. Optional: `infra/deploy.sh --dry-run`. It runs every check and prints
   the plan: on the first run `2. rollback target: … -> the images that ran
   before this deploy (:rollback)`, because there is no state yet.

**Deploy**

5. `infra/deploy.sh` as usual. Expect `WARNING: CI is …` when GitHub has no
   green run for the checked-out commit yet (the deploy goes on; pass
   `--require-green-ci` to refuse instead). This first run tags the
   running images `:rollback` (no state yet), exactly as before, and a
   failure prints the `:rollback` commands. A fix-forward re-run after
   such a failure keeps that `:rollback` (`:rollback kept from <time>`)
   instead of tagging the failed images, until a deploy is recorded
   ([§7.4](#74-update-procedure-production-safe)). After the smoke check and
   live-smoke it prints `Recording infra-{web,cms}:<sha> as last-known-good`.
   If it ends with `WARNING: live-smoke did not run; this deploy is NOT
   recorded as last-known-good`, the credentials file of step 3 was not
   readable: nothing was recorded, so fix `PASSWORDS_FILE` and re-run, or
   run `infra/live-smoke.sh` by hand and re-run with
   `--record-without-live-smoke`.

**After the deploy**

6. `cat .git/sinnlos-deploy/infra.state` shows `TAG=<sha>` and
   `LIVE_SMOKE=passed`; `docker images infra-web` lists `latest`, the SHA
   tag, `rollback` and `pre-deploy` (the images that ran before this
   deploy). From the next deploy on, a failure rolls back to this SHA tag.
7. The pre-deploy backup of this run is named
   `sinnlos-db-<ts>-predeploy.dump.gz.gpg` (uploads and `.env` alike) in the
   offsite dir, `backup.log` ends with `done predeploy`, and
   `last-success-predeploy` names that run (`last-success` is left to the
   nightly cron).
8. The next morning, after the 03:00 cron: `tail backup.log` shows `ok`
   lines, `pruned` lines for artifacts older than 7 days beyond the newest
   7, and `done nightly`; `cat last-success` names the nightly run (a
   freshness monitor, once chosen, alerts when `last-success` is older than
   26 hours; pre-deploy runs never refresh it). The new script reports the
   plaintext that killed or failed runs left in the backup root
   (`sinnlos-{db,uploads,env}-<ts>[-predeploy].{dump,tar,env}[.gz]`, older
   than an hour) as `WARN stale plaintext <name>` lines in `backup.log` and
   on stderr, on every run, but never deletes it: review and delete those
   files by hand. The pre-datetime dump has another name and is not
   reported; keep it until the class-C review is done.
9. The cms log shows `[cron] uploads-janitor took …ms` after 03:30,
   `[cron] search-log-janitor took …ms` after 03:35 and
   `[cron] digest-mailer took …ms` after 07:30.
10. On the NAS or the owner machine (where the private key is), run the
   restore drill once ([§7.3](#73-automated-daily-backups-cron)).
11. Optional, once: remove the notification residue of earlier live-smoke
    runs (33 rows in the 2026-09-25 census) with
    `infra/diagnostics/cleanup-live-smoke-notifications.sql`: a dry run
    first, then armed with the count it printed
    ([infra/diagnostics/README.md](../infra/diagnostics/README.md)).

**Rollback.** The scripts are part of the checkout: checking out an older
commit brings the older scripts back, and they ignore the state file. The
cms image changes only its cron wiring; roll it back with the commands
`deploy.sh` prints. A later deploy with this `deploy.sh` finds its state
again.

**Verified** (throwaway compose project `b10-5b-staging` with its own
volumes, a test GPG key and backup dir, the web on a published port instead
of Traefik): a first install and five further deploys produced the SHA tags
and the state, prune kept five tags; a forced smoke failure after a web
change printed the rollback to the last good SHA tag, and running it as
printed brought the old web back healthy; a forced live-smoke failure
printed the rollback and kept the state; a second deploy during the first
stopped at the lock; a changed tracked file was refused; `--dry-run`
changed no image, tag, state file or container. The pre-deploy artifacts
were `0600`, no plaintext was left, and `restore-drill.sh --all` restored
the newest dump (105 tables) into a throwaway Postgres 16. The old
live-smoke left two notifications per run and showed the demo password in
`ps`; the new one left none and showed none, received the notification
frame with an announcement author as `SMOKE_EMAIL`, skipped its sign-in
steps for an Entra-only web, and failed with `came back compressed` on a
gzip-encoded stream.

**Fix round, verified** (throwaway compose project `b10-5b-fix` with its
own volumes, a test key and backup dir, the web on `127.0.0.1:8511`,
`deploy.sh` run in a Linux container against Docker 29.7.2 with the
containerd image store): the lane head's `deploy.sh` reproduced the
re-run failure (`No such image` in `record` after a deploy that failed
after `up`); the fixed script records such a re-run, also with BuildKit's
attestations switched back on (the `:pre-deploy` tag alone), keeps both
image ids on an unchanged rebuild, and after the lane head's failure
names the lost image and the `--force-recreate` recovery. A staging
project without `SMOKE_URL` and `SINNLOS_BACKUP_DIR` was refused. An
untracked file under `apps/web` was refused; an empty `apps/web/app/` left
behind broke the next web build (HTTP 500 on every page: the smoke check
stopped the deploy and the printed rollback restored the stack), hence
the directory check. Without the credentials file nothing was recorded,
and `--record-without-live-smoke` recorded; a credentials file without
`alex.morgan` recorded `passed (notification frame not checked)` with the
warning. Without a state, two failed runs kept the first `:rollback`, and
the passing third one deleted the marker. A linked worktree planned with
the clone's state. A pre-deploy backup wrote only
`last-success-predeploy`. The §7.3 snippet left `0600` files in a `700`
directory, and the uploads stream restored the volume, while `tar xzf`
fails on the decrypted `.tar`. A SIGKILLed backup left a dump that the
next run reported. Four live-smoke runs within 6 s passed (two cms
sign-ins each), where the lane head's hit HTTP 429 on the fourth.

#### Deploying batch 9 (2026-09-28)

Batch 9 (branch `batch/9`, on `main` `03d4ea0`, the batch 8 merge) ships
three lanes in one deploy, once batch 8 runs. The runbooks below explain
each change in detail; **this section is the one sequence to follow** on an
instance that keeps Microsoft sign-in off (`ENTRA_ENABLED` unset, the owner
instance):

- [the policy primitives](#upgrading-to-the-policy-primitives-batch-9-lane-4b)
  (lane 4B): the cms read and ownership policies run on shared helpers and
  factories, a thread read checks only its one target, and a list of
  visible ids too long for one SQL statement answers empty with a
  `[policy]` log line. One visible fix: comments and reactions of a wiki
  page follow its published space (three draft-only cases closed);
- [the live contract and poll documentIds](#upgrading-to-the-live-contract-and-poll-documentids-batch-9-lane-4c)
  (lane 4C): polls are addressed by documentId, and a vote whose shown
  answer a republish moved is refused instead of counting another answer;
  poll results are counted in one SQL statement (the same totals); the cms
  sends live events in POSTs of at most 1000; `/announcements` loads its
  comment sections in one batch;
- [the Entra sign-in](#upgrading-to-the-entra-sign-in-batch-9-lane-4a)
  (lane 4A): the optional Microsoft Entra ID sign-in, **off** here. The
  first boot adds four empty, private user columns and one unique index,
  forces Strapi's own Microsoft provider off (it was off) and revokes the
  anonymous forgot/reset-password endpoints (the web never offered them);
- from the integration: the remaining role checks outside the lanes
  (acknowledgements, the relation guard, poll visibility, RSVP names, the
  profile's digest fields) decide through `hasRole`; behaviour unchanged.

It is **one normal deploy of cms and web together** with `infra/deploy.sh`:
no edge or Traefik change, nothing to migrate by hand, and no change to
`infra/.env` (keep `ENTRA_ENABLED` unset). Compose passes the new
`ENTRA_*` keys with their defaults, the cms no longer gets
`MS_CLIENT_SECRET` and the web no longer gets
`AUTH_MICROSOFT_ENTRA_ID_ISSUER`; both are unused here. **Why together:**
the new web addresses polls by documentId, which the batch 8 cms answers
with 404, so `/polls` would show no poll card at all while a new web runs
in front of the old cms. The new cms still accepts what a batch 8 web
sends (the numeric id of the published row, a vote without the answer
text). So whichever container restarts first, the seconds in between are
harmless: a batch 8 web in front of the new cms works fully, a new web in
front of the batch 8 cms only misses the poll cards until the cms is up.
Local
sign-in, sign-out, the password change, `/profile` and the live pings work
across the two versions in both directions. All of this was rehearsed
with the built images (see the end of this section). The routes golden
gains the exchange route and `infra/diagnostics/prod-perm-diff.sql` the
two revocations; nothing else in either changes.

Set these on the host, in your checkout (e.g. `/opt/sinnlos`), for the
checks below (on a standalone Caddy box, drop the second `-f`):

```bash
cd /opt/sinnlos
COMPOSE=(docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml)
psql_db() { "${COMPOSE[@]}" exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@"; }
```

**Before the deploy** (all read-only)

1. **Fast-forward to the new `main` and validate**, deploying nothing:

   ```bash
   git pull --ff-only
   git log -1 --oneline      # the batch 9 merge
   infra/deploy.sh --check
   ```

   It prints `Preflight OK`. The Microsoft refusal of earlier releases
   ("Microsoft sign-in is configured …") is gone; the Entra-aware
   preflight reads the `MS_*` lines left in `infra/.env` instead, and
   both of its messages only inform (exit code 0):
   - no message: no `MS_*` values, or none that matter;
   - `NOTE: MS_CLIENT_ID/MS_CLIENT_SECRET are set in infra/.env, but
     ENTRA_ENABLED is not 1: Microsoft sign-in stays off and the MS_*
     values are ignored (safe to delete).`: leftover placeholders or a
     half-filled registration. Nothing reads them; deleting the lines is
     optional cleanup;
   - `WARNING: infra/.env holds a Microsoft app registration (MS_CLIENT_ID
     is a GUID and MS_CLIENT_SECRET is set), but ENTRA_ENABLED is not 1. …`:
     a real app registration that nothing uses once this deploy runs. On
     the owner instance nobody signs in with Microsoft (it stopped working
     with the Strapi 5.55.1 release, and step 3 finds no such account), so
     the lines can stay or go. Only an instance where people still sign
     in with Microsoft stops here and follows the
     [Entra runbook](#upgrading-to-the-entra-sign-in-batch-9-lane-4a)
     (its last paragraph) first;
   - `ERROR: ENTRA_ENABLED=1, but these Entra settings … are invalid`
     (exit code 1) appears only when `ENTRA_ENABLED=1` is set: remove it,
     the owner instance keeps it unset.

2. **Permissions: the post-batch-8 state**, read with the new file:

   ```bash
   psql_db -X < infra/diagnostics/prod-perm-diff.sql
   ```

   The file now describes batch 9, so it shows what batch 8 left (on
   production the two informational `MISSING_IN_DB` rows for
   `authenticated`, `plugin::users-permissions.auth.getSessions` and
   `…auth.revokeSession`) **plus exactly two** `EXTRA_IN_DB` rows for
   `public`: `plugin::users-permissions.auth.forgotPassword` and
   `…auth.resetPassword`, both with `revoked_by_code = t` (the first boot
   of this batch revokes them). Keep the output for step 9. Any other row
   was there before this batch: compare it with the output you kept from
   the batch 8 deploy.

3. **Accounts of the old Microsoft flow** (expected 0 and 0):

   ```bash
   psql_db -X <<'SQL'
   SELECT count(*) FILTER (WHERE provider = 'microsoft') AS microsoft_rows,
          count(*) FILTER (WHERE microsoft_oid IS NOT NULL) AS rows_with_oid
     FROM up_users;
   SQL
   ```

   Anything but 0 and 0 means accounts that only Microsoft ever signed in
   (they have no password, and have not been able to sign in since the
   Strapi 5.55.1 release). This deploy does not change that; note them for
   the day Microsoft sign-in is switched on (they are bound one by one,
   [the 409 procedure](#an-e-mail-address-that-already-has-an-account-409)).

4. **The poll baseline:** step 1 of the
   [lane 4C runbook](#upgrading-to-the-live-contract-and-poll-documentids-batch-9-lane-4c)
   (`… | tee poll-baseline-before.txt`): the counted votes per option of
   every published poll, by the rule the results use. It equals what the
   cards on `/polls` show now.

**Deploy**

5. Run `infra/deploy.sh` on the Traefik host. It runs the preflight, takes
   the pre-deploy backup, tags the running images `:rollback`, rebuilds
   and restarts **cms and web together**, and runs `infra/live-smoke.sh`
   when the demo credentials file is readable (otherwise it logs
   `live-smoke SKIPPED`: run `infra/live-smoke.sh` by hand in step 11). On
   a standalone Caddy box, run `infra/backup/pg-backup.sh`, then
   `docker compose up -d --build` from `infra/`.

**After the deploy**

6. **cms boot.**

   ```bash
   "${COMPOSE[@]}" logs --since 30m cms | grep -E '\[bootstrap\]|\[entra\]'
   # [bootstrap] revoked 2 obsolete permission(s)
   # [bootstrap] permission drift: none (report-only check of 119 managed actions)
   # [entra] disabled
   ```

   The drift line checks 119 managed actions (batch 8: 117; the two
   revoked `public` actions are managed now). The `revoked` line appears
   on the first boot only (with a smaller number if an admin had removed
   either action before). `[bootstrap] users-permissions providers synced
   (email=on, microsoft=off)` may also appear once, when Strapi's own
   Microsoft provider was on or still held a client id or secret (from the
   Strapi 5.49 era); they are now off and cleared, which is expected. A
   drift warning lists `<role> <action>` pairs added in the admin panel,
   as since batch 8. `[entra] enabled …` or an
   `[entra] … invalid` error would mean `ENTRA_ENABLED=1` reached the cms:
   roll back (below) and check `infra/.env`.

7. **The four columns and the unique index** (4 rows, then 1 row):

   ```bash
   psql_db -X <<'SQL'
   SELECT column_name, is_nullable FROM information_schema.columns
    WHERE table_name = 'up_users'
      AND column_name IN ('entra_tenant_id', 'role_source', 'entra_applied_role', 'entra_manager_oid')
    ORDER BY 1;
   SELECT indexdef FROM pg_indexes WHERE indexname = 'up_users_entra_identity_uq';
   SQL
   ```

   Every column is nullable (`YES`) and NULL on every existing row: a
   local account's role stays *manual*, no sign-in ever touches it. The
   index is `UNIQUE … (entra_tenant_id, microsoft_oid) WHERE (microsoft_oid
   IS NOT NULL)`.

8. **The exchange is off and the anonymous reset flow closed**, asked from
   inside the stack (the edge sends `/api/auth/*` to the web, so the cms
   is only reachable there): `404`, then `403`:

   ```bash
   "${COMPOSE[@]}" exec -T web node -e "fetch('http://cms:1337/api/auth/entra/exchange',{method:'POST'}).then(r=>console.log(r.status))"
   "${COMPOSE[@]}" exec -T web node -e "fetch('http://cms:1337/api/auth/forgot-password',{method:'POST',headers:{'content-type':'application/json'},body:'{\"email\":\"nobody@example.com\"}'}).then(r=>console.log(r.status))"
   ```

9. **Permissions after:** `psql_db -X < infra/diagnostics/prod-perm-diff.sql`
   gives the output of step 2 without the two `public` rows (on
   production: only the two informational `MISSING_IN_DB` rows for
   `authenticated`). That is the expected new state; keep it for the next
   batch.

10. **Local sign-in.** On `/sign-in` (no Microsoft button), sign in with a
    local account, change its password on `/profile`, sign out, and sign
    in with the new password. `/profile` looks as before (the cms answers
    an empty `entraManagedFields` there, which locks nothing).

11. **Polls and live pings.** Run the query of step 4 again into
    `poll-baseline-after.txt`; `diff poll-baseline-before.txt
    poll-baseline-after.txt` prints nothing unless someone voted
    meanwhile. Have a member vote on an open poll on `/polls`: the vote
    succeeds, the card shows the new count, and a third run of the query
    differs from the second in exactly that poll's option, by one.
    `infra/live-smoke.sh` passed (step 5, or run it now). Then the smoke of
    lane 4B: open the dashboard, `/announcements` with comments, a wiki
    space and page, documents, polls and a course as a member, and the wiki
    and documents as a guest. Optionally, with the browser's network
    panel on `/announcements`: after the stream's `hello` there is one
    `POST /live/subscribe` for all cards, and a comment from a second
    session refreshes only its card.

12. **First hour.** Watch the cms log for the failure lines of the three
    lanes:

    ```bash
    "${COMPOSE[@]}" logs --since 1h cms | grep -E '\[policy\]|\[poll-results\]|\[live-emit\] (status|failed)|error'
    ```

    Expect no output. What a line would mean:
    - `[policy] <policy>: <count> values exceed …`: a visible-id list too
      long for one SQL statement; that list reads empty for every caller
      without the admin/editor bypass until the policy changes
      ([lane 4B runbook](#upgrading-to-the-policy-primitives-batch-9-lane-4b),
      step 3). A 500 with a database bind-parameter error and no
      `[policy]` line is the same limit in a policy that reads whole
      tables. Neither size exists on an intranet;
    - `[poll-results] the tables of api::poll-vote.poll-vote are unknown to
      the query engine`: poll results cannot be counted (every `/polls`
      card missing): roll back and report it;
    - `[live-emit] status=…` or `[live-emit] failed …`: the cms does not
      reach the web's live ingest (`WEB_INTERNAL_URL`,
      `REVALIDATE_SECRET`); pages fall back to polling. Run
      `infra/live-smoke.sh`. The info line `[live-emit] N events in K
      POSTs` is no failure: a bulk write of more than 1000 events, split;
    - any other `error` line: read it, and compare with the batch 8 log.

**What users notice** (worth a short release note):

- `/announcements` shows the cards first and the comment sections as they
  arrive, with fewer requests; a comment on one card refreshes that card
  only.
- A poll card opened before an editor republished the poll still takes the
  vote (batch 8 failed it); only when the republish reordered or replaced
  the answers does the card refuse the click with an error and reload, and
  the next click counts. Poll totals are unchanged.
- Comments and reactions of a wiki page whose space was widened only in an
  unpublished draft (or that was moved into a wider space only in a
  draft, or whose space was never published) are no longer listed to the
  wider audience until the space is published.
- Sign-in is unchanged: e-mail and password, no Microsoft button.

**Rollback: both images together, no database step.** Follow the hint
`infra/deploy.sh` prints. The `:rollback` images are batch 8's; that web
already runs in UTC (label `org.sinnlos.datetime=zone-explicit`), so the
hint adds no override:

```bash
docker tag infra-web:rollback infra-web:latest
docker tag infra-cms:rollback infra-cms:latest
"${COMPOSE[@]}" up -d --no-build web cms
```

Nothing in the database needs undoing: the batch 8 cms ignores the four
columns (they stay, NULL) and the index (Strapi never drops an index it
did not create), and its permission sync does not grant the anonymous
forgot/reset-password actions again, so they stay revoked and harmless
(the web never offered them). Votes stored meanwhile are ordinary rows on
the published poll. After a rollback, polls are addressed by the numeric
id of their published row again, so a poll card opened before a republish
fails its vote again (that row is gone), as in batch 8. **Never
roll back one image alone:** a batch 9 web in front of the batch 8 cms
shows no poll card. Roll forward with `infra/deploy.sh` as usual; that
boot logs no `revoked` line. With Microsoft sign-in switched on (not on
the owner instance), see
[Rolling back after switching Microsoft sign-in on](#rolling-back-after-switching-microsoft-sign-in-on).

**Switching Microsoft sign-in on** is not part of this deploy. It is a
separate, owner-gated change of `infra/.env`, for the employer's instance
and only after the owner's Entra questions are answered: tenant setup,
`ENTRA_SYNC_MODE=dry-run` on staging, review the `[entra]` audit lines,
then `on`, following
[Microsoft Entra ID sign-in](#microsoft-entra-id-sign-in) (and, for an
instance on the old Strapi 5.49 image with the old Microsoft flow, the
last paragraph of the
[lane 4A runbook](#upgrading-to-the-entra-sign-in-batch-9-lane-4a)).

**Rehearsal (2026-09-28, the integrated `batch/9` against `main`
`03d4ea0`):** images of both built and run on Postgres 16 in throwaway
containers, Microsoft sign-in off. The batch 8 cms and web seeded the
database; the new `prod-perm-diff.sql` showed exactly the two `public`
rows of step 2 and the census 0 and 0. The batch 9 cms then booted on it
with `[bootstrap] revoked 2 obsolete permission(s)`, a drift line over
119 actions and `[entra] disabled`; the four nullable columns and the
partial unique index were there, the exchange answered 404 and
forgot/reset-password 403 from inside the network, the permission diff
was empty, and the poll baseline was unchanged. With the **batch 8 web in
front of the batch 9 cms**, a click on a `/polls` card (numeric id, no
answer text) stored the vote on the published row, sign-in, `/profile`,
sign-out and a password change worked, and `infra/live-smoke.sh` passed.
With the batch 9 web, a vote by documentId moved exactly its option by
one in the baseline, the password change on `/profile` worked, and
live-smoke passed. With the **batch 9 web in front of the batch 8 cms**
(a cms rolled back alone), sign-in and live-smoke still worked, but
`/polls` showed no poll card (every results read by documentId answered
404): hence cms and web together. The batch 8 cms booted on the upgraded
database without a database step (drift none over its 117 actions, the
columns ignored, forgot-password still 403), both batch 8 images together
voted normally again, and rolling forward gave the same baseline and a
passing live-smoke. Not exercised here: the Traefik/Caddy edge on a public
domain and a real Microsoft tenant (owner-gated).

#### Upgrading to the policy primitives (batch 9, lane 4B)

This release (branch `refactor/policy-primitives`, on `batch/8` `5f2eac0`)
rebuilds the cms read and ownership policies on shared helpers. What each
role can read and write is unchanged, except for one visible fix (wiki
threads follow the published space) and one defence-in-depth point (callers
without a user id), both at the end of this list:

- **Policy primitives and factories (PL01, PL02).** One role check
  (`hasRole`), one way to add a policy's filter (`narrowFilters`, always
  `$and`), one id lookup (`findByRef`), and three factories in
  `apps/cms/src/utils/policy-factories.ts` that the fourteen read and
  ownership policies now call. A per-role snapshot of every policy-guarded
  read, recorded on the previous release, is unchanged on SQLite and
  Postgres (`apps/cms/src/integration/role-read-snapshot.integration.test.ts`).
- **Comment and reaction threads (PL04).** A read that pins one thread (the
  web's comment sections) checks only that target instead of resolving
  every visible announcement and wiki page. A caller's role, department and
  teams are read once per request.
- **Bind-parameter guard (PL04).** One SQL statement binds at most 65535
  values on Postgres and 32766 on SQLite. A policy that binds a list of
  visible ids without reading a whole table first (wiki pages and
  revisions, lessons, the wiki-page anchors of comment and reaction lists)
  now checks the list against that limit minus 1000 values of headroom,
  which the request's own filters, status and pagination need. A longer
  list answers with an empty result and logs
  `[policy] <policy>: <count> values exceed ...` at error level. Past the
  engine limit, where such a list used to fail with a 500, the answer is
  now an empty 200; in the window of about 1000 values just below the
  limit, where the previous release still returned the rows, it is empty
  too (an accepted trade-off). The announcement, document, quick-link and
  poll policies, the wiki spaces and the team lookup read whole tables
  with `populate`: past the engine limit they still fail with a 500 inside
  Strapi, before any guard runs, with no data returned and no `[policy]`
  line ([architecture.md §5.63](./architecture.md)). Nothing near either
  size exists on an intranet; the log line, or a 500 with a database
  bind-parameter error, is the signal to change that policy.
- **Wiki threads follow the published space.** Comment and reaction lists
  now judge a wiki page the way a single thread and the page itself are
  judged: by its published row, or by its draft when it was never
  published. The previous release showed a page's discussions in these
  lists, while the page itself stayed hidden, in three cases that are now
  closed: a wiki space whose visibility was widened only in an unpublished
  draft, a page moved into a wider space only in its draft, and a
  published page whose space was never published (its published row has
  no space, its draft links the draft-only space). Depending on that
  space's visibility, this reached up to every signed-in role, guest
  included.
- **Callers without a user id.** A request whose user carries no numeric
  id owns no row and reads like an anonymous one. users-permissions always
  sets one, so no real request is affected.

**A normal deploy with `infra/deploy.sh`.** Only the cms changes; no
schema, env, edge or grant change, nothing to migrate.

1. **Deploy:** `infra/deploy.sh`.
2. **Smoke:** open the dashboard, announcements with comments, a wiki space
   and page, documents, polls and a course as a member, and the wiki and
   documents as a guest.
3. **First hour:** watch the cms log for policy errors and guard lines
   (on a standalone Caddy box, drop the second `-f`):

   ```bash
   cd /opt/sinnlos
   docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
     logs --since 1h cms | grep -E '\[policy\]|error'
   ```

   Expect no output (a policy that throws shows up as an `error` line, and
   its request as a 500). A `[policy]` line names the policy and the list
   size that did not fit; that list reads empty for every caller whose
   visible ids exceed the limit (admin and editor bypass it) until that
   policy is changed. For the policies that read whole tables with
   `populate` (announcements, documents, quick links, polls, wiki spaces,
   the team lookup) the signal is a 500 with a database bind-parameter
   error in the log instead, and no `[policy]` line.

**Rollback:** the batch 8 image runs on the same database as it is (no
schema or data change), with the commands `infra/deploy.sh` prints.

**Rehearsal (integration harness, SQLite and Postgres 16, compared with
`5f2eac0`):** the per-role snapshot of every guarded read was identical;
one comment-thread read ran 22 (announcement) or 24 (wiki page) SQL
statements instead of 27, without loading every announcement and page; a
wiki space widened only in its draft opened its page's thread before and
does not now, on both the thread and the list, and a wider review matrix
(6,084 read keys per engine) changed only by losing threads of the three
wiki cases above; numeric id and documentId on comment delete, classified
update and RSVP update answered exactly as before (owner 204/200, stranger
403; a missing or malformed id is 403 at the ownership policy for
non-bypass callers on classified update/delete and RSVP update, and 404
for the bypass roles and for comment delete); past the engine limit
(33,000 visible wiki pages on SQLite and 66,000 on Postgres in the
rehearsal, 32,767 and 65,536 in the integration test) the previous release
answered the member's page list and full comment list with a 500 and this
one answers an empty 200 with the log line, while a single thread and the
admin list were unaffected. The guard already answers the page list empty
from 31,767 (SQLite) or 64,536 (Postgres) visible pages, and the full
comment list from one page fewer plus an announcement, where the previous
release still served the rows.

#### Upgrading to the live contract and poll documentIds (batch 9, lane 4C)

This release (branch `feat/live-contract-and-poll-ids`, on `batch/8`
`5f2eac0`) changes how the cms and the web address polls and talk about
live events, and how the web loads comment sections. Nobody's permissions
change:

- **Polls by documentId (DA01).** `POST /api/polls/:id/vote` and
  `GET /api/polls/:id/results` take the poll's documentId, which the web now
  sends, or, as before, the numeric id of its published row. The vote still
  lands on the published row. An editor republishing a poll while someone
  has `/polls` open no longer breaks that person's vote, unless the
  republish reordered or replaced the answers: the web also sends the
  answer text the card showed, and the cms refuses a vote whose text is no
  longer at that position (400 `Poll options changed`; the card shows its
  error and reloads) instead of recording a different answer. A draft
  row's id and a poll that was never published answer 404, like a missing
  poll.
- **Poll results in one SQL statement (FX20).** The database counts the
  results with one `GROUP BY` statement. The rule is the one of batch 8
  (each voter's first vote counts; votes of a deleted account count on
  their own), so every total stays what it is. What changes: a results read
  that races a parallel vote's cleanup can no longer count a duplicate that
  was just removed as a separate vote.
- **Live events (LF04, LF01).** The cms and the web share one definition of
  the live events and channel names. The cms sends at most 1000 events per
  POST to the web, which refuses a bigger body with 400. That cap only
  matters for more than 1000 distinct events committed together (a bulk
  script, an import, anything writing them in one transaction): such a
  burst used to be refused and lost as a whole, notification pings
  included. An ordinary announcement fan-out writes one notification per
  transaction, so it already reached the web in small POSTs and was not
  affected (rehearsed with 1210 recipients: 31 to 34 POSTs of at most 54
  events each, before and after this release). A split burst logs
  `[live-emit] N events in K POSTs (at most 1000 each)`.
- **Comment sections (WD04).** `/announcements` loads the comments and
  reactions of all cards in one batch (10 cards: 11 cms requests instead of
  20), shows the cards first and the sections as they arrive, and keeps
  them fresh with one poll interval and one live subscription request per
  page. A comment on one card refreshes that card only. With live events
  off (`LIVE_EVENTS_DISABLED=1`, or `DEMO_MODE`), returning to the tab
  still refreshes every section at once, in one batch.

**A normal deploy of cms and web together with `infra/deploy.sh`.** No
schema, permission, env, route or edge change; `infra/diagnostics/prod-perm-diff.sql`
and the routes golden are unchanged. Deploy both together: the new web
addresses polls by documentId, which a batch 8 cms answers with 404 (no
poll cards until the new cms runs), while the new cms still accepts the
numeric ids of a web that has not restarted yet. The checks use the helpers
of the batch 8 section (on a standalone Caddy box, drop the second `-f`):

```bash
cd /opt/sinnlos
COMPOSE=(docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml)
psql_db() { "${COMPOSE[@]}" exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@"; }
```

1. **Before: the poll baseline** (read-only). The counted votes per option
   of every published poll, by the rule the results use (it never shows
   who voted):

   ```bash
   psql_db -X <<'SQL' | tee poll-baseline-before.txt
   BEGIN TRANSACTION READ ONLY;
   WITH ranked AS (
     SELECT vp.poll_id, v.option_index, vv.user_id,
            row_number() OVER (PARTITION BY vp.poll_id, vv.user_id ORDER BY v.id) AS nth
     FROM poll_votes v
     JOIN poll_votes_poll_lnk vp ON vp.poll_vote_id = v.id
     LEFT JOIN poll_votes_voter_lnk vv ON vv.poll_vote_id = v.id
   )
   SELECT p.document_id, p.question AS poll, r.option_index, count(*) AS votes
   FROM ranked r
   JOIN polls p ON p.id = r.poll_id
   WHERE p.published_at IS NOT NULL AND (r.nth = 1 OR r.user_id IS NULL)
   GROUP BY p.document_id, p.question, r.option_index
   ORDER BY p.document_id, r.option_index;
   ROLLBACK;
   SQL
   ```

   `option_index` 0 is a poll's first answer. The numbers equal what the
   poll cards on `/polls` show now.
2. **Deploy:** `infra/deploy.sh`. It runs `infra/live-smoke.sh` when the
   demo credentials file is readable; otherwise (`live-smoke SKIPPED`) run
   `infra/live-smoke.sh` by hand. It must pass: it proves the cms still
   reaches the web's live ingest and a ping reaches an open stream.
3. **After: the same totals.** Run the query of step 1 again into
   `poll-baseline-after.txt`; `diff poll-baseline-before.txt
   poll-baseline-after.txt` shows nothing unless someone voted meanwhile.
   Then have a member vote on an open poll on `/polls`: the vote succeeds,
   the card shows the new count, and a third run of the query differs from
   the second in exactly that poll's option, by one. The cards on `/polls`
   show the query's numbers.
4. **After: logs.**
   `"${COMPOSE[@]}" logs --since 30m cms | grep -E '\[live-emit\] (status|failed)|\[poll-results\]'`
   prints nothing. A `[poll-results] the tables of api::poll-vote.poll-vote
   are unknown to the query engine` error would mean the results cannot be
   counted (every `/polls` card missing): roll back and report it.
   Optionally open `/announcements` with the browser's network panel: after
   the stream's `hello` there is one `POST /live/subscribe` for all cards,
   and a comment from a second session refreshes only its card.

**Rollback:** re-up both previous images with the commands
`infra/deploy.sh` prints (the web one with
`-f infra/docker-compose.web-legacy-tz.yml` only if it predates batch 8).
Never roll back the cms alone: the new web's documentId addresses would get
404 from the batch 8 cms. Nothing in the database changes, so the previous
images run on it as they are.

**Rehearsal (2026-09-28, Postgres 16 in a throwaway container and SQLite,
the real cms booted in process by the integration harness):** a vote by
documentId landed on the published row before and after a republish, the
earlier vote followed the republish, a second vote was refused, results by
documentId equalled those by the published row id, and a draft row id, the
replaced published id and a never-published poll answered like a missing
poll; on company-wide, anonymous, guest-visible, targeted and empty polls
the results equalled `SELECT count(*)` per option and the query engine's
joined select; the counting statement equalled the batch 8 rule on seeded
random polls with duplicates and deleted accounts, ran as one statement,
and parallel votes of one voter never showed as more than one vote; the
baseline query of step 1 gave exactly the results' counts on Postgres 16,
a stored duplicate vote included. 1200 notification rows for 1200
recipients, written in one transaction through the real lifecycle
subscriber of a booted cms, reached a stand-in web ingest (400 above 1000
events, like the web) in POSTs of 1000 and 200 events, all 1200 delivered
(batch 8 sent them in one POST, which the 400 lost); an ordinary fan-out
to 1210 recipients, one notification per transaction, arrived in 31 POSTs
of at most 54 events (batch 8: 34 of at most 48), all accepted. Against
the built cms and web images of this branch on Postgres 16:
`infra/live-smoke.sh` passed; on `/announcements` with 10 cards the page
sent one `POST /live/subscribe` instead of 10, a comment on card 3
refreshed card 3 only, the server render made 17 cms requests instead of
26, and a tab regain 16 cms requests and 4 Server Actions instead of 45
and 23 (headless browser). Not exercised: real tab switching (the regain
was simulated by switching the page's visibility state) and the
Traefik/Caddy edge on a public domain.

Fix round after review (2026-09-28, the same setup, a headless browser
against the built images): a `/polls` card rendered before an admin-panel
republish that reordered the answers (`Alpha, Beta, Gamma` to
`Gamma, Alpha, Beta`) and then clicked on `Alpha` got 400
`Poll options changed`, stored nothing, showed its error and reloaded with
the new order; the next click stored `Alpha` (index 1) on the new published
row. The web from before the fix stored that stale click as `Gamma`
(index 0), which is what this check prevents; a vote body without the
answer text (that older web) is still accepted. With
`LIVE_EVENTS_DISABLED=1` a regained `/announcements` tab showed a comment
posted while it was hidden after 0.2-0.3 s, in one batched read of all
sections (before the fix: 3.6-6.6 s, at the next 10 s tick); with live
events on, a regain still made exactly one batched read (the stream's
catch-up), no second one. `infra/live-smoke.sh` passed.

#### Upgrading to the Entra sign-in (batch 9, lane 4A)

Lane 4A (D-ENTRA-01) adds the optional Microsoft
Entra ID sign-in ([Microsoft Entra ID sign-in](#microsoft-entra-id-sign-in))
and replaces the old, non-working Microsoft path. **With `ENTRA_ENABLED`
unset** (the owner instance) it is a normal deploy of cms and web together;
the first boot changes, by itself:

- **Schema:** four nullable, private columns on `up_users`
  (`entra_tenant_id`, `role_source`, `entra_applied_role`,
  `entra_manager_oid`) and the unique index `up_users_entra_identity_uq`
  on (`entra_tenant_id`, `microsoft_oid`). Every existing row keeps NULL
  there: its role is *manual* and never touched by a sign-in.
- **Permissions:** the anonymous `auth.forgotPassword` and
  `auth.resetPassword` (users-permissions' first-boot defaults of the
  `public` role) are revoked; the web has no UI for either, and they would
  hand an Entra-only account a local password. The boot logs
  `[bootstrap] revoked 2 obsolete permission(s)` once (fewer if an admin
  removed them before), and the drift line now checks 119 managed actions
  (117 before).
- **Providers:** Strapi's own Microsoft provider (`/api/connect/microsoft`)
  is forced off with its key and secret cleared (it was off); e-mail
  sign-in stays on. The cms logs `[entra] disabled`.
- **Self-registration** (`LOCAL_REGISTRATION=1` only) accepts `displayName`
  as its only extra field; the web sends nothing else.
- **Web:** unchanged for local users. The sign-in page explains Microsoft
  error codes, `/api/me` answers an empty `entraManagedFields`.
- **Env:** compose passes the new `ENTRA_*` keys with their defaults; the
  cms no longer gets `MS_CLIENT_SECRET` and the web no longer gets
  `AUTH_MICROSOFT_ENTRA_ID_ISSUER`. `MS_*` lines left in `infra/.env` are
  ignored; `infra/deploy.sh` notes them (`NOTE: MS_CLIENT_ID/MS_CLIENT_SECRET
  are set …`), and they can be deleted. When they are a real app
  registration (a GUID `MS_CLIENT_ID` plus `MS_CLIENT_SECRET`) it warns
  instead (`WARNING: infra/.env holds a Microsoft app registration …`):
  if Microsoft sign-in works with the running release, it is **off** after
  this deploy until `ENTRA_ENABLED=1`, see the last paragraph of this
  section. Both only inform (exit code 0). The old refusal ("Microsoft
  sign-in is configured …") is gone.

**Before the deploy**

1. `infra/deploy.sh --check` prints `Preflight OK` (a note about leftover
   `MS_*` lines is fine; the *app registration* warning is fine only if
   nobody signs in with Microsoft on this instance, otherwise follow the
   last paragraph of this section first).
2. Optional, read-only: accounts from the old Microsoft flow, which the new
   sign-in would not adopt (expected 0 and 0 on the owner instance):

   ```bash
   docker exec -i infra-db-1 sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
   SELECT count(*) FILTER (WHERE provider = 'microsoft') AS microsoft_rows,
          count(*) FILTER (WHERE microsoft_oid IS NOT NULL) AS rows_with_oid
     FROM up_users;
   SQL
   ```

**Deploy:** `infra/deploy.sh` (cms and web together; it runs live-smoke).

**After the deploy**

1. The cms log (`docker logs infra-cms-1 2>&1 | grep -E '\[entra\]|\[bootstrap\]'`):
   `[entra] disabled`, `[bootstrap] revoked 2 obsolete permission(s)` (first
   boot only) and `[bootstrap] permission drift: none (report-only check of
   119 managed actions)`. `[bootstrap] users-permissions providers synced
   (email=on, microsoft=off)` may also appear once, when Strapi's own
   Microsoft provider was on or still held a client id or secret (from the
   Strapi 5.49 era); they are now off and cleared, which is expected.
2. The columns and the index (4 rows, then 1):

   ```bash
   docker exec -i infra-db-1 sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
   SELECT column_name FROM information_schema.columns
    WHERE table_name = 'up_users'
      AND column_name IN ('entra_tenant_id', 'role_source', 'entra_applied_role', 'entra_manager_oid');
   SELECT indexname FROM pg_indexes WHERE indexname = 'up_users_entra_identity_uq';
   SQL
   ```

3. The exchange is off and the anonymous reset flow closed, asked from
   inside the stack (the edge sends `/api/auth/*` to the web): `404` and
   `403`:

   ```bash
   docker exec infra-web-1 node -e "fetch('http://cms:1337/api/auth/entra/exchange',{method:'POST'}).then(r=>console.log(r.status))"
   docker exec infra-web-1 node -e "fetch('http://cms:1337/api/auth/forgot-password',{method:'POST',headers:{'content-type':'application/json'},body:'{\"email\":\"nobody@example.com\"}'}).then(r=>console.log(r.status))"
   ```

4. `infra/diagnostics/prod-perm-diff.sql` (§3.8 intro): nothing new; the
   two public rows are gone and no longer expected.
5. Sign in locally, change a password on `/profile`, sign out; no Microsoft
   button on `/sign-in`.

**Rollback:** follow the hint `deploy.sh` prints (both images together). The
previous cms ignores the four columns (they stay, NULL) and the index
(harmless; Strapi never drops an index it did not create); its permission
sync does not grant the public forgot/reset-password actions again, so they
stay revoked. Nothing needs undoing in the database. This holds with
`ENTRA_ENABLED` unset; after Microsoft sign-in was switched on, see
[Rolling back after switching Microsoft sign-in on](#rolling-back-after-switching-microsoft-sign-in-on).

**Switching Microsoft sign-in on** (later, and only after the owner's Entra
questions are answered) is a separate change of `infra/.env`: follow
[Microsoft Entra ID sign-in](#microsoft-entra-id-sign-in): the tenant setup,
`ENTRA_SYNC_MODE=dry-run` on staging, review the `[entra]` audit lines, then
`on`.

**An instance that still signs users in with the old Microsoft flow** (the
Strapi 5.49 image from before PR #39) must leave it now; it cannot stay on
that image. `infra/deploy.sh` warns about it (`WARNING: infra/.env holds a
Microsoft app registration …`) while `ENTRA_ENABLED` is unset: deployed like
that, Microsoft sign-in is off and only local accounts can sign in, which
the old flow's accounts are not (no password). Work through the upgrade
notes it does not run yet (newest first, see the top of this guide), with
these Entra steps:

1. Tenant: add the app roles, set *Assignment required*, assign the roles,
   and remove the `…/api/connect/microsoft/callback` redirect URI and the
   `GroupMember.Read.All` permission
   ([Microsoft Entra ID sign-in](#microsoft-entra-id-sign-in), steps 1-5).
2. `infra/.env`: `ENTRA_ENABLED=1`, the `MS_*` keys (tenant GUID, not
   `common`), `ENTRA_EXCHANGE_SECRET`, `ENTRA_SYNC_MODE=dry-run`, and
   `AUTH_LOCAL_ENABLED=1` if a local admin account must keep working.
3. Accounts the old flow created (`provider = microsoft`, e-mail = the UPN)
   are **not** adopted: they carry no tenant id, so the new sign-in answers
   *"already exists"* for their e-mail. List them
   (`SELECT id, username, email FROM up_users WHERE provider = 'microsoft' ORDER BY id;`)
   and bind each one ([the 409 procedure](#an-e-mail-address-that-already-has-an-account-409):
   tenant id and object id, lower case), or delete the ones nobody needs.
   Their roles stay as they are (*manual*) until an admin hands them to
   Entra.
4. Deploy, review the `[entra]` lines in dry-run, then switch to `on`.
   Without `AUTH_LOCAL_ENABLED=1`, `infra/deploy.sh`'s live-smoke skips its
   sign-in steps (from batch 10 on; before, it failed the deploy:
   [Staging dry-run, then on](#staging-dry-run-then-on), step 1).
5. Rollback: prefer switching back in `infra/.env` (`ENTRA_ENABLED=0` or
   `AUTH_LOCAL_ENABLED=1`) over an image rollback. An image rollback needs
   `AUTH_LOCAL_ENABLED=1` in `infra/.env` before the old images start (a
   web from before batch 9 shows no e-mail form while `MS_CLIENT_ID` and
   `MS_CLIENT_SECRET` are set), and this release's cms restarted on it
   first, which turns e-mail sign-in back on. Going back to the 5.49 image
   also needs the Microsoft provider re-enabled in the Strapi admin panel,
   with its client id and secret
   ([Rolling back after switching Microsoft sign-in on](#rolling-back-after-switching-microsoft-sign-in-on),
   step 2).

#### Deploying batch 8 (2026-09-28)

Batch 8 (branch `batch/8`, on `main` `c219034`, which production runs since
2026-09-28 15:03 CEST) ships three lanes and one fix from their integration
in one deploy. The runbooks below explain each change in detail; **this
section is the one sequence to follow**:

- [the cms bootstrap split](#upgrading-to-the-cms-bootstrap-split-batch-8-lane-3b)
  (lane 3B): the permission setup runs from modules with one role
  vocabulary, as one set-based transaction; the cms refuses to start on a
  grant for an action no loaded controller has, and every boot logs one
  drift line. It no longer sends `X-Powered-By`, uses implicit TLS on SMTP
  port 465 and reads `DIGESTS_DISABLED` as a boolean. Nobody's permissions
  change;
- the Strapi integration suite (lane 3C): tests and CI only, nothing to
  deploy. Owner: once the CI job `integration · SQLite + Postgres 16` runs
  stably, mark it as a required check in branch protection;
- [the web datetime port](#upgrading-to-the-web-datetime-port-batch-8-lane-3a)
  (lane 3A): the web formats and computes every date in `APP_TIME_ZONE` and
  runs in UTC; an event that is running stays under *Upcoming*; the org
  chart shows people in a manager loop with a warning;
- **one ballot per voter** (found by the integration suite, not in a
  lane): parallel votes of one user could all be stored and were all
  counted (up to 8 of 8 on Postgres 16). A vote cannot be changed, so the
  results now count each voter's first vote only, and a vote removes the
  voter's later rows for that poll right after it is stored.

It is **one normal deploy of cms and web together** with `infra/deploy.sh`:
no schema, permission, edge or Traefik change, nothing to migrate, and no
env change unless step 3 says so. Do not add `TZ` to `infra/.env`;
`APP_TIME_ZONE` stays as it is. The web container is recreated with
`TZ=UTC` (image and compose) and the label
`org.sinnlos.datetime=zone-explicit`, the cms container with the new
bootstrap. `infra/diagnostics/prod-perm-diff.sql` is unchanged by this
batch.

Set these on the host, in your checkout (e.g. `/opt/sinnlos`), for the
checks below (on a standalone Caddy box, drop the second `-f`):

```bash
cd /opt/sinnlos
COMPOSE=(docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml)
psql_db() { "${COMPOSE[@]}" exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@"; }
```

**Before the deploy** (all read-only)

1. **Fast-forward to the new `main` and validate**, deploying nothing:

   ```bash
   git pull --ff-only
   git log -1 --oneline      # the batch 8 merge
   infra/deploy.sh --check
   ```

2. **Permissions: the post-batch-7 state.**

   ```bash
   psql_db -X < infra/diagnostics/prod-perm-diff.sql
   ```

   Expected on production: only the two informational `MISSING_IN_DB`
   rows for `authenticated` (`plugin::users-permissions.auth.getSessions`
   and `…auth.revokeSession`), exactly as after the batch 7 deploy. Keep
   the output for step 8. An `EXTRA_IN_DB` row on an action the code
   manages (one someone granted in the admin panel) shows up in step 6 as a
   drift warning instead of `none`.

3. **Two env values whose meaning changes.** Print only these two lines of
   `infra/.env` (the file holds secrets):

   ```bash
   grep -E '^(SMTP_PORT|DIGESTS_DISABLED)=' infra/.env
   ```

   - `SMTP_PORT`: unset (compose then uses `587`) or `587`: nothing
     changes. `465` now uses implicit TLS: the digests could not be sent
     before (the connection timed out waiting for a plain-text greeting)
     and are sent from this deploy on, so the next 07:30 run mails the
     users who opted in. Any other port still requires STARTTLS, as before.
   - `DIGESTS_DISABLED`: unset, empty, `0` and a plain `1` behave as
     before. `true`, `yes` or `on` (any case), or `1` with blanks around
     it, used to leave the digests on and switch them off from this deploy
     on: set `0` to keep them on, or `1` to switch them off, before you
     deploy (`infra/deploy.sh --check` still only understands `1` until
     batch 5).

4. **Poll votes stored more than once.** The first query lists the voters
   with more than one vote row on a poll (by numeric user id; it never
   shows how anyone voted), the second what the results of those polls
   show now and after this deploy:

   ```bash
   psql_db -X <<'SQL'
   BEGIN TRANSACTION READ ONLY;
   SELECT vp.poll_id, p.question AS poll, vv.user_id AS voter_id, count(*) AS vote_rows
   FROM poll_votes v
   JOIN poll_votes_poll_lnk vp ON vp.poll_vote_id = v.id
   JOIN polls p ON p.id = vp.poll_id
   JOIN poll_votes_voter_lnk vv ON vv.poll_vote_id = v.id
   GROUP BY vp.poll_id, p.question, vv.user_id
   HAVING count(*) > 1
   ORDER BY vp.poll_id, vv.user_id;

   WITH ranked AS (
     SELECT vp.poll_id, v.option_index, vv.user_id,
            row_number() OVER (PARTITION BY vp.poll_id, vv.user_id ORDER BY v.id) AS nth
     FROM poll_votes v
     JOIN poll_votes_poll_lnk vp ON vp.poll_vote_id = v.id
     LEFT JOIN poll_votes_voter_lnk vv ON vv.poll_vote_id = v.id
   ), per_option AS (
     SELECT poll_id, option_index,
            count(*) AS votes_now,
            count(*) FILTER (WHERE nth = 1 OR user_id IS NULL) AS votes_after
     FROM ranked
     GROUP BY poll_id, option_index
   )
   SELECT o.poll_id, p.question AS poll, o.option_index, o.votes_now, o.votes_after,
          sum(o.votes_now) OVER w AS total_now, sum(o.votes_after) OVER w AS total_after
   FROM per_option o
   JOIN polls p ON p.id = o.poll_id
   WHERE o.poll_id IN (SELECT poll_id FROM ranked WHERE nth > 1 AND user_id IS NOT NULL)
   WINDOW w AS (PARTITION BY o.poll_id)
   ORDER BY o.poll_id, o.option_index;
   ROLLBACK;
   SQL
   ```

   No rows: no poll result changes. Otherwise, from this deploy on, each
   listed poll counts one vote per voter, the voter's first one (the
   lowest row id; a vote cannot be changed, so the first accepted vote is
   the voter's answer): its total drops from `total_now` to `total_after`,
   and each option (`option_index` 0 is the first answer) from `votes_now`
   to `votes_after`. A vote whose voter account was deleted still counts on
   its own. The extra rows stay stored and count for nothing; nothing
   needs to remove them. Keep the output for step 11.

**Deploy**

5. Run `infra/deploy.sh` on the Traefik host. It runs the preflight, takes
   the pre-deploy backup, tags the running images `:rollback`, rebuilds and
   restarts **cms and web together**, and runs `infra/live-smoke.sh` when
   the demo credentials file is readable (otherwise it logs `live-smoke
   SKIPPED`: run `infra/live-smoke.sh` by hand). On a
   standalone Caddy box, run `infra/backup/pg-backup.sh`, then
   `docker compose up -d --build` from `infra/`. If the new cms does not
   start and its log shows `[bootstrap] N granted action(s) match no loaded
   controller action: …`, the code and a plugin or controller disagree:
   roll back (below) and report that line.

**After the deploy**

6. **cms boot.**

   ```bash
   "${COMPOSE[@]}" logs --since 30m cms | grep '\[bootstrap\]'
   # [bootstrap] permission drift: none (report-only check of 117 managed actions)
   ```

   Expected: exactly this one line, and no `granted` or `revoked` line
   (the new sync finds nothing to write on a database that booted batch 7).
   A warning `[bootstrap] permission drift (report-only, nothing revoked):
   N grant(s) on managed actions that the code does not grant: …` lists
   `<role> <action>` pairs added in the admin panel: decide per pair (keep,
   or remove in the admin panel); nothing is removed automatically.

7. **Web zones.**

   ```bash
   "${COMPOSE[@]}" logs web | grep '\[datetime\]'
   # [datetime] web process time zone UTC, APP_TIME_ZONE Europe/Berlin
   "${COMPOSE[@]}" exec -T web sh -c 'echo "$TZ"'   # UTC
   ```

   A second line `[datetime] The web process runs in …, not UTC` means a
   compose or orchestrator setting still overrides `TZ` (for example a
   leftover `-f infra/docker-compose.web-legacy-tz.yml`): harmless for the
   dates, but remove it.

8. **Permissions after.** `psql_db -X < infra/diagnostics/prod-perm-diff.sql`
   gives the same result as step 2.

9. **Edge.** `curl -sI https://<your web origin>/api/events | grep -i x-powered-by`
   prints nothing (the edge sends `/api/*` to the cms, which sent the
   header until this deploy).

10. **Pages.** `/events` (list and month view): events show their usual
    times, an event running now (a multi-day event after its first day, an
    all-day event on its day) is under *Upcoming*, and a multi-day event
    shows its end day. `/marketplace` and one ad: the expiry dates are
    unchanged. `/people/org-chart`: normally unchanged. If a Manager field
    forms a loop or points to the person themselves, every user sees a
    warning banner that counts the people shown at the top level for that
    reason; each of them is marked ("Manager chain loops back here" or
    "Set as their own manager"), and the rest of a loop appears beneath
    the marked person. Follow the Manager field from a marked person to
    find the loop and fix it in the admin panel (Content Manager → User).

11. **Poll results.** `/polls` shows the same results as before, except on
    the polls step 4 listed: their totals and option counts now match
    `total_after` and `votes_after`, and for a voter step 4 listed, the
    option marked as their vote (the check mark) is their first vote,
    which can be another option than the one marked before.

**What users notice** (worth a short release note):

- Dates and times read as before. An event that is running stays under
  *Upcoming*, a multi-day event shows its end day, an event whose end
  equals its start shows only its start, and "yesterday"/"today" follow
  the calendar day, in the user's language. The org chart lists people in
  a manager loop (or set as their own manager) with a warning instead of
  leaving them out with everyone below them.
- Where one person's vote on a poll was stored more than once, the result
  counts it once (their first vote), and the poll marks that vote as
  theirs.
- With `SMTP_PORT=465`, users who opted in start receiving digests.

**Rollback: both images together, with the web override.** Follow the
hint `infra/deploy.sh` prints. The `:rollback` images are batch 7's: that
web renders dates in its process zone and refuses to start in UTC, so the
hint adds `-f infra/docker-compose.web-legacy-tz.yml`, which runs it in
`APP_TIME_ZONE` as before:

```bash
docker tag infra-web:rollback infra-web:latest
docker tag infra-cms:rollback infra-cms:latest
"${COMPOSE[@]}" -f infra/docker-compose.web-legacy-tz.yml up -d --no-build web cms
"${COMPOSE[@]}" exec -T web sh -c 'echo "$TZ"'   # your APP_TIME_ZONE
```

Without the override, the batch 7 web answers every request with 500 and
logs `The web process runs in UTC …, not in APP_TIME_ZONE …`. Nothing in
the database needs undoing: no schema, permission or data change, and the
batch 7 cms finds nothing to sync. After a rollback, poll results count
every stored row again (step 4's polls show `total_now` again), digests
on port 465 stop, a `DIGESTS_DISABLED` of `true`/`yes`/`on` no longer
switches them off, and `X-Powered-By` is back. Roll forward with
`infra/deploy.sh` as usual: it uses the live compose files only, so the web
runs in UTC again. Custom orchestrators (the Azure Container Apps recipe):
do not set `TZ` for the new web (the image sets `TZ=UTC`); a web image
from before this release needs `TZ` equal to `APP_TIME_ZONE`.

#### Upgrading to the cms bootstrap split (batch 8, lane 3B)

This release (branch `refactor/cms-bootstrap`, on `batch/7` `0ea7107`)
restructures how the cms seeds its roles and permissions and tidies its
config. Nobody's permissions change:

- **Bootstrap modules and one role vocabulary (S02, B01, B02).** The grant
  tables moved from `apps/cms/src/index.ts` to
  `apps/cms/src/bootstrap/permission-matrix.ts` (still re-exported by
  `index.ts`), the role names to `bootstrap/roles.ts`. The boot order is
  unchanged; `infra/diagnostics/prod-perm-diff.sql` regenerates
  byte-identical.
- **Unknown actions stop the boot (B04).** Before it writes anything, the
  permission sync checks every granted action against the controllers
  Strapi loaded. A mismatch (a typo, a renamed action, a changed plugin)
  refuses to start with `[bootstrap] N granted action(s) match no loaded
  controller action: <list>` instead of leaving the feature at 403.
- **One transaction, far fewer queries (B03).** The sync reads the roles
  and the permissions once, computes what is missing and what to revoke,
  and writes only that, in one transaction; a failed write rolls the whole
  sync back and stops the boot. A boot on an up-to-date database runs 3
  statements on `up_permissions` instead of about 600.
- **Drift line.** Every boot reports grants on actions the code manages
  that it does not want, for example one added in the admin panel. It only
  reports them; nothing is revoked that is not listed in
  `REVOKED_PERMISSIONS`.
- **Config (B05).** The cms no longer sends `X-Powered-By`. `CORS_ORIGIN`
  is read through Strapi's `env()` (same values; blanks around commas are
  ignored). An absolute SQLite `DATABASE_FILENAME` is used as given. Until
  this release an absolute value was placed under `apps/cms` (`/data/x.db`
  became `apps/cms/data/x.db`); on an existing SQLite install, move that
  file to the absolute path, or switch to the equivalent relative value,
  before upgrading, otherwise the cms starts on a new, empty database.
  Relative values and Postgres (production) are unaffected. SMTP on
  port 465 now uses implicit TLS; any other port, the default 587 included,
  still requires STARTTLS as before. `DIGESTS_DISABLED` also accepts
  `true`, `yes` and `on` (`infra/deploy.sh --check` still only knows `1`).
  `apps/cms` declares `engines` `^22.13.0 || ^24.0.0` like the root.

**A normal deploy with `infra/deploy.sh`.** Only the cms changes; no
schema, edge or grant change, nothing to migrate. The checks use the
helpers of the batch 7 section below (on a standalone Caddy box, drop the
second `-f`):

```bash
cd /opt/sinnlos
COMPOSE=(docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml)
psql_db() { "${COMPOSE[@]}" exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@"; }
```

1. **Before:** check `SMTP_PORT` in `infra/.env`. With `587` (or unset)
   nothing changes. With `465` the digests could not be sent before (the
   connection timed out waiting for a plain-text greeting); from this
   deploy on they are, so the next 07:30 run mails the users who opted in.
   Also run `grep -E '^DIGESTS_DISABLED=' infra/.env`. Unset, empty, `0`
   and a plain `1` behave as before. `true`, `yes` or `on` (any case), and
   `1` with blanks around it, used to leave the digests on and switch them
   off from this deploy on: set `0` to keep them, or `1` to switch them off.
   `infra/deploy.sh --check` still only understands `1` until batch 5.
2. **Deploy:** `infra/deploy.sh`.
3. **Boot log:** `"${COMPOSE[@]}" logs cms | grep '\[bootstrap\]'`. On a
   database that booted batch 7, expect no `granted` or `revoked` line and
   exactly one `[bootstrap] permission drift: none (report-only check of
   117 managed actions)`. A drift warning instead lists
   `<role> <action>` pairs: grants someone added in the admin panel on an
   action the code manages; decide per pair (keep, or remove in the admin
   panel). The two `authenticated` rows `auth.getSessions`/`revokeSession`
   are plugin defaults, not managed, and never appear there. The line covers
   only managed actions and never reports duplicate rows; the
   `prod-perm-diff.sql` run of step 4 remains the complete check.
4. **After:** `psql_db -X < infra/diagnostics/prod-perm-diff.sql` gives the
   same result as after the batch 7 deploy (on production only the two
   informational `MISSING_IN_DB` `authenticated` rows above).
   `curl -sI https://<your web origin>/api/events | grep -i x-powered-by`
   prints nothing (the edge sends `/api/*` to the cms).

**Rollback:** the batch 7 image runs on the same database as it is (no
schema or data change; its sync finds nothing to do), with the commands
`infra/deploy.sh` prints. With `SMTP_PORT=465` the digests stop again, and
a `DIGESTS_DISABLED` of `true`/`yes`/`on` no longer switches them off.

**Rehearsal (Postgres 16 stand-in, database first booted by the batch 7
code `0ea7107`):** the branch boot left `up_permissions` identical (515
rows, the S02 snapshot plus the 13 plugin first-boot defaults), wrote no
permission row and ran 152 SQL statements instead of 844 (3 instead of 598
on `up_permissions`); a fresh database received the same 515 rows in one
transaction; a leftover revoked grant was deleted and an admin-panel grant
reported (the same pair `prod-perm-diff.sql` lists as `EXTRA_IN_DB`); a
build with two bogus actions refused to start and named both; the CORS
header for the configured origin was unchanged and `X-Powered-By` gone;
against smtp4dev the new transport sent on 587 (STARTTLS) and 465
(implicit TLS), the batch 7 transport failed on 465; SQLite booted with an
absolute `DATABASE_FILENAME`.

#### Upgrading to the web datetime port (batch 8, lane 3A)

Phase 2 of the [datetime contract](#310-datetime-contract) (branch
`feat/datetime-phase2-web`): the web now computes and renders every date
explicitly in `APP_TIME_ZONE` and runs in UTC like the cms.

- **Dates on pages.** Instants (created, updated, event times) are
  formatted by next-intl in `APP_TIME_ZONE`; calendar dates (an ad's expiry,
  an announcement's confirmation deadline) are shown as the day they name.
  The formats are the ones you know: with `APP_TIME_ZONE=Europe/Berlin` the
  pages show the same dates and times as before, apart from the display
  fixes below (rehearsed page by page against the batch 7 web, also with
  faked clocks around midnight and the October DST change). With a
  zone west of UTC, such as `America/New_York`, the old web showed every
  ad's expiry and every announcement confirmation deadline (on the
  announcements page and `/manage/acknowledgements`) one day early; that
  is fixed.
- **"Today" and day windows** (the events list and month view, the
  dashboard, the ⌘K event preload, ad expiry, the earliest closing day of
  the poll form, the dashboard greeting) are `APP_TIME_ZONE` days; around
  midnight the old web could be one day off where it used the UTC day.
- **Small display fixes (FX49):** an event that has started but not ended
  (a multi-day event on its second day, an all-day event on its last day)
  stays under *Upcoming* instead of *Past*, and the dashboard's event count
  includes it; an event that ends on a later day shows that day ("Mon, Oct
  5, 2026, 09:00 – Wed, Oct 7, 2026, 17:00"); an event whose end equals its
  start shows only the start time (no longer "03:01 PM – 03:01 PM"; the
  demo seed has four such events); relative times count calendar
  days ("yesterday" at 00:10 for a comment from 23:50) in the user's
  language; the org chart no longer drops people whose manager assignments
  form a loop or who are set as their own manager (until now they vanished
  without a notice, together with everyone below them): one person per
  loop, and everyone set as their own manager, appears at the top level
  with a warning, the rest of the loop beneath them, so an admin can fix
  the Manager field.
- **Guardrails:** ESLint rejects process-zone date APIs in the web as
  errors, and the web image carries `ENV TZ=UTC` and the label
  `org.sinnlos.datetime=zone-explicit`.

**Order.** Batch 7 must be live first (this lane is built on it): the web
time zone switch should not share a deploy with batch 7's changes, so that
a problem after the deploy points to one of them only.

**Deploy.** A normal deploy, `infra/deploy.sh`: no env change
(`APP_TIME_ZONE` stays as it is; do not add `TZ` to `infra/.env`), no
schema or permission change, nothing in the database changes. The web
container is recreated with `TZ=UTC`. The cms image is rebuilt as in every
deploy (the calendar helper module it shares with the web gained functions
only the web uses), so compose recreates the cms container too; this lane
changes none of its behaviour, schema or permissions (batch 8's cms
changes come from lane 3B).

**After the deploy:**

1. The web logs its zones once at start:

   ```bash
   docker logs infra-web-1 2>&1 | grep '\[datetime\]'
   # [datetime] web process time zone UTC, APP_TIME_ZONE Europe/Berlin
   docker exec infra-web-1 sh -c 'echo "$TZ"'   # UTC
   ```

   A second line `[datetime] The web process runs in …, not UTC` means a
   compose or orchestrator setting still overrides `TZ` (for example a
   leftover `-f infra/docker-compose.web-legacy-tz.yml`): harmless for the
   dates, but remove it.
2. Open `/events` (list and month view): events show their usual times; an
   event running today is under *Upcoming*; a multi-day event shows its end
   day.
3. Open `/marketplace` and one ad: the expiry dates are unchanged; an ad
   that expired yesterday is shown as expired.
4. As an admin, open `/people/org-chart`: normally nothing changes. A warning
   banner means some manager assignments form a loop or a person is set as
   their own manager; the marked people are listed at the top level. Fix
   their Manager field in the admin panel (Content Manager → User).

**Rollback.** Every web image from before this release renders dates in
its process zone, so it must run **in** `APP_TIME_ZONE`, and the current
compose file runs the web in UTC (`TZ: UTC`). How such an image fails there
depends on its age:

- Images from the datetime release (live since 2026-09-27) up to batch 7,
  including the `:rollback` image this deploy tags, check the zone at
  start: in UTC they answer every request with 500 and log `An error
  occurred while loading instrumentation hook: The web process runs in UTC
  …, not in APP_TIME_ZONE …`.
- Older images, such as `:pre-datetime`, have no such check: in UTC they
  start normally and quietly show every date and time in UTC, one or two
  hours off in Berlin.

Re-up any of them **only with the override**
`infra/docker-compose.web-legacy-tz.yml`, which gives the web the `TZ` it
had before (`${APP_TIME_ZONE:-Europe/Berlin}`):

```bash
cd /opt/sinnlos
docker tag infra-web:rollback infra-web:latest
docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
  -f infra/docker-compose.web-legacy-tz.yml up -d --no-build web
```

(Standalone Caddy box: leave out the Traefik file.) Check afterwards:
`docker exec infra-web-1 sh -c 'echo "$TZ"'` prints your `APP_TIME_ZONE`
(an old image without the start check gives no other sign). Whether an
image needs the override:
`docker image inspect -f '{{ index .Config.Labels "org.sinnlos.datetime" }}' infra-web:rollback`
prints `zone-explicit` for a web from this release on (no override); an
empty line or `<no value>` means it needs it. The same holds for every
other rollback recipe in this document that re-ups an older web image: see
the [update procedure](#74-update-procedure-production-safe). When a deploy fails,
`deploy.sh` prints the rollback commands with this override whenever
`infra-web:rollback` lacks the `org.sinnlos.datetime` label, or when it
cannot check the image (the override is harmless for a newer web image: it
only logs the warning above). This lane alone leaves the cms unchanged,
but batch 8 ships it with the cms bootstrap split: roll back cms and web
together as in [Deploying batch 8](#deploying-batch-8-2026-09-28). Roll
forward with `infra/deploy.sh` as usual: it uses the live compose files
only, so the web runs in UTC again. Nothing in the database needs undoing.

#### Deploying batch 7 (2026-09-28)

Batch 7 (branch `batch/7`, on `main` `a88d45a`, which production runs since
2026-09-28) ships three lanes in one deploy. The three runbooks below
explain each change in detail; **this section is the one sequence to
follow**:

- [the notification pipeline fixes](#upgrading-to-the-notification-pipeline-fixes-2026-09-28)
  (lane 2A): only readers of an announcement are notified, never guests or
  blocked users; notifications and live pings follow the commit; digests
  filter before their cap, skip what the bell already announced and catch
  up a missed Monday;
- [the user data and search hardening](#upgrading-to-the-user-data-and-search-hardening-batch-7-lane-2c)
  (lane 2C): contact fields are no filter or sort key for guests; the
  person page lists direct reports; the ⌘K search runs through `GET
  /search`; a blocked account loses `/uploads` within a minute;
- [the RSVP summary and reports](#upgrading-to-the-rsvp-summary-and-reports-batch-7-lane-2b)
  (lane 2B): the cms counts RSVPs and raw RSVP reads return only the
  caller's own rows; the acknowledgement report scales past 2000
  confirmations; leaner pages; the bell shows the true unread total.

It is **one normal deploy of cms and web together** with `infra/deploy.sh`:
no env, edge or Traefik change, nothing to migrate by hand. The first boot
of the new cms makes two additive changes by itself, both covered by the
pre-deploy backup `deploy.sh` takes:

- one new permission, the RSVP summary, granted to six roles (never
  `guest`);
- one nullable column and its index on the existing manager link table
  (FX23): `alter table up_users_manager_lnk add column user_ord double
  precision null` and the index `up_users_manager_lnk_oifk` (recorded on
  Postgres 16).

**Never deploy or roll back the cms or the web alone.** Both directions
break a page:

- an older web against the new cms: `/events` shows every user only their
  own RSVP, and a guest's ⌘K finds no people (the old web still sends the
  e-mail clause the cms now refuses with a 400);
- the new web against an older cms: `/events` shows the error banner and no
  RSVP counts (the summary route does not exist there, 404).

Set these on the host, in your checkout (e.g. `/opt/sinnlos`), for the
checks below (on a standalone Caddy box, drop the second `-f`):

```bash
cd /opt/sinnlos
COMPOSE=(docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml)
psql_db() { "${COMPOSE[@]}" exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@"; }
```

**Before the deploy** (all read-only)

1. **Pull and validate**, deploying nothing:

   ```bash
   git pull
   infra/deploy.sh --check
   ```

2. **Permissions.** After the `git pull` the permission diff describes
   batch 7:

   ```bash
   psql_db -X < infra/diagnostics/prod-perm-diff.sql
   ```

   Expected in section 1: six new rows `MISSING_IN_DB | <role> |
   api::event-rsvp.event-rsvp.summary`, for `admin_role`, `authenticated`,
   `department_head`, `editor`, `member` and `team_lead` (never `guest`).
   A database created before the Strapi 5.55.1 release, such as
   production's, also lists the two known informational `MISSING_IN_DB`
   rows for `authenticated` (`plugin::users-permissions.auth.getSessions`
   and `…auth.revokeSession`): users-permissions grants them only on a
   fresh database (step 9 of
   [Upgrading to the Strapi 5.55.1 release](#upgrading-to-the-strapi-5551-release-2026-09-25)),
   so a database first booted by 5.55.1 or later holds both, and the diff
   lists neither. Anything else was there before this deploy: compare it
   with the result of the batch 6 deploy before you go on.

3. **Census.** Who the notification and digest rules affect, and the
   manager links FX23 pairs. Write the numbers down; the link count is
   compared after the deploy (replace `Europe/Berlin` with your
   `APP_TIME_ZONE`):

   ```bash
   psql_db -X <<'SQL'
   BEGIN TRANSACTION READ ONLY;
   SELECT p.action, string_agg(r.type, ', ' ORDER BY r.type) AS roles
   FROM up_permissions p
   JOIN up_permissions_role_lnk pr ON pr.permission_id = p.id
   JOIN up_roles r ON r.id = pr.role_id
   WHERE p.action IN ('api::announcement.announcement.find',
                      'api::event.event.find',
                      'api::kudos.kudos.find')
   GROUP BY p.action
   ORDER BY p.action;

   SELECT coalesce(r.type, '(no role)') AS role,
          count(*) AS users,
          count(*) FILTER (WHERE u.blocked) AS blocked,
          count(*) FILTER (WHERE u.digest_announcements OR u.digest_mentions OR u.digest_kudos) AS digest_opt_ins
   FROM up_users u
   LEFT JOIN up_users_role_lnk rl ON rl.user_id = u.id
   LEFT JOIN up_roles r ON r.id = rl.role_id
   GROUP BY 1
   ORDER BY 1;

   SELECT count(*) AS weekly_due_next_morning
   FROM up_users
   WHERE coalesce(blocked, false) = false
     AND digest_frequency = 'weekly'
     AND (digest_announcements OR digest_mentions OR digest_kudos)
     AND (last_digest_at IS NULL
          OR last_digest_at < date_trunc('week', now() AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin');

   SELECT count(*) AS manager_links FROM up_users_manager_lnk;
   ROLLBACK;
   SQL
   ```

   Expected: `announcement.find` and `kudos.find` for `admin_role,
   authenticated, department_head, editor, member, team_lead`, `event.find`
   for those plus `guest`. After the deploy, guests and blocked users get no
   announcement bells and no digests: a guest row with `digest_opt_ins`
   loses its digest (tell them if that matters). Production had no guests
   and no digest opt-ins when this batch was planned (2026-09-28), so nothing
   visible changes there apart from the live pings arriving after the save.
   At most the `weekly_due_next_morning` users get a catch-up digest the
   next morning (guests, roles without `announcement.find` and users with
   nothing new get none).

**Deploy**

4. Run `infra/deploy.sh` on the Traefik host. It runs the preflight, takes
   the pre-deploy backup, tags the running images `:rollback`, rebuilds and
   restarts **cms and web together**, and runs `infra/live-smoke.sh` when
   the demo credentials file is readable (otherwise it says `live-smoke
   SKIPPED`: run `infra/live-smoke.sh` by hand, the live pings are part of
   this change). On a standalone Caddy box, run `infra/backup/pg-backup.sh`,
   then `docker compose up -d --build` from `infra/` (it rebuilds both).

**After the deploy**

5. **Boot lines.**

   ```bash
   "${COMPOSE[@]}" logs --since 30m cms | grep -E '\[bootstrap\] granted|\[live-emit\] DB lifecycle'
   # [bootstrap] granted 6 permission(s) across intranet roles
   # [live-emit] DB lifecycle subscriber registered
   ```

   The grant line appears on the first boot only (a later boot grants
   nothing and logs no such line; after an earlier rollback of this batch
   without the cleanup below it reads `granted N` with N ≤ 6).

6. **Permissions after.** `psql_db -X < infra/diagnostics/prod-perm-diff.sql`
   lists no `event-rsvp` row any more; at most the two known informational
   `MISSING_IN_DB` rows for `authenticated` remain (only on a database
   created before the Strapi 5.55.1 release, see step 2).

7. **FX23: the column is there and no link was lost.**

   ```bash
   psql_db -X -c '\d up_users_manager_lnk'
   psql_db -X -c 'SELECT count(*) AS links, count(user_ord) AS ordered FROM up_users_manager_lnk'
   ```

   Expected: the columns `id`, `user_id`, `inv_user_id`, `user_ord` (double
   precision) and the index `up_users_manager_lnk_oifk`; `links` equals
   step 3's `manager_links`, `ordered` is 0 until someone changes a manager.
   `/people/<id>` of a manager shows the *Direct reports* card.

8. **RSVPs as a non-admin.** Run the API probe of step 6 of the
   [RSVP runbook](#upgrading-to-the-rsvp-summary-and-reports-batch-7-lane-2b)
   (it signs in as the `infra/live-smoke.sh` demo account). Expected for
   any role but `admin_role`: `raw read: … 0 of someone else`, `user filter:
   400`, `format header: 400`, `summary: 200` with one entry per published
   RSVP event and no names of maybe or no answers. As a member, `/events`
   shows the same counts and "yes" names as before the deploy, except where
   one user had two rows for an event (the known double-click race): that
   user now counts once, by their latest answer. So a maybe or no count can
   drop by one per such user (the yes count too, with the name, when their
   latest answer is not yes), and their "yes" name moves to the position of
   their latest answer.

9. **Search as member and guest.** ⌘K as a member finds a colleague by
   e-mail; as a guest (if you have one, or a test account set to `guest`)
   the same colleague by name but not by e-mail, and no error. Images and
   document downloads still load (they go through the web's `/uploads`
   proxy, which now asks the cms once a minute per session token whether
   the account is still active).

10. **First hour: watch the query guard.**

    ```bash
    "${COMPOSE[@]}" logs -f --since 5m cms | grep --line-buffered sensitive-query-guard
    ```

    Each line names the method, path, model and role, never a value. Only
    a `[sensitive-query-guard]` line counts. If its path is one the web
    calls while rendering a page (a guest's or an `authenticated` user's
    page with an error banner or a missing list), it is a missed web query:
    note the page and the line and report it; nothing needs to be rolled
    back for it (`infra/sensitive-queries.test.ts` pins the web's queries
    against the guard). Lines that match no page are probes the guard
    refused as intended. A banner without such a line is not a guard issue.
    Known and unchanged by this batch (403s from grants the role does not
    hold, not guard refusals): a guest sees the cms error banner on `/`,
    `/announcements`, `/departments`, `/teams`, `/kudos`, `/marketplace`,
    `/training` and the lesson pages, and an error page on every department,
    team and course page; an `authenticated`-role user sees it on `/kudos`
    (celebrations).

11. **First publish.** The next announcement or event logs

    ```bash
    "${COMPOSE[@]}" logs --since 30m cms | grep '\[notifications\]'
    # [notifications] created 9 notification(s) for announcement 42 (source <documentId>)
    ```

    and rings the bell of its audience only. `could not create the
    notification for user <id>` names a recipient whose row failed; on
    Postgres its reason is often Strapi's follow-up statement (`… current
    transaction is aborted`) rather than the original error, which the
    Postgres log has. The publish is saved either way, and the next
    publish of that entry delivers the missing notification. `failed for
    comment: …` or `failed for kudos: …` means that one notification is
    missing; the comment or kudos itself is saved.

12. **Next morning.** The 07:30 digest run (with SMTP configured; in dark
    mode the line is `[digest] skipped: …`):

    ```bash
    "${COMPOSE[@]}" logs --since 24h cms | grep '\[digest\]'
    # [digest] run complete: sent=… empty=… skipped=… failed=… of … candidate(s)
    ```

    Guests and users whose role lacks `announcement.find` count as
    `skipped`. `could not load the announcements` or `could not load the
    recipients` means those users failed this run and keep their window;
    the next run covers it.

13. **Optional: revocation.** Block a test account in the admin panel
    (Content Manager → User → *blocked*): its next page load goes to
    sign-in, and its `/uploads` requests answer 401 within 60 s. Unblock it
    again. While the cms cannot answer, `/uploads` answers 503. Cost: at most
    one cms request per session token and minute, per web replica.

**What users notice** (worth a short release note):

- Guests see no e-mail digest options on `/profile` and get no digests or
  announcement bells; blocked accounts get no bells. Digests list at most
  25 announcements plus "+N more", and a weekly digest missed on Monday
  arrives the next morning. Very long titles show shortened in the bell.
- The bell badge shows all unread notifications (up to 99+), not just the
  unread among the newest 20.
- *Give kudos* no longer offers yourself or blocked colleagues, shows
  avatars, and its search matches names and job titles (no longer e-mail
  addresses). `/people` shows the first 48 people and a button for the
  next ones; the person page of a manager lists their direct reports.
- ⌘K no longer blocks other clicks while it searches; guests find people
  by name and job title only.
- RSVP counts can only drop where a duplicate row of one user was counted
  twice.

**Rollback: both images together.** Follow the hint `infra/deploy.sh`
prints (`docker tag infra-web:rollback infra-web:latest`, the same for
`infra-cms`, then `"${COMPOSE[@]}" up -d --no-build web cms`); never one of
them alone, for the reasons above. The `:rollback` images are batch 6's,
which already knows poll guest access, so the hint has no guest-vote step
(follow whatever it prints). What stays in the database, all harmless:

- **The RSVP summary permission rows.** Each boot of the previous cms
  deletes only ONE of the six rows (users-permissions' `syncPermissions`
  deletes one row per action its code does not know, per boot). The others
  are inert (the previous cms has no such route) and the previous
  release's diff lists them as `EXTRA_IN_DB | <role> |
  api::event-rsvp.event-rsvp.summary` (`git show
  a88d45a:infra/diagnostics/prod-perm-diff.sql | psql_db -X`; five after its
  first boot, one fewer per further boot). Optionally remove them while the
  previous cms runs (it never grants them again; a second run removes
  nothing):

  ```bash
  psql_db -X <<'SQL'
  BEGIN;
  WITH stale AS (
    SELECT id FROM up_permissions
     WHERE action = 'api::event-rsvp.event-rsvp.summary'
  ), unlinked AS (
    DELETE FROM up_permissions_role_lnk l USING stale s
     WHERE l.permission_id = s.id RETURNING l.id
  ), removed AS (
    DELETE FROM up_permissions p USING stale s
     WHERE p.id = s.id RETURNING p.id
  )
  SELECT (SELECT count(*) FROM unlinked) AS links_removed,
         (SELECT count(*) FROM removed) AS permission_rows_removed;
  COMMIT;
  SQL
  ```

  Rolling forward again grants only the missing rows: step 5 then reads
  `granted N` with N ≤ 6 (6 after the cleanup), and step 6 is clean.
- **The FX23 column.** `user_ord` and its index stay; the previous cms runs
  no DDL for them (`forceMigration` is off), keeps every manager link and
  just shows no *Direct reports* card again; rolling forward runs no DDL
  either (checked on Postgres 16 and SQLite). Do not drop it by hand.
- **Schema flags.** `private` and `searchable: false` on `microsoftOid`
  and the digest fields are no column property: no DDL in either
  direction.
- **Notifications** written by batch 7 have the same shape as before;
  nothing to undo.

After a rollback the fixed problems are back: bells for guests and blocked
users, long titles failing the publish, pings before the save, comments and
kudos lost when their notification fails, weekly digests only on Mondays,
contact-field filters for guests, the RSVP rows of everyone in the
browser, the capped acknowledgement report and file access for blocked
accounts until their session ends.

#### Upgrading to the notification pipeline fixes (2026-09-28)

This release (branch `fix/notification-pipeline`, on `batch/6` `997bf7f`)
changes who is notified and when, and how the e-mail digest is put
together:

- **Notification titles fit their column (FX18).** A title is at most 255
  characters; a long announcement or event title is shortened with `…`
  (the "New announcement: " prefix and the quotes around a commented title
  stay). Before, a title of about 237 characters or more made the
  notification insert fail on Postgres, which failed the whole publish.
- **Only readers are notified (FX19).** The bell for an announcement goes to
  the targeted users whose role holds `announcement.find` and who are not
  blocked; for an event, to the users of its departments (everyone without
  departments) whose role holds `event.find` and who are not blocked. The
  roles are read from the permissions table at runtime, so a grant changed
  in the admin panel applies to the next publish. Guests (no
  `announcement.find`) and blocked users no longer get announcement bells;
  guests keep the event bell. Admins and editors get strictly the targeted
  audience, as before. If the published entry cannot be read back, nobody
  is notified (before: everyone).
- **Digests (FX19, FX48).** Only users whose role holds
  `announcement.find` get digests: never guests, never blocked users; the
  kudos section needs `kudos.find`. `/profile` offers the digest options
  only to those roles, and `PUT /api/me` ignores a guest's digest settings.
  Each user's announcements are filtered to the window and the user's
  audience first and then capped at 25, with "+N more" (before, the cap of
  25 ran first and could hide every announcement the user may read). An
  announcement that was edited and published again is not repeated for a
  user whose bell announced it before the digest window, nor for its
  author once it was first published before the author's window (the bell
  never notifies the author, so before, the author got every republish of
  their own announcement again). Weekly digests
  are due whenever the last one is older than the start of the week
  (Monday 00:00 in `APP_TIME_ZONE`): a Monday whose send failed, or that
  had nothing to send, is caught up the next morning, still at most once a
  week. A run reads users, permissions and announcements once instead of
  once per user.
- **After the commit (LF02, LF06).** Live pings and the announcement and
  event notifications are sent after the publish is saved: a publish that
  fails notifies and pings nobody, the bell's refetch finds the new rows,
  and one failing notification insert costs that one recipient (logged,
  delivered by the next publish) instead of the publish. The title and
  the audience both come from the entry as saved when the notifications
  go out: if an announcement is renamed, retargeted and published again
  before its first notifications were sent (they queue behind larger
  ones), everyone gets the current title, never the replaced one. Comment
  and kudos notifications are written after the comment or kudos is
  saved as well: before, on Postgres, a failing notification insert
  discarded the comment or kudos although the API answered 201. The
  live-event subscriber now runs only for the four content types it
  watches.

**Nothing else is needed: a normal deploy of cms and web.** No env change,
no migration, and no schema or permission change of its own. On its own
the order of web and cms would not matter (an older web shows guests the
digest options, which the new cms ignores; the new web works with an older
cms), but batch 7 ships this lane with the RSVP summary (lane 2B), so
deploy and roll back cms and web together: see
[Deploying batch 7](#deploying-batch-7-2026-09-28).

Set these on the host, in your checkout (e.g. `/opt/sinnlos`), for the
checks below (on a standalone Caddy box, drop the second `-f`):

```bash
cd /opt/sinnlos
COMPOSE=(docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml)
psql_db() { "${COMPOSE[@]}" exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@"; }
```

**Before the deploy**

1. **Pull and validate**, deploying nothing:

   ```bash
   git pull
   infra/deploy.sh --check
   ```

2. **Optional, read-only: who is affected.** The roles that hold the read
   grants (the new audience), the guests, blocked users and digest opt-ins
   per role, and the weekly subscribers who are due a catch-up digest the
   next morning (replace `Europe/Berlin` with your `APP_TIME_ZONE`):

   ```bash
   psql_db -X <<'SQL'
   SELECT p.action, string_agg(r.type, ', ' ORDER BY r.type) AS roles
   FROM up_permissions p
   JOIN up_permissions_role_lnk pr ON pr.permission_id = p.id
   JOIN up_roles r ON r.id = pr.role_id
   WHERE p.action IN ('api::announcement.announcement.find',
                      'api::event.event.find',
                      'api::kudos.kudos.find')
   GROUP BY p.action
   ORDER BY p.action;

   SELECT coalesce(r.type, '(no role)') AS role,
          count(*) AS users,
          count(*) FILTER (WHERE u.blocked) AS blocked,
          count(*) FILTER (WHERE u.digest_announcements OR u.digest_mentions OR u.digest_kudos) AS digest_opt_ins
   FROM up_users u
   LEFT JOIN up_users_role_lnk rl ON rl.user_id = u.id
   LEFT JOIN up_roles r ON r.id = rl.role_id
   GROUP BY 1
   ORDER BY 1;

   SELECT count(*) AS weekly_due_next_morning
   FROM up_users
   WHERE coalesce(blocked, false) = false
     AND digest_frequency = 'weekly'
     AND (digest_announcements OR digest_mentions OR digest_kudos)
     AND (last_digest_at IS NULL
          OR last_digest_at < date_trunc('week', now() AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin');
   SQL
   ```

   Expected on a default install: `announcement.find` and `kudos.find` for
   `admin_role, authenticated, department_head, editor, member, team_lead`,
   `event.find` for those plus `guest`. Guests with `digest_opt_ins` stop
   getting digests; tell them if that matters. The owner instance had no
   guests and no opt-ins at the 2026-09-28 deploy, so nothing visible
   changes there apart from the live pings arriving after the save.
   `weekly_due_next_morning` is an upper bound: guests, roles without
   `announcement.find` and users with nothing new get no digest.

**Deploy**

3. Run `infra/deploy.sh` on the Traefik host (it takes the pre-deploy backup,
   tags the running images `:rollback` and runs `infra/live-smoke.sh` when
   the demo credentials exist; the live pings are part of this change, so
   run it by hand otherwise). On a standalone Caddy box, run
   `infra/backup/pg-backup.sh`, then `docker compose up -d --build` from
   `infra/`.

**After the deploy**

4. **Publish something** (or wait for the next announcement or event). The
   cms log shows one line per publish, and an error line per recipient
   whose notification could not be written:

   ```bash
   "${COMPOSE[@]}" logs --since 30m cms | grep '\[notifications\]'
   # [notifications] created 9 notification(s) for announcement 42 (source <documentId>)
   ```

   `could not create the notification for user <id>` names the recipient;
   on Postgres its reason is often Strapi's follow-up statement (`delete
   from "public"."notifications" … current transaction is aborted`) rather
   than the original error, which the Postgres log has. The publish itself
   is saved either way, and the next publish of that entry delivers the
   missing notification. `[notifications] failed for comment: …` or
   `failed for kudos: …` means that one notification is missing; the
   comment or kudos itself is saved.
5. **The next morning**, check the 07:30 digest run (with SMTP configured;
   in dark mode the line is `[digest] skipped: …`):

   ```bash
   "${COMPOSE[@]}" logs --since 24h cms | grep '\[digest\]'
   # [digest] run complete: sent=… empty=… skipped=… failed=… of … candidate(s)
   ```

   Guests and users whose role lacks `announcement.find` count as
   `skipped`. `[digest] could not load the announcements` or `could not
   load the recipients` means those users failed this run and keep their
   window; the next run covers it.

**What users notice** (worth a short release note):

- Guests no longer see e-mail digest options on `/profile` and get no
  digests or announcement bells; blocked accounts get no bells.
- Digests list at most 25 announcements plus "+N more", and a weekly
  digest missed on Monday arrives the next morning.
- Very long titles show shortened in the bell.

**Rollback.** The previous images run unchanged on this database: nothing
in the schema changed, and the notification rows this release writes are
the same shape. After a rollback the fixed errors are back (bells for
guests and blocked users, long titles failing the publish, pings before
the save, comments and kudos lost when their notification fails, weekly
digests only on Mondays). Follow the rollback hint
`infra/deploy.sh` prints; it rolls back cms and web together, which batch 7
needs (see [Deploying batch 7](#deploying-batch-7-2026-09-28)).

#### Upgrading to the user data and search hardening (batch 7, lane 2C)

This release (branch `fix/user-data-and-search-hardening`, on `batch/6`
`997bf7f`) closes four gaps around user data:

- **Contact fields are no filter or sort key for non-staff callers
  (FX22).** The cms removed e-mail, phone, hire date, office location and
  the Entra id from every response to guests, the `authenticated` fallback
  role and callers without a known role, but those callers could still
  filter or sort by the fields and read them off which rows came back. A
  new global cms middleware, `global::sensitive-query-guard`, now answers
  400 `Invalid key <field>` to such a query: a filter or sort on one of the
  fields of a user, on `/api/users*` and through every user relation
  (`author`, `manager`, `members`, …, nested `populate` included), and a
  full-text `_q` on `/api/users`. Staff roles (admin, editor, department
  head, team lead, member) keep every query they had, and the admin panel
  is not affected. Each refusal is logged without the value, for example
  `[sensitive-query-guard] 400 Invalid key email on GET /api/users
  (plugin::users-permissions.user, role guest)`. `microsoftOid` and the
  digest opt-ins are now schema-`private`: no role reads, filters or
  `_q`-searches them through the content API any more (the sign-in
  extension, `/api/me` and the digest cron read them directly). The search
  box of the admin panel no longer matches an Entra id either; a filter on
  `microsoftOid` there still works. `blocked`, `provider` and `confirmed`
  stay filterable.
- **Direct reports (FX23).** `user.manager` is now paired with its inverse
  `directReports`; before, the *Direct reports* card on `/people/<id>`
  never showed. The first boot adds one nullable column and its index to
  the existing link table: `alter table up_users_manager_lnk add column
  user_ord double precision null` and the index `up_users_manager_lnk_oifk`
  (nothing else; recorded on Postgres 16). Every existing manager link
  stays and shows up at once.
- **Search (WD06).** The ⌘K palette calls `GET /search` on the web instead
  of Server Actions, so typing no longer holds up other clicks or the
  navigation after a selection. `/search` is outside `/api`, so both edge
  configs already send it to Next.js; like every page it needs a session.
  Guests and the `authenticated` fallback role find people by name and job
  title only, staff roles also by e-mail. People are no longer preloaded
  (that list was unbounded); every live query is limited to 5 rows per
  kind. Search terms are still logged only once they settle.
- **Blocked accounts lose `/uploads` within a minute (FX41).** Before it
  streams a file, the web now asks the cms whether the session's Strapi
  token is still accepted (`GET /api/users/me`, uncached) and remembers the
  answer for 60 s per session token, in the web process. A blocked or
  deleted account gets 401 for files within a minute (its pages already
  sent it to sign-in); before, it kept file access until its session
  expired (up to 7 days).
  While the cms cannot answer, `/uploads` answers 503, also when the file
  fetch itself fails (before, that was an empty 500). Cost: at most one cms
  request per session token and minute, per web replica.

**Nothing else is needed: a normal deploy.** No env change (the existing
`INTERNAL_UPLOAD_TOKEN` is reused), no permission, edge or Traefik change.
The schema change is additive; the pre-deploy backup covers it.

Set these on the host, in your checkout (e.g. `/opt/sinnlos`), for the
checks below (on a standalone Caddy box, drop the second `-f`):

```bash
cd /opt/sinnlos
COMPOSE=(docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml)
psql_db() { "${COMPOSE[@]}" exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@"; }
```

**Before the deploy**

1. **Pull and validate**, deploying nothing:

   ```bash
   git pull
   infra/deploy.sh --check
   ```

**Deploy**

2. Run `infra/deploy.sh` on the Traefik host (it takes the pre-deploy backup
   and tags the running images `:rollback`). On a standalone Caddy box, run
   `infra/backup/pg-backup.sh`, then `docker compose up -d --build` from
   `infra/`. Deploy web and cms together: an older web against the new cms
   still searches people by e-mail for guests, which the cms now refuses
   (the guest's search then finds no people until the web is updated).

**After the deploy**

3. **The manager links survived** (read-only):

   ```bash
   psql_db -X -c '\d up_users_manager_lnk'
   psql_db -X -c 'SELECT count(*) AS links, count(user_ord) AS ordered FROM up_users_manager_lnk'
   ```

   Expected: the columns `id`, `user_id`, `inv_user_id`, `user_ord`, and as
   many links as before the deploy (`ordered` is 0 until someone changes a
   manager). Open `/people/<id>` of a manager: the *Direct reports* card
   lists their reports.

4. **Watch the guard for the first hour.** Every web page and the search
   must keep working for guests and members. A refused query shows up as:

   ```bash
   "${COMPOSE[@]}" logs -f --since 5m cms | grep --line-buffered sensitive-query-guard
   ```

   Each line names the method, path, model and role. Only such a line
   counts. If its path is one the web calls while rendering a page (a
   guest's or an `authenticated` user's page with an error banner or a
   missing list), it is a missed web query: note the page and report it;
   nothing needs to be rolled back for it. Lines nobody can match to a page
   are probes the guard refused as intended. A banner without such a line
   is not a guard issue: guests and the `authenticated` role already see
   error banners on several pages for grants they do not hold (the list is
   in step 10 of [Deploying batch 7](#deploying-batch-7-2026-09-28)).

5. **Search and files.** Press ⌘K as a guest (if you have one) and as a
   member: a colleague is found by name; only the member finds them by
   e-mail. Images and document downloads still load.

6. **Optional: revocation.** Block a test account in the admin panel
   (Content Manager → User → *blocked*): its next page load goes to
   sign-in at once, and its `/uploads` requests answer 401 within 60 s.
   Unblock it again.

**Rollback.** Follow the hint `deploy.sh` prints. Nothing in the database
needs undoing: the previous cms runs no DDL for the extra column (it stays
unused, `forceMigration` is off) and reads every manager link as before;
rolling forward again runs no DDL either (both checked on Postgres 16 and
SQLite). The `searchable: false` flags on `microsoftOid` and
`digestFrequency` are no column property: no DDL in either direction
(checked on Postgres 16). The previous release shows no *Direct reports*
card again, lets guests filter by contact fields again, lets every other
role find users by Entra id or digest frequency with `_q` again and gives
blocked accounts their files until their session ends.

#### Upgrading to the RSVP summary and reports (batch 7, lane 2B)

This release (branch `feat/rsvp-summary-and-reports`, on `batch/6`
`997bf7f`) moves the RSVP counting into the cms and makes the admin reports
and a few pages cheaper:

- **RSVP summary (FX21).** The events list used to download every RSVP row
  of the listed events (up to 3000) and count them in the web. The cms now
  answers `GET /api/event-rsvps/summary?targets=<documentIds>` (at most 50
  published events per request) with the yes/maybe/no counts, the names of
  the "yes" answers and the caller's own answer; who answered maybe or no
  never leaves the cms. `/events` makes one such request. The raw reads
  (`GET /api/event-rsvps`, `GET /api/event-rsvps/:id`) now return only the
  caller's own answers (an admin still sees all of them); a filter on the
  `user` relation and the `Strapi-Response-Format` header answer 400 for
  everyone but an admin. The new action is granted on boot to exactly the
  roles that read RSVPs (admin, editor, department head, team lead, member
  and the `authenticated` fallback), never to guests.
- **Acknowledgement report beyond 2000 confirmations (FX32).**
  `/manage/acknowledgements` read every announcement acknowledgement of the
  intranet and stopped at 2000 rows, after which the report stayed
  "incomplete" for good. It now asks only for the acknowledgements of the
  mandatory announcements it lists, 20 announcements per request, each with
  its own cap. It still shows "–" whenever an input is incomplete.
- **Stable page walks (WD02).** The training report and the learner's own
  progress page through lesson progress sorted by id; without an order
  Postgres could skip or repeat rows between pages. The page arithmetic
  moved into tested modules; nothing else changes.
- **Smaller pages (WD05).** Relations no page renders are no longer loaded
  (announcement department, event departments, department header image,
  poll author, and the notification actor: the bell's feed is part of every
  page, so each notification used to carry the actor's whole user row).
  The kudos picker receives only name, job title and avatar thumbnail of
  the other active colleagues; `/people` and the org chart
  receive only the fields their cards show, and `/people` renders 48 cards
  at a time.
- **Counts (WD10).** The dashboard people count and the user count on
  `/manage/analytics` load after the rest of the page instead of holding it
  back. The bell badge shows the number of all unread notifications (99+),
  not only of the unread among the newest 20. Image URLs of the local upload
  provider stay relative (`/uploads/...`), so they always load through the
  web's session-gated proxy, also when the cms has a host of its own.

**Nothing else is needed: a normal deploy of cms and web together.** No env,
schema, edge or Traefik change. The one permission change is added by the
first boot. `infra/deploy.sh` rebuilds and restarts both; never deploy the
cms alone, and roll both back together:

- an older web against the new cms reads RSVPs row by row and now gets only
  the caller's own rows, so every event shows at most the caller's answer;
- the new web against an older cms asks for a summary route that does not
  exist there (404), so `/events` shows the error banner and no RSVP counts.

Set these on the host, in your checkout (e.g. `/opt/sinnlos`), for the
checks below (on a standalone Caddy box, drop the second `-f`):

```bash
cd /opt/sinnlos
COMPOSE=(docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml)
psql_db() { "${COMPOSE[@]}" exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@"; }
```

**Before the deploy**

1. **Pull and validate**, deploying nothing:

   ```bash
   git pull
   infra/deploy.sh --check
   ```

2. **Optional, read-only: permissions before.** After the `git pull` the
   permission diff describes this release, so section 1 lists six new rows
   `MISSING_IN_DB | <role> | api::event-rsvp.event-rsvp.summary` (for
   `admin_role`, `authenticated`, `department_head`, `editor`, `member` and
   `team_lead`) next to what it listed before:

   ```bash
   psql_db -X < infra/diagnostics/prod-perm-diff.sql
   ```

**Deploy**

3. Run `infra/deploy.sh` on the Traefik host (it takes the pre-deploy backup
   and tags the running images `:rollback`). On a standalone Caddy box, run
   `infra/backup/pg-backup.sh`, then `docker compose up -d --build` from
   `infra/` (it rebuilds cms and web together).

**After the deploy**

4. **The new grant.** The first boot logs it once:

   ```bash
   "${COMPOSE[@]}" logs --since 30m cms | grep '\[bootstrap\] granted'
   # [bootstrap] granted 6 permission(s) across intranet roles
   ```

   A later boot grants nothing new and logs no such line.

5. **Permissions after.** `psql_db -X < infra/diagnostics/prod-perm-diff.sql`
   lists no `event-rsvp` row any more. At most the two known informational
   `MISSING_IN_DB` rows for `authenticated` remain
   (`plugin::users-permissions.auth.getSessions` and `…auth.revokeSession`),
   and only on a database created before the Strapi 5.55.1 release, such as
   production's: users-permissions grants them only on a fresh database
   (see step 9 of
   [Upgrading to the Strapi 5.55.1 release](#upgrading-to-the-strapi-5551-release-2026-09-25)).

6. **RSVPs through the API.** This signs in as the demo account
   `infra/live-smoke.sh` uses (password from the same file, or set
   `SMOKE_PASSWORD` yourself; it reaches the container through the
   environment, not the command line) and prints what the raw reads and the
   summary answer:

   ```bash
   SMOKE_EMAIL=casey.jones@sinnlos.local
   SMOKE_PASSWORD="$(grep "^${SMOKE_EMAIL}[[:space:]]" "${PASSWORDS_FILE:-/home/bigemo/.sinnlos-env-backup/demo-account-passwords.txt}" | awk '{print $2}' | head -1)"
   SMOKE_PASSWORD="$SMOKE_PASSWORD" docker exec -i -e SMOKE_PASSWORD infra-cms-1 node --input-type=module - "$SMOKE_EMAIL" <<'NODE'
   const [identifier] = process.argv.slice(2);
   const password = process.env.SMOKE_PASSWORD;
   const base = "http://127.0.0.1:1337";
   const login = await fetch(`${base}/api/auth/local`, {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: JSON.stringify({ identifier, password }),
   });
   const { jwt, user } = await login.json();
   if (!jwt) throw new Error(`sign-in failed: HTTP ${login.status}`);
   const get = (path, headers = {}) =>
     fetch(`${base}${path}`, { headers: { authorization: `Bearer ${jwt}`, ...headers } });
   const me = await (await get("/api/me")).json();
   console.log("role:", me.data?.role?.type);
   const raw = await (await get("/api/event-rsvps?populate[user][fields][0]=id&pagination[pageSize]=100")).json();
   const others = raw.data.filter((row) => row.user?.id !== user.id).length;
   console.log(`raw read: ${raw.data.length} row(s), ${others} of someone else`);
   console.log("user filter:", (await get(`/api/event-rsvps?filters[user][id][$eq]=${user.id}`)).status);
   console.log("format header:", (await get("/api/event-rsvps", { "strapi-response-format": "v4" })).status);
   const events = await (await get("/api/events?filters[rsvpEnabled][$eq]=true&fields[0]=title&sort=start:desc&pagination[pageSize]=50")).json();
   const targets = events.data.map((event) => event.documentId);
   if (targets.length === 0) {
     console.log("summary: no RSVP event to ask for");
   } else {
     const res = await get(`/api/event-rsvps/summary?targets=${targets.join(",")}`);
     const body = await res.json();
     console.log("summary:", res.status, `${body.data?.length} event(s)`, JSON.stringify(body.data?.[0] ?? null));
   }
   NODE
   ```

   Expected for a role other than `admin_role`: `raw read: … 0 of someone
   else`, `user filter: 400`, `format header: 400`, and `summary: 200` with
   one entry per published RSVP event (`yesCount`, `maybeCount`, `noCount`,
   `yesNames`, `myStatus`; no names of maybe or no answers). For an
   `admin_role` account the raw read includes everyone's rows and both
   checks answer 200, by design.

7. **Pages** (`deploy.sh`'s smoke and live-smoke pass as before):
    - as a member, `/events` shows the same counts and "yes" names on the
      upcoming RSVP events as before the deploy, and answering yes, maybe
      or no updates them; a user who had two rows for one event (the known
      double-click race) now counts once, by their latest answer, in maybe
      and no as well (the yes count drops too, with the name, when their
      latest answer is not yes), and their "yes" name moves to the position
      of their latest answer;
    - as an admin, `/manage/acknowledgements` and `/manage/training` show
      their percentages (a "–" only where an input is really incomplete);
    - the kudos picker lists neither you nor blocked accounts; `/people`
      shows 48 cards and a *+ N people* button when more people match; the
      org chart and the avatars load;
    - the dashboard's people count appears a moment after the page; the
      bell badge counts every unread notification.

**What users notice** (worth a short release note):

- *Give kudos* no longer offers yourself or blocked colleagues, shows
  avatars, and its search matches names and job titles (no longer e-mail
  addresses).
- `/people` shows the first 48 people and a button for the next ones.
- The bell badge shows all unread notifications (up to 99+), not just the
  unread among the newest 20.
- Nothing else changes for readers; the RSVP counts can only drop where a
  duplicate row of one user was counted twice.

**Rollback.** Follow the hint `infra/deploy.sh` prints; it retags and
re-ups web and cms together. After a rollback the raw RSVP reads return
every row again, with the older name stripping, and the older web counts
them as before. Nothing in the database has to be undone, but the six
`api::event-rsvp.event-rsvp.summary` permission rows do not all go away:
each boot of the previous cms deletes only ONE of them (users-permissions'
`syncPermissions` deletes one row per action its code does not have, per
boot). The others are inert, because the previous cms has no such route,
and the rolled-back checkout's `prod-perm-diff.sql` lists them as
`EXTRA_IN_DB | <role> | api::event-rsvp.event-rsvp.summary` (five after its
first boot, one fewer after each further boot). Optional cleanup, with
`COMPOSE` and `psql_db` from above, while the previous cms runs (it never
grants them again):

```bash
psql_db -X <<'SQL'
BEGIN;
WITH stale AS (
  SELECT id FROM up_permissions
   WHERE action = 'api::event-rsvp.event-rsvp.summary'
), unlinked AS (
  DELETE FROM up_permissions_role_lnk l USING stale s
   WHERE l.permission_id = s.id RETURNING l.id
), removed AS (
  DELETE FROM up_permissions p USING stale s
   WHERE p.id = s.id RETURNING p.id
)
SELECT (SELECT count(*) FROM unlinked) AS links_removed,
       (SELECT count(*) FROM removed) AS permission_rows_removed;
COMMIT;
SQL
```

It removes each leftover row with its role link (a second run removes
nothing), and `prod-perm-diff.sql` then lists no `event-rsvp` row. Rolling
forward again grants only the rows that are missing, so the line from
step 4 reads `[bootstrap] granted N permission(s) across intranet roles`
with N ≤ 6 (6 after the cleanup, else one per boot of the previous cms),
and step 5's check is clean afterwards.

On the Postgres 16 rehearsal (this branch against `997bf7f`, the cleanup
taken verbatim from above): two boots of the previous cms left four rows,
listed as four `EXTRA_IN_DB` rows by its `prod-perm-diff.sql`, and a
roll-forward logged `granted 2`; the cleanup under a running previous cms
removed `5 | 5`, a second run `0 | 0`, the previous cms stayed healthy and
recreated nothing on its next boot, and the roll-forward after the cleanup
logged `granted 6` with no `event-rsvp` row in the diff.

#### Upgrading to the cms input hardening (2026-09-28)

This release (branch `fix/cms-input-hardening`, on `main` `afc1506`, which
production runs since 2026-09-28) hardens what the cms accepts from the
admin panel and the content API:

- **Lesson quizzes can be edited in the admin panel again (FX08).** The
  admin panel's JSON field sends the typed text, and `''` when the field is
  cleared; the lesson check expected an array and refused every quiz edit or
  clear with `quiz muss ein JSON-Array sein` (400). The text is now parsed
  and stored as the array, a cleared quiz is stored as `null`, and text that
  is not JSON answers `quiz ist kein gültiges JSON`.
- **The calendar download works for every event title (FX12).** A title with
  characters beyond Latin-1 (an en dash, `€`, an emoji, German quotes) made
  `GET /api/events/:id/ics` answer 500 (`ERR_INVALID_CHAR` in the cms log).
  The file name is now sent per RFC 6266: an ASCII `filename` fallback plus
  `filename*=UTF-8''<percent-encoded>`. The file itself escapes text
  correctly (also line breaks), folds long lines at 75 octets, carries the
  description as plain text (its first 10 000 characters, then `…`, so a
  very long description with unbalanced Markdown converts quickly), a URL
  only when it is an http(s) link, and
  `SEQUENCE` plus `LAST-MODIFIED` from the event's last change, so a calendar
  that imports an updated event again can tell that it is newer. `UID`, the
  dates and the published-only lookup are unchanged.
- **Poll answers are checked for every writer, and polls get their author
  (FX20).** Creating or saving a poll, in the admin panel as well, needs 2 to
  10 answers, each non-empty and different from the others after trimming;
  otherwise it answers 400 (the admin panel shows the reason). Typed JSON in
  the admin panel's Options field is accepted. `POST /api/polls` sets the
  author to the signed-in user, so polls created on `/polls/new` are no
  longer authorless. The admin panel still lets an editor pick the author.
- **Tighter input checks (FX27).** Marking notifications read takes at most
  200 ids per call and changes only the caller's own unread ones, in one
  statement; an announcement can be acknowledged only by its audience
  (everyone else gets the same 400 as for a missing one); kudos need a
  recipient other than the sender; a target type or quick-link icon named
  like a built-in object property (`constructor`) answers 400 instead of
  500 or a crashed dashboard.
- **Reactions accept the desired state (FX28, cms part).** `POST
  /api/reactions` takes an optional `reacted` (true or false), so a double
  click or a retry can no longer add and remove the same reaction. Without
  it the request toggles, as before. Two requests at the same moment (two
  tabs or devices) could both store the same reaction; each create now
  keeps the oldest copy and deletes the others right after its insert, so
  one copy is left and the count no longer shows one reaction too many.
  Removing a reaction (`reacted: false` or the toggle) removes every copy
  of it, including copies stored by an older release; before, only one copy
  was removed, so the reaction stayed.
- **Deleting an ad on SQLite (local development)** no longer hangs for about
  60 s and now removes the ad's images right away (FX45). Postgres was not
  affected.
- **Numeric ids (PL01).** `DELETE /api/notifications/:id` and
  `DELETE /api/reactions/:id` by the numeric id now delete the entry;
  before, every caller the policy let through (the recipient or author, an
  admin, or an editor for reactions) got 204 and nothing was deleted. For an
  admin (and an editor on reactions) an unknown id now answers 404 instead
  of 204; everyone else still gets 403 from the policy.
  `PUT /api/departments/:id` and
  `PUT /api/teams/:id` by the numeric id now update the entry (they answered
  404). The web uses neither form.

**Nothing else is needed: a normal deploy.** No env change, no migration, no
schema or permission change.

Set these on the host, in your checkout (e.g. `/opt/sinnlos`), for the
checks below (on a standalone Caddy box, drop the second `-f`):

```bash
cd /opt/sinnlos
COMPOSE=(docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml)
psql_db() { "${COMPOSE[@]}" exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@"; }
```

**Before the deploy**

1. **Pull and validate**, deploying nothing:

   ```bash
   git pull
   infra/deploy.sh --check
   ```

2. **Optional, read-only: polls whose answers the new check refuses.** They
   stay readable and can still be voted on, but saving or publishing them
   fails until their answers are fixed:

   ```bash
   psql_db -X <<'SQL'
   -- trim_re strips exactly what the cms strips (String.prototype.trim):
   -- tab, line feed, vertical tab, form feed, carriage return, space, the
   -- Unicode space separators (e.g. the no-break space), the BOM and the
   -- line/paragraph separators. Not \s: that also strips U+0085.
   WITH trim_re(re) AS (
     SELECT '^' || ws || '+|' || ws || '+$'
     FROM (VALUES ('[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]')) AS c(ws)
   )
   SELECT id, document_id, published_at IS NOT NULL AS published,
          left(question, 60) AS question, options::text AS options
   FROM polls, trim_re
   WHERE CASE
     WHEN options IS NULL THEN false
     WHEN jsonb_typeof(options) <> 'array' THEN true
     WHEN jsonb_array_length(options) NOT BETWEEN 2 AND 10 THEN true
     ELSE EXISTS (
            SELECT 1 FROM jsonb_array_elements(options) AS e
            WHERE jsonb_typeof(e) <> 'string'
               OR regexp_replace(e #>> '{}', re, '', 'g') = '')
       OR (SELECT count(DISTINCT regexp_replace(e #>> '{}', re, '', 'g'))
           FROM jsonb_array_elements(options) AS e) <> jsonb_array_length(options)
   END
   ORDER BY id;
   SQL
   ```

   Expected: `(0 rows)`. For a listed poll, fix its answers in the admin
   panel after the deploy. Votes point at an answer by its position, so keep
   the positions: rename a duplicate or empty answer instead of deleting it.

**Deploy**

3. Run `infra/deploy.sh` on the Traefik host (it takes the pre-deploy backup
   and tags the running images `:rollback`). On a standalone Caddy box, run
   `infra/backup/pg-backup.sh`, then `docker compose up -d --build` from
   `infra/`.

**After the deploy**

4. **A calendar download with a non-ASCII title.** This signs in as the demo
   account `infra/live-smoke.sh` uses (password from the same file, or set
   `SMOKE_PASSWORD` yourself; it reaches the container through the
   environment, not the command line) and downloads the calendar file of the newest
   published event whose title is not plain ASCII, or of the newest event
   when there is none:

   ```bash
   SMOKE_EMAIL=casey.jones@sinnlos.local
   SMOKE_PASSWORD="$(grep "^${SMOKE_EMAIL}[[:space:]]" "${PASSWORDS_FILE:-/home/bigemo/.sinnlos-env-backup/demo-account-passwords.txt}" | awk '{print $2}' | head -1)"
   SMOKE_PASSWORD="$SMOKE_PASSWORD" docker exec -i -e SMOKE_PASSWORD infra-cms-1 node --input-type=module - "$SMOKE_EMAIL" <<'NODE'
   const [identifier] = process.argv.slice(2);
   const password = process.env.SMOKE_PASSWORD;
   const base = "http://127.0.0.1:1337";
   const login = await fetch(`${base}/api/auth/local`, {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: JSON.stringify({ identifier, password }),
   });
   const { jwt } = await login.json();
   if (!jwt) throw new Error(`sign-in failed: HTTP ${login.status}`);
   const auth = { authorization: `Bearer ${jwt}` };
   const list = await (await fetch(`${base}/api/events?sort=id:desc&pagination[pageSize]=100`, { headers: auth })).json();
   const event = list.data.find((e) => !/^[\x20-\x7e]*$/.test(e.title ?? "")) ?? list.data[0];
   const res = await fetch(`${base}/api/events/${event.documentId}/ics`, { headers: auth });
   const lines = (await res.text()).split("\r\n");
   const longest = Math.max(...lines.map((l) => Buffer.byteLength(l)));
   console.log(res.status, JSON.stringify(event.title));
   console.log(res.headers.get("content-disposition"));
   console.log(`longest line ${longest} octets;`, lines.find((l) => l.startsWith("SEQUENCE:")));
   NODE
   ```

   Expected: `200`, the title, a `Content-Disposition` with
   `filename*=UTF-8''`, the longest line at most 75 octets, and a `SEQUENCE`
   line. The cms log has no `ERR_INVALID_CHAR`:

   ```bash
   "${COMPOSE[@]}" logs --since 30m cms | grep -c ERR_INVALID_CHAR
   # 0
   ```

5. **In the admin panel:** open a lesson, type a quiz in the Quiz field (for
   example `[{"question":"2+2?","options":["3","4"],"correctIndex":1}]`),
   save and publish; then clear the field and save again. Both succeed.
   Undo the test afterwards.
6. **Re-link the authorless polls by hand** (the owner's 2026-09-27 check
   found 2): in the admin panel, open each poll without an author and set
   **Author**. New polls from `/polls/new` get their author automatically.

**What users notice** (worth a short release note):

- Calendar downloads work for every event (before: an error page for titles
  with a dash, `€` or an emoji). Calendar apps that honour `SEQUENCE` update
  an event that is imported again after a change.
- Editors can edit and clear lesson quizzes in the admin panel again; a poll
  needs 2 to 10 different answers there, too.
- Picking yourself in "Give kudos" now fails with the dialog's error
  message (the list still offers you).
- Nothing else changes for readers.

**Rollback.** The previous images run unchanged on this database: nothing in
the schema changed, and what this release writes (quizzes and poll answers
as arrays, poll authors) is valid for the previous cms as well. After a
rollback the fixed errors are back (the 500 for non-ASCII calendar titles,
refused quiz edits, authorless web polls, numeric-id deletes that delete
nothing). A web that already sends `reacted` (see the web release of the
same batch) works with the previous cms, which ignores the field and
toggles. Follow the rollback hint `infra/deploy.sh` prints; it knows whether
the `:rollback` image predates poll guest access.

#### Upgrading to poll department targeting

This release (branch `feat/poll-targeting`, merged as `808e2e7`, and
`feat/poll-guest-access` on top of it, shipped together in ONE deploy;
after the
[ICS and cms start fixes](#upgrading-to-the-ics-and-cms-start-fixes-2026-09-27)
below, which follow the datetime and draft-twin release of 2026-09-27)
enforces the department targeting of polls and, by the owner decision of
2026-09-27, **hides polls from guests** unless an admin or editor opens a
poll to them. Until now a poll's departments were stored but checked
nowhere: every signed-in user, guests included, saw every published poll
and its results, and every role but guest could vote on it.

What the release changes:

- **GUESTS NO LONGER SEE EXISTING POLLS.** A user with the `guest` role
  sees a poll only when an admin or editor has turned on **Visible to
  guests** for it, and votes only where **Guests can vote** is on as well.
  Both are new poll fields, off for every existing and every new poll, so
  right after the deploy a guest's `/polls` page is empty ("No polls for
  you yet", "Polls you can take part in will appear here.") and a poll's
  vote and results endpoints answer 404 to a guest, as for a poll that
  does not exist. See **Guest access** below.
- **A poll without departments is company-wide:** every signed-in user
  except guests sees it, sees its results and can vote (guests: see the
  point above).
- **A poll with departments is restricted** to the members of those
  departments: users whose own department (the `department` of their user
  record) is one of them. Everyone else gets "not found": the poll
  disappears from their `/polls` page and from search, and its vote and
  results endpoints answer 404. The role never adds membership: a guest
  in the department is in (and then needs guest access), a department head
  of another department is out.
- **Admins and editors** see every poll and its results, but vote only on
  company-wide polls and on polls of their own department. On a poll of
  another department their card shows the results with the buttons
  disabled and "Only members of these departments can vote."
- **New poll field Audience** (`all` | `departments`). A poll is
  restricted when Audience is `departments` **or** it has departments.
  Audience keeps a poll restricted when its departments are deleted later:
  it is then visible to admins and editors only, and its card says "The
  target department no longer exists – nobody can vote. Re-select
  departments and republish."
- **Saving a poll with departments sets Audience = `departments`**, on
  both rows and in the same transaction as the save, whoever saves it
  (admin panel, API, web form), also when the admin panel form still says
  `all`. A poll created in the admin panel with departments but Audience
  left at `all` therefore stays restricted when its departments are
  deleted, instead of becoming company-wide.
- **Deleting a department sets Audience = `departments`** on every poll
  that still has it (both rows), before the delete removes the department
  from those polls. After the point above this matters only for polls
  written outside this cms, e.g. by the previous release during a
  rollback.
- **The first boot sets Audience on every existing poll row:**
  `departments` where the row has departments, `all` otherwise. Both rows
  of a poll are set, the published one (what readers get) and the draft
  (what the admin panel edits), each by its own departments. It runs in
  one transaction: if anything fails, nothing is changed and the cms does
  not start (step 8).
- **Guests get the poll vote permission** (one new permission row). It
  takes effect only on polls with **Guests can vote** on; on every other
  poll the cms refuses a guest's vote. The previous cms knows no guest
  switches and never removes the row, so a rollback removes it with the
  cms stopped, **before** the retag, and once more after the start
  (**Rollback** below).
- The poll form says "Restrict to departments (optional)" and explains the
  effect; it refuses to create a poll while the department list cannot be
  loaded, instead of silently offering company-wide only. Its new **Guest
  access** section has "Visible to guests" and "Guests can vote", both
  unchecked; "Guests can vote" can only be ticked while "Visible to guests"
  is.
- Votes already cast stay counted, also those of users outside the
  departments. A department change of a user applies on their next page
  load.

**Guest access** (`visibleToGuests`, `guestsCanVote`; rules in
`apps/cms/src/utils/poll-audience.ts`). For a user whose role type is
exactly `guest` (not the `authenticated` fallback):

| Visible to guests | Guests can vote | The guest (in the poll's audience) |
| --- | --- | --- |
| off (default, also every existing poll) | any | does not see the poll: not listed, not found by search, 404 on its results and vote |
| on | off | sees the poll and its results; the vote buttons are disabled with "Guests can't vote on this poll."; a vote answers 403 |
| on | on | sees the poll, its results and can vote |

"In the poll's audience" is the department rule above: a guest sees a
company-wide poll and a poll of their own department, never a poll of
another department, whatever the switches say. "Guests can vote" without
"Visible to guests" does nothing. The two columns are added empty (NULL) to
the existing poll rows, which counts as off: nothing is backfilled and no
existing poll changes for anyone but guests. Admins and editors see a
"Visible to guests" and a "Guests can vote" note on the card of a poll
that has them. The switches are read from the published poll, like
everything else here.

**Nothing else is needed on an existing instance:** no env change, no
migration script, no `JWT_SECRET` rotation. Deploy cms and web together,
as `infra/deploy.sh` does (compose starts the new web only once the new
cms is healthy): the new web sends Audience and the two guest switches
when it creates a poll, which the previous cms refuses with a 400. A fresh
install needs nothing.

**Together with the ICS and cms start fixes** (an instance on the datetime
release that has neither): still one normal deploy. Run steps 1–6 here
before it; after it, run steps 8–11 here and the checks after the deploy
of
[Upgrading to the ICS and cms start fixes (2026-09-27)](#upgrading-to-the-ics-and-cms-start-fixes-2026-09-27).

Set these on the host, in your checkout (e.g. `/opt/sinnlos`), for the
read-only queries and the log check below (on a standalone Caddy box, drop
the second `-f`):

```bash
cd /opt/sinnlos
COMPOSE=(docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml)
psql_db() { "${COMPOSE[@]}" exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@"; }
```

**Before the deploy**

1. **Pull and validate**, deploying nothing:

   ```bash
   git pull
   infra/deploy.sh --check
   ```

   Repeat after each fix until it prints `Preflight OK`.

2. **Read-only: the published polls that become restricted.** Every poll
   listed here is visible after the deploy only to the members of the
   departments shown, plus admins and editors. An empty result means no
   existing poll changes for its readers.

   ```bash
   psql_db <<'SQL'
   SELECT p.question AS poll, string_agg(d.name, ', ' ORDER BY d.name) AS departments
   FROM polls p
   JOIN polls_departments_lnk l ON l.poll_id = p.id
   JOIN departments d ON d.id = l.department_id
   WHERE p.published_at IS NOT NULL
   GROUP BY p.id, p.question
   ORDER BY p.question;
   SQL
   ```

   If a listed poll was meant for everyone, open it in the Content Manager
   after the deploy, remove its departments, set **Audience** to `all` and
   publish.

3. **Read-only: users without a department.** They see company-wide polls
   only. Admins and editors without a department still see every poll and
   its results, but vote on company-wide polls only.

   ```bash
   psql_db <<'SQL'
   SELECT coalesce(r.type, '(no role)') AS role, count(*) AS users_without_department
   FROM up_users u
   LEFT JOIN up_users_role_lnk rl ON rl.user_id = u.id
   LEFT JOIN up_roles r ON r.id = rl.role_id
   WHERE NOT EXISTS (SELECT 1 FROM up_users_department_lnk l WHERE l.user_id = u.id)
   GROUP BY 1
   ORDER BY 1;
   SQL
   ```

   To give someone a department: Strapi admin → **Content Manager → User**
   → the user → **department** → Save (before or after the deploy).

   **And the guests.** Every guest loses every poll with this deploy: today
   a guest sees all published polls and their results; afterwards none,
   until an admin or editor turns on **Visible to guests** for a poll
   (**Guest access** above). Count them first:

   ```bash
   psql_db <<'SQL'
   SELECT (SELECT count(*) FROM up_users u
             JOIN up_users_role_lnk rl ON rl.user_id = u.id
             JOIN up_roles r ON r.id = rl.role_id
           WHERE r.type = 'guest') AS guest_users,
          (SELECT count(*) FROM polls WHERE published_at IS NOT NULL) AS published_polls;
   SQL
   ```

   With `guest_users` above 0, decide before the deploy which of the
   `published_polls` guests should keep seeing (and on which they may
   vote), and turn the switches on for those right after it (**Authoring in
   the Strapi admin panel** below); tell the guests if some polls go away.

4. **Read-only: saved, unpublished changes of a poll's departments.** The
   first boot flags each row by its own departments, so publishing such a
   draft applies what it says: a draft without departments makes the poll
   company-wide when it is published.

   ```bash
   psql_db <<'SQL'
   SELECT p.question AS poll,
          coalesce((SELECT string_agg(dd.name, ', ' ORDER BY dd.name) FROM polls_departments_lnk x JOIN departments dd ON dd.id = x.department_id WHERE x.poll_id = p.id), '(none)') AS published_departments,
          coalesce((SELECT string_agg(dd.name, ', ' ORDER BY dd.name) FROM polls_departments_lnk x JOIN departments dd ON dd.id = x.department_id WHERE x.poll_id = d.id), '(none)') AS draft_departments
   FROM polls p
   JOIN polls d ON d.document_id = p.document_id AND d.published_at IS NULL
   WHERE p.published_at IS NOT NULL
     AND coalesce((SELECT array_agg(x.department_id ORDER BY x.department_id) FROM polls_departments_lnk x WHERE x.poll_id = p.id), '{}')
      <> coalesce((SELECT array_agg(x.department_id ORDER BY x.department_id) FROM polls_departments_lnk x WHERE x.poll_id = d.id), '{}')
   ORDER BY p.question;
   SQL
   ```

   Usually empty. For a listed poll, decide in the Content Manager after the
   deploy: **Publish** (the draft's departments go live) or **Discard
   changes**.

5. **Optional, read-only: permissions before.** After the `git pull` the
   permission diff describes this release, so section 1 should list one
   new row, `MISSING_IN_DB | guest | api::poll-vote.poll-vote.vote` (the
   new cms adds it on its first boot), next to anything it listed before:

   ```bash
   psql_db -X < infra/diagnostics/prod-perm-diff.sql
   ```

6. **Backup:** `infra/deploy.sh` takes the mandatory pre-deploy Postgres
   backup. On a standalone Caddy box, run `infra/backup/pg-backup.sh` (or
   the manual dump in [§7.1](#71-manual-postgres-backup)) yourself first.

**Deploy**

7. Run `infra/deploy.sh` on the Traefik host; on a standalone Caddy box,
   `docker compose up -d --build` from `infra/`.

**What the first boot changes in the database.** Strapi adds the nullable
columns `polls.audience`, `polls.visible_to_guests` and
`polls.guests_can_vote` (booleans without a database default); the cms
sets `audience` on every existing poll row and leaves the two guest
columns NULL (= off: hidden from guests); one permission row is added
(guest → poll vote; a rollback removes it first). Nothing else is written:
no notification, no live update, and the polls keep their `updated_at`, so
the admin panel shows them as **Published**, not **Modified**. The admin
panel labels of the two new fields ("Visible to guests", "Guests can vote
(needs Visible to guests)", each with a short description that ends
"Applies once the poll is published.") come with the release; a label or
description you change under **Configure the view** stays yours.

**After the deploy**

8. **cms log.** The first boot prints two lines, later boots neither:

   ```bash
   "${COMPOSE[@]}" logs cms | grep -E '\[poll-audience\]|\[bootstrap\] granted'
   # [bootstrap] granted 1 permission(s) across intranet roles
   # [poll-audience] set the audience of 10 existing poll row(s): 0 to 'departments' (they link a department), 10 to 'all'
   ```

   The row count is about twice the number of polls (draft and published
   row); `to 'departments'` counts the rows of the polls from step 2.

   **If the first boot cannot set Audience**, the cms logs
   `[poll-audience] could not backfill the audience of existing polls (<reason>); nothing was changed (the transaction rolled back), and the cms does not start, …`
   and exits. That is deliberate: the whole backfill is one transaction,
   and a half-done one could leave a restricted poll open while the cms
   serves requests. `infra/deploy.sh` then stops at `up -d` (the new cms
   never becomes healthy, so the new web never starts; the site is down)
   and prints the rollback commands. The backfill wrote nothing; the new
   `audience` column and the guest vote permission (granted earlier in the
   same boot) stay. Either fix the cause the log names (e.g. a lock another
   session holds on `polls`) and start again with `"${COMPOSE[@]}" up -d`
   (compose also restarts the cms on its own; every start retries the
   whole backfill), or roll back as printed, in this order: stop the cms,
   remove the guest vote permission, retag and start, remove it again
   (**Rollback** below). Do all of it even when the database holds no
   guest vote row yet: a first boot slow enough to miss compose's health
   deadline before its bootstrap got that far keeps starting (or
   restarts) and writes the row afterwards. On the Postgres 16 rehearsal
   a failing first boot had written the permission; `deploy.sh` prints the
   stop and the removal before the retag commands and the second removal
   after the start commands whenever the `:rollback` cms predates guest
   access or cannot be checked, without asking the database.
9. **Read-only: every poll row has its Audience** (`without_audience` 0),
   and no poll is open to guests yet (`visible_to_guests` 0 until an admin
   or editor turns it on):

   ```bash
   psql_db <<'SQL'
   SELECT count(*) FILTER (WHERE audience IS NULL) AS without_audience,
          count(*) FILTER (WHERE audience = 'departments') AS restricted_rows,
          count(*) FILTER (WHERE published_at IS NOT NULL AND visible_to_guests) AS visible_to_guests,
          count(*) FILTER (WHERE published_at IS NOT NULL AND visible_to_guests AND guests_can_vote) AS guests_can_vote,
          count(*) AS rows
   FROM polls;
   SQL
   ```

10. **Optional: permissions after.** `psql_db -X < infra/diagnostics/prod-perm-diff.sql`
    no longer lists the guest vote row (on the Postgres 16 rehearsal,
    section 1 was empty).
11. **Pages** (`deploy.sh`'s smoke and live-smoke pass as before):
    - as a member, `/polls` shows the polls without departments and those
      of the member's department, with an "Only for: …" line on the
      latter;
    - as an admin or editor, a poll of another department shows its
      results, disabled buttons and "Only members of these departments can
      vote.";
    - as an admin, each poll card's "N votes" equals the poll's count in
      this read-only query (two votes on the same option count as two):

      ```bash
      psql_db <<'SQL'
      SELECT p.question AS poll, count(l.poll_vote_id) AS votes
      FROM polls p
      LEFT JOIN poll_votes_poll_lnk l ON l.poll_id = p.id
      WHERE p.published_at IS NOT NULL
      GROUP BY p.id, p.question
      ORDER BY p.question;
      SQL
      ```
    - as a guest (if there is one; otherwise give a test account the
      `guest` role for these checks), `/polls` shows **no poll** ("No polls
      for you yet"), and the search finds none;
    - as an admin or editor, open a poll without departments in the
      Content Manager, turn on **Visible to guests** and publish: the guest
      now sees it with its results, the buttons disabled and "Guests can't
      vote on this poll." (the admin's card notes "Visible to guests");
    - turn on **Guests can vote** for it as well and publish: the guest can
      vote (the card notes "Guests can vote"); turn both off again if the
      poll was not meant for guests;
    - `/polls/new` (admin or editor) shows "Restrict to departments
      (optional)" and creates a poll restricted to the chosen departments,
      and its **Guest access** section shows both switches unchecked, with
      "Guests can vote" greyed out until "Visible to guests" is ticked.

**Authoring in the Strapi admin panel.** When a poll keeps departments
selected, the cms saves its **Audience** as `departments`, whatever the
form says (after the save the form shows `departments`), and logs
`[poll-audience] poll <action>: set the audience of N poll row(s) to 'departments' (they link a department)`
when that changed the flag. To make a restricted poll company-wide, remove
its departments **and** set Audience to `all`, then publish: removing only
the departments leaves it visible to admins and editors alone (the card
says so), and Audience `all` with departments still selected is saved as
`departments`. Departments can no longer be unpublished (2026-09-26), only
deleted; deleting one removes it from every poll, and when that changed a
poll's Audience the cms logs
`[poll-audience] department delete: set the audience of N poll row(s) to 'departments', …`.

Guest access is set per poll with the two new fields in the same form:
**Visible to guests** shows the poll (and its results) to the guests in its
audience; **Guests can vote (needs Visible to guests)** lets them vote as
well. Both are off by default. Like every field they apply once the poll
is **published** (the published row decides; a saved draft changes
nothing for guests yet, also when you switch guest access off: Save alone
leaves the poll open to guests; the field descriptions say so). "Guests
can vote" without "Visible to guests" has
no effect, and the cms does not clear it: turning "Visible to guests" on
again later brings guest voting back with it, so turn both off when a poll
should be closed to guests. The web form (`/polls/new`) sets both when it
creates a poll; changing them later happens here. The departments and
Audience rules above are unaffected: a guest never sees a poll of another
department.

**What users and editors notice** (worth a short release note):

- Polls: department targeting is now enforced. A poll with departments
  selected can only be seen, voted on and have its results viewed by
  members of those departments. Admins and editors can always see it and
  its results, but can vote only if they belong to one of the departments.
- Polls are hidden from guests. **Guests no longer see the existing polls**
  (they did until now, with their results) until an admin or editor turns
  on "Visible to guests" for a poll; guests vote only on polls where
  "Guests can vote" is on as well. A guest who sees a poll without guest
  voting gets the results and "Guests can't vote on this poll." A guest
  with no poll open to them sees "No polls for you yet".
- Polls without departments are open to every other signed-in user.
- Existing polls that had departments selected become restricted with
  this update (step 2). Votes already cast stay counted.
- If all target departments of a poll are deleted, the poll becomes
  visible to admins and editors only. Re-select departments and republish
  it.
- In the Strapi admin panel, a poll with departments is saved with
  Audience = `departments`; to open it to everyone, remove the departments
  and set Audience to `all`.
- The poll form's department picker is now called "Restrict to departments
  (optional)" and explains who sees the poll; the form's new "Guest access"
  section sets "Visible to guests" and "Guests can vote" (both off by
  default). In the Strapi admin panel, both fields are on the poll form.
  Admins and editors see "Visible to guests" / "Guests can vote" on the
  poll cards that have them.

**Rollback.** The previous images run on the upgraded database without a
restore (verified on Postgres 16 with 34c250c): the previous cms ignores the
`audience`, `visible_to_guests` and `guests_can_vote` columns, and
`forceMigration: false` keeps them. It also ignores the guest switches and
the department targeting, and it never removes the guest vote permission
this release added: while that row exists, **every guest can vote on every
open published poll** there, also on polls hidden from guests and on polls
of other departments (reproduced on the rehearsal). So the permission goes
**before** the retag, with the cms stopped, and the removal runs once more
after the start. Every rollback to a cms from before guest access runs all
five steps, in this order, **whatever the database or the admin panel
shows at the time**: a new cms that is still starting or restarting (a
first boot that missed compose's health deadline carries on, and a failed
one restarts) grants the permission afterwards, also after it was removed
or unticked.
With `COMPOSE` and `psql_db` from above; when a deploy fails, `deploy.sh`
prints steps 2–5 whenever `infra-cms:rollback` predates guest access or
cannot be checked, without asking the database:

1. **Save the list of restricted polls**
   ([Checking targeted polls after rolling forward](#checking-targeted-polls-after-rolling-forward)).
2. **Stop the cms**, so that no start of the new cms grants the permission
   again (every start does, and a cms that failed its first boot restarts
   on its own):

   ```bash
   "${COMPOSE[@]}" stop cms
   ```

3. **Remove the guest vote permission**, also when the database holds no
   such row or the checkbox in the admin panel is already cleared. One
   transaction: it deletes the guest role's links to the permission and,
   of the permission rows it unlinked, those no role links any more (the
   guest's own row; what unticking it in the admin panel removes). The
   other roles' vote permissions and every other permission row stay,
   orphans from before included. The first run after a deploy shows
   `guest_links_removed` 1 and `permission_rows_removed` 1, then
   `guest_poll_vote_grants_left` 0:

   ```bash
   psql_db -X < infra/rollback/revoke-guest-poll-vote.sql
   ```

   The removal takes effect at once (users-permissions reads a role's
   permissions on every request), no restart needed. Unticking the
   permission in the admin panel is no substitute for this step: that
   needs the new cms running, and its next start grants the row again.
   Use the admin panel only to look (step 5).
4. **Retag and start the previous images**, web and cms together (see
   [the update procedure](#74-update-procedure-production-safe); deployed
   together with the ICS and cms start fixes, mind **Rolling back both**
   below):

   ```bash
   docker tag infra-web:rollback infra-web:latest
   docker tag infra-cms:rollback infra-cms:latest
   "${COMPOSE[@]}" up -d --no-build web cms
   ```

5. **Remove again and check** once the previous cms is up: run step 3
   again. It must remove nothing (`guest_links_removed` 0,
   `permission_rows_removed` 0). Anything else means a new cms had
   started again after step 3 and granted the permission anew: the
   rerun removed it, and the query in the list below shows any guest vote
   cast in between. To look without writing: Strapi admin → **Settings →
   Users & Permissions plugin → Roles → Guest → Poll-vote → vote** is
   unticked; `psql_db -X < infra/diagnostics/prod-perm-diff.sql` lists
   `MISSING_IN_DB | guest | api::poll-vote.poll-vote.vote` in section 1
   again, as in the permissions check before the deploy; a guest's
   `POST /api/polls/<id>/vote` answers 403.

On the Postgres 16 rehearsal (34c250c, this order): no guest vote went
through on 34c250c, from its first request on, also after a failed first
boot of this release; the step-5 rerun removed nothing; a start of the new
cms after step 3 granted the permission again (hence step 2). The removal
itself (Postgres 16, the users-permissions tables the built cms of this
release created on its first boot): the guest's link and row went, the
vote grants of the six other roles and an unrelated orphan vote row from
before stayed; a row the guest shared with another role kept that role's
link; a second run removed nothing; a failing statement left everything
unchanged. `deploy.sh` printed steps 2–5 for a `:rollback` image with the
34c250c poll schema while the database held no guest vote row; the printed
sequence, run after a regrant in between, removed 1 and then nothing.

**Never roll the cms back to `808e2e7` alone** (poll targeting without
guest access, never deployed): that cms enforces the departments but knows
no guest switches, and with the guest vote permission of this release it
lets every guest see **and vote on** every company-wide poll. Roll back to
the image that ran before this deploy (`:rollback`, on the owner instance
34c250c), or forward.

Until you roll forward again:

- targeting is not enforced: every signed-in user sees every poll again,
  **guests included: on 34c250c guests see every poll and its results
  again**, whatever "Visible to guests" says;
- guests cannot vote (rollback steps 3 and 5), exactly as before this
  deploy. Rolling forward adds the permission again (step 8's `granted 1`
  line); a later rollback removes it again the same way, all five steps;
- **votes cast while the previous cms served with the permission stay
  counted** after rolling forward, also on polls the guest no longer sees.
  That happens only when the removal came late (after the retag, or
  rollback step 5 removed something); on the rehearsal, with the removal
  after the retag, a guest's votes on a poll hidden from guests and on a
  poll of another department answered 200 and were still counted after
  rolling forward. After rolling forward, this read-only query lists the guest
  votes the rules of this release refuse (voters whose role is `guest`
  now; on the rehearsal it listed exactly the votes of that window, none
  of the guest votes the rules allow):

  ```bash
  psql_db <<'SQL'
  SELECT p.question AS poll, u.username AS guest, v.created_at AS voted_at,
         CASE WHEN coalesce(p.visible_to_guests, false) AND coalesce(p.guests_can_vote, false)
              THEN 'outside its departments' ELSE 'guest voting off' END AS reason
  FROM poll_votes v
  JOIN poll_votes_poll_lnk vp ON vp.poll_vote_id = v.id
  JOIN polls p ON p.id = vp.poll_id AND p.published_at IS NOT NULL
  JOIN poll_votes_voter_lnk vv ON vv.poll_vote_id = v.id
  JOIN up_users u ON u.id = vv.user_id
  JOIN up_users_role_lnk ur ON ur.user_id = u.id
  JOIN up_roles r ON r.id = ur.role_id AND r.type = 'guest'
  WHERE NOT (coalesce(p.visible_to_guests, false) AND coalesce(p.guests_can_vote, false))
     OR ((coalesce(p.audience, 'all') <> 'all'
          OR EXISTS (SELECT 1 FROM polls_departments_lnk x WHERE x.poll_id = p.id))
         AND NOT EXISTS (SELECT 1
                         FROM polls_departments_lnk x
                         JOIN departments pd ON pd.id = x.department_id
                         JOIN up_users_department_lnk ud ON ud.user_id = u.id
                         JOIN departments ud_d ON ud_d.id = ud.department_id
                         WHERE x.poll_id = p.id AND pd.document_id = ud_d.document_id))
  ORDER BY p.question, v.created_at;
  SQL
  ```

  It also lists votes that were allowed when they were cast: on a poll
  whose guest access was switched off later (publishing it on the
  previous cms does that too, see the next point) or by a user who got the
  `guest` role later. Compare `voted_at` with the rollback window;
- a poll published or edited and published on the previous cms gets a
  new published row **without** the guest switches: after rolling forward
  it is hidden from guests again, although its draft (and the admin panel
  form) still shows them on. Publish it again on this release to bring
  its guest access back (the check below lists such polls);
- a poll created on the previous cms gets no Audience; the next boot of
  this release sets it (step 8's log line);
- publishing or discarding changes of a poll on the previous cms writes a
  new row without Audience. Rolling forward gives that row Audience
  `departments` when the poll's other row has it, so a restricted poll
  keeps its restriction even with no department left (step 8's log line
  then also says `N to 'departments' (the other row of their poll is
  restricted)`). A poll you opened to everyone on the previous cms by
  removing its departments therefore stays restricted after rolling
  forward: set its Audience to `all` and publish it again;
- **a restricted poll can come back company-wide.** When **both** rows of
  a poll lose Audience on the previous cms (it is published there **and**
  its changes are discarded), nothing is left that says it was
  restricted. For a poll restricted by Audience alone
  (all its departments deleted) rolling forward then sets `all` on both
  rows, and everyone sees it. The previous cms enforces no targeting at
  all, so this is a limit of the rollback window, not something the roll
  forward can repair; the check below finds such polls;
- the previous cms does not set Audience when a department is deleted:
  delete departments only after rolling forward, or a poll saved on the
  previous cms (it has no Audience) whose only department that was
  becomes company-wide;
- a web-only rollback shows admins and editors vote buttons on polls of
  other departments (the vote fails with "Your vote couldn't be saved"),
  and its form creates polls with Audience `all` (the new cms applies the
  default; their departments still restrict them, and the new cms saves
  them with Audience = `departments`) and hidden from guests (it sends no
  guest switches, the new cms stores false); guests on a poll without
  guest voting see enabled buttons whose vote fails the same way.

**Rolling back both** (deployed together with the ICS and cms start
fixes): the `:rollback` images are from before both. Roll back web and cms
together (the new web links events by documentId, which that cms answers
with 500). That cms image starts with `pnpm start` and downloads pnpm at
every start, so it needs registry.npmjs.org; see **Rollback** in
[Upgrading to the ICS and cms start fixes (2026-09-27)](#upgrading-to-the-ics-and-cms-start-fixes-2026-09-27)
for the check and for starting it without the registry (it replaces the
`up -d` of rollback step 4). Rollback steps 1–3 and 5 and everything in
the list above apply as well.

**Local dev (SQLite):** the next `pnpm cms:dev` adds the columns and sets
Audience the same way; a new demo seed writes Audience `all` and leaves
every poll hidden from guests.

##### Checking targeted polls after rolling forward

Re-check the targeted polls after every roll forward from a rollback. Save
the list of restricted polls **before** you roll back (read-only; with
`COMPOSE` and `psql_db` from above):

```bash
psql_db -At <<'SQL' > restricted-polls-before-rollback.txt
SELECT q.document_id, min(q.question) AS poll
FROM polls q
WHERE (q.audience IS NOT NULL AND q.audience <> 'all')
   OR EXISTS (SELECT 1 FROM polls_departments_lnk l WHERE l.poll_id = q.id)
GROUP BY q.document_id
ORDER BY 1;
SQL
```

After rolling forward (the first boot has logged step 8's line), run the
same query into `restricted-polls-after-roll-forward.txt`, then list the
polls restricted before and not now:

```bash
comm -23 <(cut -d'|' -f1 restricted-polls-before-rollback.txt | sort) \
         <(cut -d'|' -f1 restricted-polls-after-roll-forward.txt | sort)
```

and the published polls that are company-wide while their other row is
restricted (read-only; this one needs no saved list):

```bash
psql_db <<'SQL'
SELECT o.document_id, o.question AS poll
FROM polls o
WHERE o.published_at IS NOT NULL
  AND coalesce(o.audience, 'all') = 'all'
  AND NOT EXISTS (SELECT 1 FROM polls_departments_lnk l WHERE l.poll_id = o.id)
  AND EXISTS (SELECT 1 FROM polls s
              WHERE s.document_id = o.document_id AND s.id <> o.id
                AND ((s.audience IS NOT NULL AND s.audience <> 'all')
                     OR EXISTS (SELECT 1 FROM polls_departments_lnk l2 WHERE l2.poll_id = s.id)))
ORDER BY o.question;
SQL
```

Open each listed poll in the Content Manager (search for its question). If
it is meant for its departments, select them again (Audience follows) and
publish; if it was opened to everyone on purpose during the rollback,
nothing is to do. The second query also lists a poll with a saved,
unpublished change of departments (the draft is restricted, the published
poll not yet): publishing it applies the draft. Without the saved list,
only the second query is left, and a poll whose rows both lost Audience
looks like any company-wide poll. (Rehearsed on Postgres 16 with both
rows of a poll restricted by Audience alone cleared the way the previous
cms leaves them: that poll was the one line of the first check.)

Guest access after rolling forward: the polls whose saved draft is open to
guests while the published poll is not (published on the previous cms,
which writes the published row without the guest switches; read-only):

```bash
psql_db <<'SQL'
SELECT p.document_id, p.question AS poll,
       d.visible_to_guests AS draft_visible, d.guests_can_vote AS draft_vote,
       p.visible_to_guests AS published_visible, p.guests_can_vote AS published_vote
FROM polls p
JOIN polls d ON d.document_id = p.document_id AND d.published_at IS NULL
WHERE p.published_at IS NOT NULL
  AND (coalesce(d.visible_to_guests, false) <> coalesce(p.visible_to_guests, false)
       OR coalesce(d.guests_can_vote, false) <> coalesce(p.guests_can_vote, false))
ORDER BY p.question;
SQL
```

A listed poll is hidden from guests (or keeps guest voting off) until it
is published again: open it in the Content Manager and **Publish** if the
draft's switches are what you want. It also lists a poll with a saved,
unpublished change of its guest switches made on this release. (Rehearsed
on Postgres 16: a poll opened to guests, republished on 34c250c, was
hidden from guests after rolling forward and open again after one
publish.)

#### Upgrading to the ICS and cms start fixes (2026-09-27)

This release (branch `fix/ics-and-cms-start`, after the datetime release that
went live on 2026-09-27) fixes what that deploy turned up:

- **The calendar (ICS) download by documentId.** `GET /api/events/:id/ics`
  looked the event up by the numeric id of its row. A documentId or any other
  non-numeric value made the Postgres query fail, and the API answered 500
  (plus an error line in the cms log). The `UID` in the file was
  `event-<row id>@sinnlos`, and publishing an event again gives its published
  row a new id, so a calendar that imported the file again showed the event
  twice. Now:
  - the route takes the event's documentId, and still the numeric id of its
    published row (links from before this release);
  - any other value, an unknown event and a draft-only event all answer the
    same 404, and a malformed value never reaches the database;
  - the `UID` is `event-<documentId>@sinnlos` and stays the same when the
    event is published again;
  - the events page links `/events/<documentId>/ics`, and the web route
    answers 404 for any other value before it calls the cms. The rest of the
    file (dates, all-day events, text) is unchanged.
- **The same 500 in other endpoints.** Comment delete, classified update and
  delete, RSVP update, notification and reaction delete, the write checks of
  departments, teams and wiki pages, notification mark-read and the image ids
  of classifieds passed an all-digit id beyond the int4 range (for example
  `2147483648`) to a numeric lookup. The ICS route and notification
  mark-read also passed non-numeric values such as `abc`. Postgres failed
  the same way. They now answer like an unknown entry (404, or 403 from an
  ownership check) or, for a malformed request body, 400, and write no error
  to the cms log. Unchanged: a notification or reaction delete by a role
  that bypasses the ownership check (admin; for reactions also editor)
  answers 204 for any id. Not in this release: poll vote and results
  (`POST /api/polls/:id/vote`, `GET /api/polls/:id/results`) still answer a
  malformed id with 500; the poll targeting release (`feat/poll-targeting`,
  above) adds the same check there, so with both deployed they answer 404.
- **The cms container starts without pnpm.** The image ran `pnpm start` as
  the `node` user, but pnpm was only set up for root, so **every start of the
  cms container downloaded pnpm from registry.npmjs.org**: a restart, a deploy
  or a rollback failed while the registry was unreachable. The image now
  starts Strapi directly (`node_modules/.bin/strapi start`, the command
  `pnpm start` ran) and contains no pnpm (corepack is not enabled), and
  compose runs the cms with `init: true`: docker-init passes the stop signal
  on to Strapi. A running cms shuts down as before: "Shutting down Strapi",
  exit code 0, `docker stop` in about 0.5 to 0.8 s with either image. What
  `init: true` changes is a stop during boot: the cms now exits with code 143
  in about 0.5 s instead of being killed (code 137) when the stop grace
  period runs out. Without DNS on the host, a stop right after requests can
  take up to about 5 s (Strapi's telemetry lookups time out), still within
  compose's 10 s grace period. **The cms container no longer
  needs registry access to start.** Building the image still downloads
  packages. Cms images from before this release (their
  `docker image inspect -f '{{json .Config.Cmd}}'` shows `["pnpm","start"]`),
  including the `infra-cms:rollback` and `infra-cms:pre-datetime` tags on
  the host, still download pnpm at every start; see **Rollback** below.

**Nothing else is needed on an existing instance: a normal deploy.** No env
change, no migration, no `JWT_SECRET` rotation, no permission change; the
database is not touched.

Set these on the host, in your checkout (e.g. `/opt/sinnlos`), for the
checks below (on a standalone Caddy box, drop the second `-f`):

```bash
cd /opt/sinnlos
COMPOSE=(docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml)
```

**Before the deploy**

1. **Pull and validate**, deploying nothing:

   ```bash
   git pull
   infra/deploy.sh --check
   ```

   Repeat after each fix until it prints `Preflight OK`.

**Deploy**

2. Run `infra/deploy.sh` on the Traefik host (it takes the pre-deploy backup
   and tags the running images `:rollback`). On a standalone Caddy box, run
   `infra/backup/pg-backup.sh`, then `docker compose up -d --build` from
   `infra/`. Compose recreates cms and web; the usual short downtime.

   `pnpm` is no longer in the cms image. A registry check such as
   `docker run --rm infra-cms pnpm --version` (the one the 2026-09-27 deploy
   script ran) now fails with `Cannot find module '/app/apps/cms/pnpm'` by
   design; it is not needed any more.

**After the deploy**

3. **The cms runs Strapi directly, under docker-init:**

   ```bash
   docker inspect -f '{{json .Config.Cmd}} init={{.HostConfig.Init}}' infra-cms-1
   # ["node_modules/.bin/strapi","start"] init=true
   docker top infra-cms-1 -o pid,args
   # PID     COMMAND
   # …       /sbin/docker-init -- docker-entrypoint.sh node_modules/.bin/strapi start
   # …       node node_modules/.bin/../@strapi/strapi/bin/strapi.js start
   ```

   No `pnpm` in either output. Optionally, the start command without any
   network (prints the Strapi version, `5.55.1`):

   ```bash
   docker run --rm --network none infra-cms:latest node_modules/.bin/strapi version
   ```

4. **ICS by documentId, 404 for anything else.** This signs in as the demo
   account `infra/live-smoke.sh` uses (password from the same file) and asks
   the cms for the calendar file of the newest published event whose title
   is plain ASCII, by documentId, by the numeric id of its published row,
   and by three malformed ids (if that password file is not on the host, set
   `SMOKE_PASSWORD` yourself; it reaches the container through the
   environment, not the command line):

   ```bash
   SMOKE_EMAIL=casey.jones@sinnlos.local
   SMOKE_PASSWORD="$(grep "^${SMOKE_EMAIL}[[:space:]]" "${PASSWORDS_FILE:-/home/bigemo/.sinnlos-env-backup/demo-account-passwords.txt}" | awk '{print $2}' | head -1)"
   SMOKE_PASSWORD="$SMOKE_PASSWORD" docker exec -i -e SMOKE_PASSWORD infra-cms-1 node --input-type=module - "$SMOKE_EMAIL" <<'NODE'
   const [identifier] = process.argv.slice(2);
   const password = process.env.SMOKE_PASSWORD;
   const base = "http://127.0.0.1:1337";
   const login = await fetch(`${base}/api/auth/local`, {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: JSON.stringify({ identifier, password }),
   });
   const { jwt } = await login.json();
   if (!jwt) throw new Error(`sign-in failed: HTTP ${login.status}`);
   const auth = { authorization: `Bearer ${jwt}` };
   const list = await (await fetch(`${base}/api/events?sort=id:desc&pagination[pageSize]=100`, { headers: auth })).json();
   const event = list.data.find((e) => /^[\x20-\x7e]*$/.test(e.title ?? "")) ?? list.data[0];
   for (const id of [event.documentId, String(event.id), "abc", "2147483648", "1.5"]) {
     const res = await fetch(`${base}/api/events/${id}/ics`, { headers: auth });
     const uid = (await res.text()).match(/^UID:.*$/m)?.[0] ?? "";
     console.log(`${id} -> ${res.status} ${uid}`.trim());
   }
   NODE
   ```

   Expected (with that event's documentId and row id):

   ```
   lj5n10lqpweysvb5m9hmiv8p -> 200 UID:event-lj5n10lqpweysvb5m9hmiv8p@sinnlos
   12 -> 200 UID:event-lj5n10lqpweysvb5m9hmiv8p@sinnlos
   abc -> 404
   2147483648 -> 404
   1.5 -> 404
   ```

   The previous cms answered the documentId and the three malformed ids with
   500.

   A 500 with `ERR_INVALID_CHAR` in the cms log for an event whose title has
   characters beyond Latin-1 (en dash, €, emoji) is the known FX12a filename
   issue, not a failed deploy. The check picks a plain-ASCII title to avoid
   it and falls back to the newest event only when there is none. **Since
   the cms input hardening (2026-09-28) a non-ASCII title works** (200 with
   an RFC 6266 file name); step 4 there checks exactly that.

5. **No id errors in the cms log** since the deploy (the check above sent
   three malformed ids):

   ```bash
   "${COMPOSE[@]}" logs --since 30m cms | grep -cE 'invalid input syntax for type integer|out of range for type integer'
   # 0
   ```

6. **In the browser:** on `/events`, the download icon of an event links
   `/events/<documentId>/ics`, and the downloaded file contains
   `UID:event-<documentId>@sinnlos`. `/events/abc/ics` answers
   `Event not found` (404).

**What users notice** (worth a short release note):

- The calendar download works as before; its link now names the event's
  documentId. A link copied before the deploy keeps working until that event
  is published again (a publish gives the published row a new id, as
  before).
- A calendar that imported an event before this release has it under the old
  `UID`. Importing that event's file again adds a second entry (once); delete
  the older one. After that, importing a re-published event no longer adds
  a second entry; whether the existing entry is updated depends on the
  calendar app (the file carries no `SEQUENCE` or `LAST-MODIFIED` yet,
  FX12; both since the cms input hardening of 2026-09-28).
- Nothing else changes for readers or editors.

**Rollback.** The previous images run unchanged on this database: nothing in
the schema or the data changed. Roll back web and cms together (the new web
links documentIds, which the previous cms answers with 500). Note:

- **Every cms image from before this release starts with `pnpm start` and
  downloads pnpm at every start**, so re-upping it needs registry.npmjs.org
  reachable from the host. Tell such an image by its command, not by its
  build date (the `infra-cms:rollback` this deploy tags was built on
  2026-09-27 too):

  ```bash
  docker image inspect -f '{{json .Config.Cmd}}' infra-cms:rollback
  # ["pnpm","start"]                      -> starts with pnpm, needs the registry
  # ["node_modules/.bin/strapi","start"]  -> starts directly
  ```

  When a deploy fails, `infra/deploy.sh` runs this check itself and, for a
  `["pnpm","start"]` image, prints the direct start below (the same override
  file, written with `printf`) next to the rollback commands; without a
  `:rollback` image it prints the check. If the registry is not reachable,
  start the previous image directly with a one-off override file:

  ```bash
  cat > /tmp/cms-direct-start.yml <<'YAML'
  services:
    cms:
      command: ["node_modules/.bin/strapi", "start"]
  YAML
  docker tag infra-web:rollback infra-web:latest
  docker tag infra-cms:rollback infra-cms:latest
  docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
    -f /tmp/cms-direct-start.yml up -d --no-build web cms
  ```

  (Standalone Caddy box: leave out the Traefik file. For a cms image from
  before the datetime contract, add `-f infra/docker-compose.cms-legacy-tz.yml`
  before the `/tmp` file, see
  [Rolling back this release](#rolling-back-this-release).) The override file
  may live outside the checkout: compose reads `infra/.env` through the first
  `-f` file. Verified with an image of `main` 0e8dadb (the release before
  this one): it starts this way without any network, under `init: true`, and
  stops cleanly. Roll forward with `infra/deploy.sh` as usual (it uses only
  the live compose files) and delete `/tmp/cms-direct-start.yml`.
- With this checkout, compose also runs a previous cms image with
  `init: true`: docker-init starts pnpm, which starts Strapi, and a stop still
  reaches Strapi (verified, exit code 0).
- Deployed together with poll department targeting, the **Rollback** note
  of [Upgrading to poll department targeting](#upgrading-to-poll-department-targeting)
  applies as well.

#### Upgrading to the draft-twin repair (FX38)

This release (branch `feat/seed-draft-twins`, after the department/team
release of 2026-09-26) fixes entries of draft & publish types that have a
published row but **no draft row**. Until now the demo seed
(`SEED_DEMO_DATA=1`) wrote its announcements, events, wiki spaces and pages,
polls and documents that way, so every instance that was ever seeded holds
such entries; normally every entry has a draft row (what the admin panel
edits) next to its published row (what readers get). Strapi 5.55.1
mishandles entries without a draft in the admin panel:

- The Content Manager's default list does not show them (it lists drafts;
  only the **Published** filter finds them).
- Editing one and publishing it silently drops every relation the edit form
  did not touch: an announcement loses its author and department, a wiki
  page its space, parent and author, a lesson its course.
- New entries cannot link to them: a new wiki page in a seeded space, for
  example, fails with `Document with id "…" not found`.

What the release changes:

- **On every boot the cms gives each such entry its draft twin**, with
  Strapi's own "discard draft" operation: a copy of the published row with
  the same fields, relations and media, exactly what Strapi does when draft &
  publish is switched on for a type. It covers announcements, courses,
  documents, events, lessons, polls, quick links, wiki pages and wiki spaces.
  Wiki revisions stay as they are: they are published snapshots by design.
- Published rows are not touched, so readers see no change, and nothing is
  sent: no notifications, no live updates, no wiki revisions.
- **Drafts that already exist are never replaced.** Two kinds matter here:
  - A draft an admin saved without publishing that **moves** a lesson to
    another course, or a wiki page to another space or under another parent
    page. Copying the course, space or page it left would move the lesson or
    page back (Strapi keeps a lesson in one course, a page in one space and
    under one parent). So while such a draft exists, that course, space or
    page gets no draft, and the log names the draft (steps 5 and 8).
  - A draft saved before this release from the edit form alone, which may
    lack relations its published version has (step 4). The repair leaves
    it as it is; publishing it still drops those relations.
- The demo seed now writes a draft and a published row per entry, like the
  admin panel.

**Nothing else is needed on an existing instance** beyond the read-only
checks below and publishing or discarding the few drafts they may list: no
env change, no migration script, no `JWT_SECRET` rotation, no downtime
beyond the normal container restart. A fresh install needs nothing.

Set these on the host, in your checkout (e.g. `/opt/sinnlos`), for the
read-only queries and the log check below (on a standalone Caddy box, drop
the second `-f`):

```bash
cd /opt/sinnlos
COMPOSE=(docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml)
psql_db() { "${COMPOSE[@]}" exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@"; }
```

**Before the deploy**

1. **Pull and validate**, deploying nothing:

   ```bash
   git pull
   infra/deploy.sh --check
   ```

   Repeat after each fix until it prints `Preflight OK`.

2. **Optional, read-only: count what the first boot will repair.**
   `published_only` is the number of drafts the boot creates per type (types
   without published entries are not listed):

   ```bash
   psql_db <<'SQL'
   SELECT t AS type, count(*) FILTER (WHERE NOT has_draft) AS published_only, count(*) AS published
   FROM (
     SELECT 'announcements' AS t, EXISTS (SELECT 1 FROM announcements d WHERE d.document_id = p.document_id AND d.published_at IS NULL) AS has_draft FROM announcements p WHERE p.published_at IS NOT NULL
     UNION ALL SELECT 'courses', EXISTS (SELECT 1 FROM courses d WHERE d.document_id = p.document_id AND d.published_at IS NULL) FROM courses p WHERE p.published_at IS NOT NULL
     UNION ALL SELECT 'documents', EXISTS (SELECT 1 FROM documents d WHERE d.document_id = p.document_id AND d.published_at IS NULL) FROM documents p WHERE p.published_at IS NOT NULL
     UNION ALL SELECT 'events', EXISTS (SELECT 1 FROM events d WHERE d.document_id = p.document_id AND d.published_at IS NULL) FROM events p WHERE p.published_at IS NOT NULL
     UNION ALL SELECT 'lessons', EXISTS (SELECT 1 FROM lessons d WHERE d.document_id = p.document_id AND d.published_at IS NULL) FROM lessons p WHERE p.published_at IS NOT NULL
     UNION ALL SELECT 'polls', EXISTS (SELECT 1 FROM polls d WHERE d.document_id = p.document_id AND d.published_at IS NULL) FROM polls p WHERE p.published_at IS NOT NULL
     UNION ALL SELECT 'quick_links', EXISTS (SELECT 1 FROM quick_links d WHERE d.document_id = p.document_id AND d.published_at IS NULL) FROM quick_links p WHERE p.published_at IS NOT NULL
     UNION ALL SELECT 'wiki_pages', EXISTS (SELECT 1 FROM wiki_pages d WHERE d.document_id = p.document_id AND d.published_at IS NULL) FROM wiki_pages p WHERE p.published_at IS NOT NULL
     UNION ALL SELECT 'wiki_spaces', EXISTS (SELECT 1 FROM wiki_spaces d WHERE d.document_id = p.document_id AND d.published_at IS NULL) FROM wiki_spaces p WHERE p.published_at IS NOT NULL
   ) x
   GROUP BY t ORDER BY t;
   SQL
   ```

3. **Optional, read-only: list relations an earlier admin edit already
   dropped.** The repair copies each published row as it is now, so a link
   that an edit and publish in the admin removed before this release stays
   removed. Every demo-seed entry has the relation checked here (see
   `apps/cms/src/seed-demo.ts`); an entry created in the admin panel may
   legitimately lack one. Two rows check departments the demo seed set: on
   the announcement "Engineering: Sprint Retro moved to Thursday" and on the
   wiki spaces Engineering and People & Culture. Without the department,
   the announcement and the spaces lose their department targeting (the
   announcement reaches more people).

   ```bash
   psql_db <<'SQL'
   SELECT 'announcement without author' AS problem, a.title AS entry FROM announcements a
     WHERE a.published_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM announcements_author_lnk l WHERE l.announcement_id = a.id)
   UNION ALL SELECT 'announcement without department', a.title FROM announcements a
     WHERE a.published_at IS NOT NULL AND a.title = 'Engineering: Sprint Retro moved to Thursday'
       AND NOT EXISTS (SELECT 1 FROM announcements_department_lnk l WHERE l.announcement_id = a.id)
   UNION ALL SELECT 'event without organizer', e.title FROM events e
     WHERE e.published_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM events_organizer_lnk l WHERE l.event_id = e.id)
   UNION ALL SELECT 'wiki page without space', w.title FROM wiki_pages w
     WHERE w.published_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM wiki_pages_space_lnk l WHERE l.wiki_page_id = w.id)
   UNION ALL SELECT 'wiki page without author', w.title FROM wiki_pages w
     WHERE w.published_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM wiki_pages_author_lnk l WHERE l.wiki_page_id = w.id)
   UNION ALL SELECT 'wiki space without department', s.name FROM wiki_spaces s
     WHERE s.published_at IS NOT NULL AND s.slug IN ('engineering', 'people-culture')
       AND NOT EXISTS (SELECT 1 FROM wiki_spaces_department_lnk l WHERE l.wiki_space_id = s.id)
   UNION ALL SELECT 'poll without author', p.question FROM polls p
     WHERE p.published_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM polls_author_lnk l WHERE l.poll_id = p.id)
   UNION ALL SELECT 'document without uploader', d.title FROM documents d
     WHERE d.published_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents_uploaded_by_lnk l WHERE l.document_id = d.id)
   UNION ALL SELECT 'lesson without course', l2.title FROM lessons l2
     WHERE l2.published_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM lessons_course_lnk l WHERE l.lesson_id = l2.id)
   ORDER BY 1, 2;
   SQL
   ```

   Note what is missing and re-link it in the admin after the deploy
   (step 9), when editing keeps relations. Other targeting (an
   announcement's team or audience roles, the departments of events, polls,
   documents and quick links) cannot be checked this way, because an entry
   without it is company-wide by design: compare those entries with what
   was intended.

4. **Recommended, read-only: list drafts that lack a relation of their
   published version.** Before this release, **Save** (not **Publish**) on
   a seeded entry created its draft from the edit form alone, without the
   relations the form did not touch. The repair does not replace existing
   drafts, so publishing such a draft still drops those relations for
   readers; for an announcement, a lost department or team widens its
   audience and notifies more people.

   ```bash
   psql_db <<'SQL'
   WITH
     a AS (SELECT d.id AS draft, p.id AS pub, d.title AS entry FROM announcements d JOIN announcements p ON p.document_id = d.document_id AND p.published_at IS NOT NULL WHERE d.published_at IS NULL),
     e AS (SELECT d.id AS draft, p.id AS pub, d.title AS entry FROM events d JOIN events p ON p.document_id = d.document_id AND p.published_at IS NOT NULL WHERE d.published_at IS NULL),
     w AS (SELECT d.id AS draft, p.id AS pub, d.title AS entry FROM wiki_pages d JOIN wiki_pages p ON p.document_id = d.document_id AND p.published_at IS NOT NULL WHERE d.published_at IS NULL),
     s AS (SELECT d.id AS draft, p.id AS pub, d.name AS entry FROM wiki_spaces d JOIN wiki_spaces p ON p.document_id = d.document_id AND p.published_at IS NOT NULL WHERE d.published_at IS NULL),
     o AS (SELECT d.id AS draft, p.id AS pub, d.question AS entry FROM polls d JOIN polls p ON p.document_id = d.document_id AND p.published_at IS NOT NULL WHERE d.published_at IS NULL),
     f AS (SELECT d.id AS draft, p.id AS pub, d.title AS entry FROM documents d JOIN documents p ON p.document_id = d.document_id AND p.published_at IS NOT NULL WHERE d.published_at IS NULL),
     k AS (SELECT d.id AS draft, p.id AS pub, d.label AS entry FROM quick_links d JOIN quick_links p ON p.document_id = d.document_id AND p.published_at IS NOT NULL WHERE d.published_at IS NULL),
     l AS (SELECT d.id AS draft, p.id AS pub, d.title AS entry FROM lessons d JOIN lessons p ON p.document_id = d.document_id AND p.published_at IS NOT NULL WHERE d.published_at IS NULL)
   SELECT 'announcement' AS type, entry, 'author' AS missing_on_draft FROM a WHERE EXISTS (SELECT 1 FROM announcements_author_lnk x WHERE x.announcement_id = a.pub) AND NOT EXISTS (SELECT 1 FROM announcements_author_lnk x WHERE x.announcement_id = a.draft)
   UNION ALL SELECT 'announcement', entry, 'department' FROM a WHERE EXISTS (SELECT 1 FROM announcements_department_lnk x WHERE x.announcement_id = a.pub) AND NOT EXISTS (SELECT 1 FROM announcements_department_lnk x WHERE x.announcement_id = a.draft)
   UNION ALL SELECT 'announcement', entry, 'team' FROM a WHERE EXISTS (SELECT 1 FROM announcements_team_lnk x WHERE x.announcement_id = a.pub) AND NOT EXISTS (SELECT 1 FROM announcements_team_lnk x WHERE x.announcement_id = a.draft)
   UNION ALL SELECT 'announcement', entry, 'audienceRoles' FROM a WHERE EXISTS (SELECT 1 FROM announcements_audience_roles_lnk x WHERE x.announcement_id = a.pub) AND NOT EXISTS (SELECT 1 FROM announcements_audience_roles_lnk x WHERE x.announcement_id = a.draft)
   UNION ALL SELECT 'event', entry, 'organizer' FROM e WHERE EXISTS (SELECT 1 FROM events_organizer_lnk x WHERE x.event_id = e.pub) AND NOT EXISTS (SELECT 1 FROM events_organizer_lnk x WHERE x.event_id = e.draft)
   UNION ALL SELECT 'event', entry, 'departments' FROM e WHERE EXISTS (SELECT 1 FROM events_departments_lnk x WHERE x.event_id = e.pub) AND NOT EXISTS (SELECT 1 FROM events_departments_lnk x WHERE x.event_id = e.draft)
   UNION ALL SELECT 'wiki page', entry, 'author' FROM w WHERE EXISTS (SELECT 1 FROM wiki_pages_author_lnk x WHERE x.wiki_page_id = w.pub) AND NOT EXISTS (SELECT 1 FROM wiki_pages_author_lnk x WHERE x.wiki_page_id = w.draft)
   UNION ALL SELECT 'wiki page', entry, 'space' FROM w WHERE EXISTS (SELECT 1 FROM wiki_pages_space_lnk x WHERE x.wiki_page_id = w.pub) AND NOT EXISTS (SELECT 1 FROM wiki_pages_space_lnk x WHERE x.wiki_page_id = w.draft)
   UNION ALL SELECT 'wiki page', entry, 'parent' FROM w WHERE EXISTS (SELECT 1 FROM wiki_pages_parent_lnk x WHERE x.wiki_page_id = w.pub) AND NOT EXISTS (SELECT 1 FROM wiki_pages_parent_lnk x WHERE x.wiki_page_id = w.draft)
   UNION ALL SELECT 'wiki page', entry, 'department' FROM w WHERE EXISTS (SELECT 1 FROM wiki_pages_department_lnk x WHERE x.wiki_page_id = w.pub) AND NOT EXISTS (SELECT 1 FROM wiki_pages_department_lnk x WHERE x.wiki_page_id = w.draft)
   UNION ALL SELECT 'wiki page', entry, 'team' FROM w WHERE EXISTS (SELECT 1 FROM wiki_pages_team_lnk x WHERE x.wiki_page_id = w.pub) AND NOT EXISTS (SELECT 1 FROM wiki_pages_team_lnk x WHERE x.wiki_page_id = w.draft)
   UNION ALL SELECT 'wiki space', entry, 'department' FROM s WHERE EXISTS (SELECT 1 FROM wiki_spaces_department_lnk x WHERE x.wiki_space_id = s.pub) AND NOT EXISTS (SELECT 1 FROM wiki_spaces_department_lnk x WHERE x.wiki_space_id = s.draft)
   UNION ALL SELECT 'wiki space', entry, 'team' FROM s WHERE EXISTS (SELECT 1 FROM wiki_spaces_team_lnk x WHERE x.wiki_space_id = s.pub) AND NOT EXISTS (SELECT 1 FROM wiki_spaces_team_lnk x WHERE x.wiki_space_id = s.draft)
   UNION ALL SELECT 'wiki space', entry, 'allowedRoles' FROM s WHERE EXISTS (SELECT 1 FROM wiki_spaces_allowed_roles_lnk x WHERE x.wiki_space_id = s.pub) AND NOT EXISTS (SELECT 1 FROM wiki_spaces_allowed_roles_lnk x WHERE x.wiki_space_id = s.draft)
   UNION ALL SELECT 'poll', entry, 'author' FROM o WHERE EXISTS (SELECT 1 FROM polls_author_lnk x WHERE x.poll_id = o.pub) AND NOT EXISTS (SELECT 1 FROM polls_author_lnk x WHERE x.poll_id = o.draft)
   UNION ALL SELECT 'poll', entry, 'departments' FROM o WHERE EXISTS (SELECT 1 FROM polls_departments_lnk x WHERE x.poll_id = o.pub) AND NOT EXISTS (SELECT 1 FROM polls_departments_lnk x WHERE x.poll_id = o.draft)
   UNION ALL SELECT 'document', entry, 'uploadedBy' FROM f WHERE EXISTS (SELECT 1 FROM documents_uploaded_by_lnk x WHERE x.document_id = f.pub) AND NOT EXISTS (SELECT 1 FROM documents_uploaded_by_lnk x WHERE x.document_id = f.draft)
   UNION ALL SELECT 'document', entry, 'departments' FROM f WHERE EXISTS (SELECT 1 FROM documents_departments_lnk x WHERE x.document_id = f.pub) AND NOT EXISTS (SELECT 1 FROM documents_departments_lnk x WHERE x.document_id = f.draft)
   UNION ALL SELECT 'quick link', entry, 'departments' FROM k WHERE EXISTS (SELECT 1 FROM quick_links_departments_lnk x WHERE x.quick_link_id = k.pub) AND NOT EXISTS (SELECT 1 FROM quick_links_departments_lnk x WHERE x.quick_link_id = k.draft)
   UNION ALL SELECT 'lesson', entry, 'course' FROM l WHERE EXISTS (SELECT 1 FROM lessons_course_lnk x WHERE x.lesson_id = l.pub) AND NOT EXISTS (SELECT 1 FROM lessons_course_lnk x WHERE x.lesson_id = l.draft)
   ORDER BY 1, 2, 3;
   SQL
   ```

   For each row, open the entry in the Content Manager and either select
   the missing relation again before you publish, or use **Discard
   changes**, which restores every relation from the published version but
   also drops the draft's other unpublished edits. You can do this before or
   after the deploy; after it, a row about a lesson's course or a wiki
   page's space or parent may be gone because the repair re-linked that
   draft (see "What the first boot changes" below).

5. **Recommended, read-only: list saved moves the repair would refuse.**
   A lesson or wiki page whose draft (saved, not published) sits in another
   course, space or parent page than its published version, while that
   course, space or page has no draft yet. Copying the course, space or
   page would move the lesson or page back, so the repair skips it and logs
   an error until the move is published or discarded.

   ```bash
   psql_db <<'SQL'
   SELECT 'lesson' AS type, d.title AS entry, dt.title AS saved_move_to, pt.title AS published_in
   FROM lessons d
   JOIN lessons p ON p.document_id = d.document_id AND p.published_at IS NOT NULL
   JOIN lessons_course_lnk dl ON dl.lesson_id = d.id JOIN courses dt ON dt.id = dl.course_id
   JOIN lessons_course_lnk pl ON pl.lesson_id = p.id JOIN courses pt ON pt.id = pl.course_id
   WHERE d.published_at IS NULL AND dt.document_id <> pt.document_id
     AND NOT EXISTS (SELECT 1 FROM courses x WHERE x.document_id = pt.document_id AND x.published_at IS NULL)
   UNION ALL
   SELECT 'wiki page (space)', d.title, dt.name, pt.name
   FROM wiki_pages d
   JOIN wiki_pages p ON p.document_id = d.document_id AND p.published_at IS NOT NULL
   JOIN wiki_pages_space_lnk dl ON dl.wiki_page_id = d.id JOIN wiki_spaces dt ON dt.id = dl.wiki_space_id
   JOIN wiki_pages_space_lnk pl ON pl.wiki_page_id = p.id JOIN wiki_spaces pt ON pt.id = pl.wiki_space_id
   WHERE d.published_at IS NULL AND dt.document_id <> pt.document_id
     AND NOT EXISTS (SELECT 1 FROM wiki_spaces x WHERE x.document_id = pt.document_id AND x.published_at IS NULL)
   UNION ALL
   SELECT 'wiki page (parent)', d.title, dt.title, pt.title
   FROM wiki_pages d
   JOIN wiki_pages p ON p.document_id = d.document_id AND p.published_at IS NOT NULL
   JOIN wiki_pages_parent_lnk dl ON dl.wiki_page_id = d.id JOIN wiki_pages dt ON dt.id = dl.inv_wiki_page_id
   JOIN wiki_pages_parent_lnk pl ON pl.wiki_page_id = p.id JOIN wiki_pages pt ON pt.id = pl.inv_wiki_page_id
   WHERE d.published_at IS NULL AND dt.document_id <> pt.document_id
     AND NOT EXISTS (SELECT 1 FROM wiki_pages x WHERE x.document_id = pt.document_id AND x.published_at IS NULL)
   ORDER BY 1, 2;
   SQL
   ```

   For each row, open the lesson or page in the Content Manager and
   **Publish** it (the move goes live) or **Discard changes** (the move is
   dropped), preferably before the deploy. If you skip this, the repair
   leaves those courses, spaces or pages without a draft for now, and step
   8 shows what to do then.

6. **Backup:** `infra/deploy.sh` takes the mandatory pre-deploy Postgres
   backup. On a standalone Caddy box, run `infra/backup/pg-backup.sh` (or
   the manual dump in [§7.1](#71-manual-postgres-backup)) yourself first.

**Deploy**

7. Run `infra/deploy.sh` on the Traefik host; on a standalone Caddy box,
   `docker compose up -d --build` from `infra/`. For a few dozen entries the
   repair adds about a second to this one boot (measured on Postgres 16).

**What the first boot changes in the database.** One new draft row per
entry counted in step 2, with its link rows and media links; the rows the
admin panel creates for any entry it edits. Existing drafts of lessons and
wiki pages that have no course, space or parent page get linked to the new
draft of the course, space or page their published version belongs to.
Published rows, notifications and wiki revisions stay as they are. Each
vote of a repaired poll is also linked to the poll's new draft row (Strapi
links entries of a type without draft & publish, such as a vote, to both
rows); results still count the votes of the published row. No schema
change.

**After the deploy**

8. **cms log.** The first boot prints one line per repaired type, and later
   boots print nothing:

   ```bash
   "${COMPOSE[@]}" logs cms | grep '\[draft-twins\]'
   # [draft-twins] created 5 draft(s) for api::announcement.announcement
   # [draft-twins] created 6 draft(s) for api::event.event
   # ...
   ```

   The numbers match `published_only` from step 2, less the entries named
   in error lines. An error line such as `[draft-twins] <type> <documentId>:
   could not create the draft (<reason>); the next boot retries, and until
   it has a draft, publishing an entry linked to it drops that link` names
   an entry the repair could not copy. The boot continues, readers still see
   the entry, and every boot tries again. By reason:

   - `the pending draft of api::lesson.lesson <documentId> links another
     course (<documentId>); publish or discard that draft` (or of a wiki
     page that links another space or parent): a saved move from step 5.
     Publish that lesson or page or use **Discard changes** on it, then run
     `"${COMPOSE[@]}" restart cms`; that boot creates the missing draft.
   - anything else, for example a lesson whose stored video link fails
     today's validation: open the named entry in the Content Manager
     (**Published** filter), correct the field the reason names, select its
     relations again (they are not carried over for an entry without a
     draft) and publish.

   **Fix the named entry before you edit or publish the entries linked to
   it** (a lesson's course, a course's lessons, a wiki space's pages, a wiki
   page's space, parent and child pages). Until it has a draft, their drafts
   lack the link to it, and publishing one drops that link for readers too,
   e.g. the lesson disappears from its course. If that already happened,
   fix the named entry, then open the entry you published, select the
   relation again and publish. Optionally, rerun the step 2 query and the
   step 5 query: every `published_only` is 0, and step 5 lists nothing.
9. **Admin panel:** **Content Manager → Announcement** (and Event, Wiki
   Page, …) lists the seeded entries in the default view, with the status
   **Published**. Open one that step 4 did not list, change a word,
   publish: its author, department, space and other relations stay.
   Re-link what step 3 listed.

**What users and editors notice** (worth a short release note):

- Readers notice nothing.
- Seeded entries appear in the Content Manager's default list, as
  **Published**.
- Editing and publishing a seeded entry in the admin keeps its relations,
  unless it has a draft saved before the deploy that already lacks some
  (step 4).
- New entries can link to seeded ones, e.g. a wiki page in a seeded space.
- A saved, unpublished move of a lesson or wiki page stays as it is; the
  course, space or page it left gets its draft once the move is published
  or discarded (steps 5 and 8).
- Relations an earlier admin edit already dropped are not restored (step 3).

**Rollback.** The previous images run on the repaired database without a
restore: a draft row next to the published row is the state that every entry
created in the admin panel already has, and nothing in the schema changed.
The old cms simply creates no draft twins, and rolling forward again finds
nothing to repair. The one difference: the old seed writes published-only
rows again, but it only runs on an empty database.

**Local dev (SQLite):** a dev database seeded before this release is
repaired the same way on the next `pnpm cms:dev`; a new one gets draft and
published rows from the seed.

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
  (compose sets its `TZ` from it) until the web's own port (phase 2,
  [batch 8](#upgrading-to-the-web-datetime-port-batch-8-lane-3a); since then
  the web runs in UTC).

No change to secrets, no `JWT_SECRET` rotation, nobody is signed out.

> **Revised 2026-09-26 after review** (read this if you rehearsed with an
> earlier build of this branch): pin the running images as
> `:pre-datetime` before deploying (step 7); a rollback to the previous cms
> now always uses `infra/docker-compose.cms-legacy-tz.yml`, and before the
> repair it is mandatory ([Rolling back this release](#rolling-back-this-release));
> the gap check also fails for a θ in the future, a legacy zone not ahead of
> UTC, or a θ with no write stamp on one side (step 3); `APP_TIME_ZONE` and
> `DATETIME_LEGACY_ZONE` refuse UTC offsets, and the web refuses to serve if
> its container's `TZ` is a name Node cannot find (spell zones as the tz
> database does, step 5); event, poll and announcement times in the DST
> change hour are listed for review (deadline note, steps 3 and 10); the
> audit table records each value's document id and title (a rehearsal copy
> gets the two columns added on its next repair). Nothing else changes for
> an instance.

**What an instance needs.** The repair must know which zone the old cms
wrote in:

| Instance | `infra/.env` |
|---|---|
| Fresh install, or a SQLite-only setup | nothing (leave both `DATETIME_LEGACY_*` empty) |
| Existing instance first deployed on or after 2026-08-15 (compose with `TZ=Europe/Berlin`) | `DATETIME_LEGACY_ZONE=Europe/Berlin` |
| Existing instance that ran before 2026-08-15 (its cms ran in UTC) and took the `aadb2ea` deploy | `DATETIME_LEGACY_ZONE=Europe/Berlin` and `DATETIME_LEGACY_UTC_UNTIL=θ`, the switch instant (step 2) |
| The owner instance | `DATETIME_LEGACY_ZONE=Europe/Berlin`, `DATETIME_LEGACY_UTC_UNTIL=2026-08-15T19:24:28+02:00` (from the report in step 3; the switch came before the `aadb2ea` deploy, see step 2) |

Without `DATETIME_LEGACY_ZONE` on a database with data, the new cms stops at
its first boot with `[datetime] This database holds datetime values written
before the datetime contract …`, changing nothing, and `infra/deploy.sh`
refuses to deploy.

**Deadline: deploy before 2026-10-25, 01:00 UTC** (the Berlin clocks go back
that night). Until the deploy the old cms keeps writing Berlin wall clocks;
values written during the repeated hour 02:00–03:00 cannot be told apart
afterwards (the repair reads them as the later, standard-time instant, and
the report lists them). The same holds, whatever the deploy date, for
**event, poll and announcement times entered for that hour** (2026-10-25
02:00–03:00 Berlin time, or the repeated hour of an earlier year): the old
storage cannot say whether 02:30 meant the first (summer time) or the
second 02:30. The repair takes the second one, so a time meant as the first
becomes an hour late. The report lists each such time with both readings
(step 3 before the repair, step 10 after it); check them and correct the
ones that need it in the admin panel.

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

   θ = B + 1 h works whenever that deploy took less than an hour and really
   was the first start of the cms in the new zone. Confirm it with the report
   in step 3 either way: the switch is not always the deploy that committed
   it. On the owner instance the zone change ran from a restart with the
   edited compose file about an hour before the deploy of `aadb2ea` (backup
   `2026-08-15T20:46:42+02:00`), and θ = B + 1 h from that backup fails the
   gap check. The report's `--around` list shows the switch gap in the owner's
   stored stamps between `2026-08-15 17:04:23` and `19:44:33` (UTC wall
   clock): the cms switched between 19:04 and 19:44 Berlin time, so the
   owner's θ is `2026-08-15T19:24:28+02:00`, with `--around
   2026-08-15T18:56:29+02:00` (the backup of the deploy before the switch).

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
     -e DATETIME_LEGACY_UTC_UNTIL=2026-08-15T19:24:28+02:00 \
     cms node dist/scripts/datetime-migration-report.js --around 2026-08-15T18:56:29+02:00
   ```

   (Standalone Caddy box: drop the Traefik file from `COMPOSE`.) Check:
   - `Gap check: OK` — θ lies in an empty stretch of the stored write
     stamps at least as long as the zone offset (120 minutes in August). The
     `--around` list shows the stamps near B with the switch gap marked
     (`----- gap 2h40m -----` on the owner instance) and suggests a θ inside it. A
     `Gap check: FAILS` means θ is wrong; the lines below it say why (the
     stretch around θ is too short, θ lies in the future, or no write stamp
     lies on one side of θ). Pick a θ inside the marked gap. The migration
     runs the same check and aborts (changing nothing) otherwise.
   - The class counts per table and column (`write-utc`, `write-legacy`,
     `A`, `B`, `C`, `C-allday`, …; see the
     [rules](#310-datetime-contract)).
   - **Ambiguous values**: event, poll and announcement times created before
     θ and saved again after it (class C). The repair reads them as UTC,
     which is right unless someone corrected the time by hand after
     2026-08-15; each open or upcoming one is listed with both readings.
     Note the ones whose "read as Europe/Berlin" line is the intended time:
     you fix those in step 10.
   - **Legacy-zone values in a DST change hour**: the event, poll and
     announcement times among them come first, with document, title and
     both readings (`repeated hour; repaired as … (…Z), the other reading
     is … (…Z)`). Note the ones meant as the other reading: you fix those in
     step 10. Write stamps in that hour follow (nobody can fix those, and
     nothing depends on the hour).

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
     LEGACY="-e DATETIME_LEGACY_ZONE=Europe/Berlin -e DATETIME_LEGACY_UTC_UNTIL=2026-08-15T19:24:28+02:00"
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
   DATETIME_LEGACY_UTC_UNTIL=2026-08-15T19:24:28+02:00
   ```

   Leave `APP_TIME_ZONE` unset (or `Europe/Berlin`) unless the company is
   elsewhere. Spell zones exactly as the tz database does (`Europe/Berlin`,
   not `europe/berlin`; never an offset such as `+02:00`): the cms refuses an
   offset, and compose passed `APP_TIME_ZONE` to the web as `TZ` (until the
   web's datetime port; since then the web runs in UTC), which Node only
   resolves in the exact spelling (the web then answers 500). Then
   `infra/deploy.sh --check` prints `Preflight OK`.

6. **Host backup time.** The nightly `pg-backup.sh` runs from the host
   crontab at 03:00 **host time**; the uploads and search-log janitors run at
   03:30 and 03:35 **`APP_TIME_ZONE`**, and must run after the backup. On a
   host in `Europe/Berlin` (the owner's) nothing changes. On a host in UTC
   with `APP_TIME_ZONE=Europe/Berlin`, 03:00 UTC is 04:00 or 05:00 Berlin:
   move the crontab line to `0 1 * * *` UTC, or set the host zone
   (`timedatectl set-timezone Europe/Berlin`).

**Deploy**

7. **Pin the running images** under a tag no later run overwrites, for a
   rollback ([Rolling back this release](#rolling-back-this-release)):

   ```bash
   docker tag "$(docker inspect -f '{{.Image}}' infra-cms-1)" infra-cms:pre-datetime
   docker tag "$(docker inspect -f '{{.Image}}' infra-web-1)" infra-web:pre-datetime
   ```

   (`deploy.sh` tags the running images `:rollback` on every run; after a
   failed first attempt a second run would tag the new images.) Then run
   `infra/deploy.sh` (it takes the mandatory pre-deploy backup first; keep
   that dump until step 10 is done). On a standalone Caddy box: take the
   backup, then `docker compose up -d --build` from `infra/`.

**What the first boot does** (`docker logs infra-cms-1`):

```
[datetime] process time zone UTC, APP_TIME_ZONE Europe/Berlin
[internal migration]: migrating 2026.10.05T00.00.00.datetime-timestamptz.js
[datetime] legacy repair (run …, legacy zone Europe/Berlin, θ 2026-08-15T17:24:28.000Z): N value(s) rewritten, M column(s) converted to timestamptz, K old value(s) kept in datetime_migration_audit. Classes: …
[datetime] gap check: … min between … and … (needs 120)
[internal migration]: migrated 2026.10.05T00.00.00.datetime-timestamptz.js (…s)
[datetime] converted 3 column(s) to timestamptz: strapi_database_schema.time, strapi_migrations.time, strapi_migrations_internal.time
Strapi started successfully
```

(Strapi labels user migrations `[internal migration]` too.) The repair runs
in one transaction and is recorded in `strapi_migrations`; it never runs
again on this database.

**If the first boot fails** (missing variable, gap check, a lock held for
30 s): the repair changed nothing, the cms exits and compose restarts it in
a loop. The new web container waits for a healthy cms and never starts, so
the site is down. `docker compose up` stops with `dependency failed to
start: container infra-cms-1 …` (exited or unhealthy), and `deploy.sh` stops
right there with `ERROR: docker compose up failed …` and the rollback
commands; the smoke check never runs. The cause is in `docker logs
infra-cms-1`. Either fix it and run `infra/deploy.sh` again (it tags the
now-running new images `:rollback`; the `:pre-datetime` tags from step 7
stay), or roll back **with the legacy-zone override**: the database still
holds naive columns, and the previous cms must not run in UTC on them
([Rolling back this release](#rolling-back-this-release), "before the
repair").

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

    Each value is named by table, row, document id and title (`events#43
    doc k3x… "Town hall" start = …`), followed by both readings and a `now in
    Europe/Berlin:` line with the document's current draft and published
    values (a publish since the repair re-creates the published row, so look
    the document up by its title or id, not by the row number). For each
    value where the `read as Europe/Berlin` line is the intended time
    (someone corrected it by hand after 2026-08-15), correct the time in the
    Strapi admin panel (it now shows the `read as UTC` time).

    The same run ends with `Event, poll and announcement times the repair
    read in a DST change hour` (all of them, with document, title, both
    readings and the current value). For each one meant as the other
    reading (usually the first, summer-time occurrence), set the time again
    in the admin panel.
11. **Later:** after 90 days, and once step 10 is done, drop the audit table:
    `DROP TABLE datetime_migration_audit;` (psql as above). Keep the two
    `DATETIME_LEGACY_*` variables (a rollback override and a restored
    pre-repair dump read them). Once you will not roll back any more, drop
    the pinned images: `docker rmi infra-cms:pre-datetime infra-web:pre-datetime`.

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
>
> *Since batch 9 (lane 4A):* the Entra exchange has shipped, and this
> refusal is gone; `infra/deploy.sh` now checks the Entra settings instead.
> Such an instance moves straight to the new sign-in:
> [Microsoft Entra ID sign-in](#microsoft-entra-id-sign-in) and
> [Upgrading to the Entra sign-in (batch 9, lane 4A)](#upgrading-to-the-entra-sign-in-batch-9-lane-4a).

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
- Microsoft sign-in is unavailable until the Entra exchange ships (see above;
  it shipped with batch 9).
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
  `no-new-privileges` and drop all Linux capabilities (`cap_drop: ALL`; the
  cms since batch 10, checked with an image upload through sharp, `/_health`
  and a `docker stop` in under a second). Every service (Postgres, cms, web,
  and Caddy in mode A) carries `no-new-privileges` and `mem_limit` / `cpus` /
  `pids_limit` caps.
- **Log rotation.** Every service logs through Docker's `json-file` driver
  with rotation (`x-logging` in `docker-compose.yml`): at most 5 files of
  10 MB per container. `docker logs` reads across them; lines beyond the
  newest 50 MB are gone, so a `[digest]` or `[bootstrap]` line from weeks
  ago may no longer be there. Check with
  `docker inspect -f '{{json .HostConfig.LogConfig}}' infra-cms-1`.
- **Security response headers** are set at the edge, not in the app: in
  mode B by the **Traefik** headers middlewares (override file; one per
  container, same values), in mode A by the Caddyfile. Both send
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive
  `Permissions-Policy` (`camera=(), microphone=(), geolocation=(), payment=(),
  usb=()`), and HSTS (`max-age=31536000; includeSubDomains`), and they
  replace the values Strapi's security middleware sets on cms responses
  (`X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`). Caddy
  sends HSTS only for a real host name over HTTPS and removes Strapi's on
  `localhost`. `infra/routing-parity.test.ts` keeps the two sets equal.
- **Compression.** Traefik compresses the web and cms responses (the Strapi
  admin bundle goes out as about 1.9 MB instead of 5.5 MB; Strapi does not
  compress itself), except `/live/*`, which has its own router without
  compression, and any `text/event-stream` response. Caddy's `encode` skips
  the SSE stream because of its `Cache-Control: no-transform`.
- **Rate limiting** guards brute-force / floods, again at Traefik
  (rateLimit middleware, **not** an IP allowlist): 100 req/s per client IP,
  burst 100, on the auth router (`/api/auth/*`, `sinnlos-ratelimit`) and the
  cms router (`/api`, `/admin`, `/upload`, … — not `/uploads`, which goes to
  web; `sinnlos-cms-ratelimit`), and `sinnlos-authlimit` (10 req/s, burst 20)
  on the `sinnlos-signin` router (`POST /sign-in` and `POST /register`). The
  web catch-all and the live router deliberately carry **no** rate limit.
  The authoritative login limiter lives in the app (`authorize()` in
  `apps/web/src/auth.ts`).
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
- **Uploads gate.** The cms middleware `global::uploads-auth` answers 404
  to every request whose decoded, normalised path lies under `/uploads/`
  unless it carries the web proxy's `x-internal-upload-token`, whatever its
  position in `config/middlewares.ts`. Since 2026-09-28 it ignores case,
  like Strapi's router, which matches `/uploads/(.*)` case-insensitively.
  On the Linux images an upper-case `/UPLOADS/…` was a 404 before too; the
  change matters only where `public/` sits on a case-insensitive file
  system. It ships with a normal deploy, no env change.

> For a standalone Caddy box (mode A) all of this applies except the edge
> rate limits: the Caddyfile has none. Front the box with your own proxy if
> you need them. The cms-side guards and the app's login limiter apply
> either way.

### 3.10 Datetime contract

How times are stored and computed (deep-dive decision 04; phase 1 covers
the cms and the database, phase 2 the web):

- **Instants** (a point on the timeline: `createdAt`, event `start`/`end`,
  poll `closesAt`, …) are Strapi `datetime` fields, stored as Postgres
  `timestamptz(6)` and sent as ISO-8601 in UTC with `Z`. Clients must send
  instants with `Z` or an offset. The cms's own code reads instants only
  through its time module, which rejects an offset-less value (a vote
  against such a `closesAt` counts the poll as open), while Strapi's generic
  content API and admin panel read one in the process zone, i.e. as UTC.
  The web and the admin panel always send `Z`.
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
  …`). Changing it later moves those boundaries, not stored instants. Since
  the web's phase 2 (batch 8) the web container runs in UTC as well (`TZ=UTC`
  in its image and in compose) and renders every date in `APP_TIME_ZONE`
  explicitly; it only warns (`[datetime] The web process runs in …, not
  UTC`) when its `TZ` is set to something else. A web image from before
  phase 2 still renders in its process zone: run it only with
  `infra/docker-compose.web-legacy-tz.yml`
  ([rollback](#upgrading-to-the-web-datetime-port-batch-8-lane-3a)). In UTC
  one from phase 1 on refuses to serve (`The web process runs in UTC …, not
  in APP_TIME_ZONE …`); an older one serves and shows every time in UTC.
  `DATETIME_LEGACY_ZONE` follows the same rules.
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
  The schema check runs in Strapi's `beforeSync` hook, before any migration,
  DDL or schema-sync write (`[datetime] This boot runs database migrations /
  changes the database schema and needs a UTC process …`); a check after
  the sync stays as a backstop. A boot refused by that backstop may already
  have applied DDL; a start with `TZ=UTC` finishes it. An ordinary restart
  in a non-UTC process only warns. On SQLite (local development) all of
  this is skipped.
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
  offset, and fails (instead of passing untested) when θ lies in the
  future, when the legacy zone is not ahead of UTC at θ, or when no write
  stamp lies on one side of θ: a database written in one zone only leaves
  `DATETIME_LEGACY_UTC_UNTIL` empty (with `DATETIME_LEGACY_ZONE=UTC` if that
  zone was UTC). Old values stay in `datetime_migration_audit` (as text, with
  the row's document id and title). Strapi's
  bookkeeping tables are left to the guard. Two cms processes booting at
  once (two replicas, a restart overlapping a slow first boot) repair only
  once: the migration holds a transaction-level advisory lock, so the
  second waits (up to the 30 s lock timeout, else its boot fails and the
  restart finds the work done) and then finds no naive column left. The runbook is
  [Upgrading an existing instance to this release](#upgrading-an-existing-instance-to-this-release).
- **Report CLI** (read-only): `node dist/scripts/datetime-migration-report.js`
  in the cms container (`--help` for the options). Before the repair it shows
  what the repair would do; after it, the ambiguous values it recorded. With
  `--baseline`, a dump of an older schema is answered per value: `no table …`
  or `no column … in the baseline dump's schema`, `not in the baseline dump
  (created later)`, or `LOOKUP FAILED (…)` for an unexpected error, after
  which the CLI exits with status 1. Each lookup runs in a savepoint, so one
  failure does not abort the read-only transaction for the rest.
- **Manual SQL.** The guard reads every naive column as a UTC wall clock.
  A cast or `ALTER … TYPE timestamp` on a datetime column in a session of
  another zone stores that zone's wall clock, and the next boot converts
  it with every value shifted (the guard then warns `… is timestamp without
  time zone again and holds values in N row(s)`; it cannot tell a manual
  ALTER from a column Strapi re-created). Run manual DDL on datetime
  columns only in a UTC session: `psql` inside the db container is one
  (compose sets `PGTZ=UTC` there); elsewhere run `SET TimeZone = 'UTC';`
  first.
- **Connection rules.** `DATABASE_URL` must not carry its own `options`
  parameter (it would replace the UTC pin; the cms refuses it unless it sets
  `TimeZone=UTC` itself). A pooler that drops startup options (PgBouncer in
  transaction mode, Azure's built-in PgBouncer on port 6432) breaks the pin:
  connect the cms directly (port 5432).
- **The web** (phase 2). Instants are formatted with next-intl, whose zone
  is `APP_TIME_ZONE` (`apps/web/src/i18n/request.ts`; client components get
  it from the provider); calendar dates go through
  `apps/web/src/lib/plain-date.ts` (`formatPlainDate`), never through a
  midnight instant. "Today", day starts and month grids are `APP_TIME_ZONE`
  days (`zonedDateKey`, `zonedDayStart`, `addDaysToKey`). ESLint rejects
  local `Date` getters and setters, `new Date(y, m, d)`,
  `toLocale{Date,Time}String` and `toISOString().slice(0, 10)` in the web as
  errors (only `plain-date.ts` is exempt), and the web does not use
  temporal-polyfill. The browser's own zone is never used.
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
  Before any `@strapi/*` bump, also run
  `pnpm vitest run apps/cms/src/framework-contract.test.ts` against the new
  packages: it pins the naive-column, `.alter()` and migration-order traps
  (and the other Strapi behaviour the cms relies on, `@strapi/upload`'s
  `/uploads/(.*)` route included), and its version pin fails first on
  purpose.
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
# Edit .env with your domain and secrets; Microsoft sign-in is optional
# (ENTRA_ENABLED=1, see "Microsoft Entra ID sign-in")
docker compose up -d --build
```

With `DOMAIN` set to that host name (DNS pointing at the VM, ports 80/443
open), Caddy requests a Let's Encrypt certificate automatically. Visit
**https://intranet.example.com**.

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
      "ENTRA_ENABLED=0" \
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
      "ENTRA_ENABLED=0" \
      "LIVE_EVENTS_DISABLED=0" \
      "APP_TIME_ZONE=Europe/Berlin" \
      "TZ=UTC"

# TZ: the web image runs in UTC by itself (like the cms) and renders every
# date in APP_TIME_ZONE; TZ=UTC here only makes that explicit. A web image
# from before the web datetime port (batch 8) needs TZ equal to
# APP_TIME_ZONE instead: without it, one from 2026-09-27 on answers every
# request with 500, and an older one quietly shows every time in UTC.

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

**Optional: Microsoft sign-in.** Both apps above run with `ENTRA_ENABLED=0`.
To switch it on, follow [Microsoft Entra ID sign-in](#microsoft-entra-id-sign-in):
register `https://<web-fqdn>/api/auth/callback/microsoft-entra-id` and
`https://<web-fqdn>/sign-in` (where sign-out returns to) as Web redirect URIs
(`<web-fqdn>` is `$WEB_FQDN` above; without the first Microsoft answers
`AADSTS50011`), then set on the cms `ENTRA_ENABLED=1`,
`MS_TENANT_ID`, `MS_CLIENT_ID`, `ENTRA_EXCHANGE_SECRET` and
`ENTRA_SYNC_MODE=dry-run`, and on the web `ENTRA_ENABLED=1`,
`AUTH_MICROSOFT_ENTRA_ID_TENANT_ID`, `AUTH_MICROSOFT_ENTRA_ID_ID`,
`AUTH_MICROSOFT_ENTRA_ID_SECRET` and the same `ENTRA_EXCHANGE_SECRET`
(`az containerapp update --set-env-vars …`, secrets as Container Apps
secrets). The cms needs outbound HTTPS to `login.microsoftonline.com` and
`graph.microsoft.com`.

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
| `WEB_INTERNAL_URL`   |   ✓    |   —    | How the CMS reaches Next.js (compose: `http://sinnlos-web:3000`) |

Generate the secret once (`openssl rand -hex 32`) and paste the same value
into both services' env. If either variable is unset on the cms, it sends no
pings; if the secret is unset on the web, `/api/live/emit` answers 503 (and
401 on a mismatch). The app keeps working either way: live updates stop, and
open pages only refresh through the polling fallback. From outside, `/api/live/emit`
is unreachable: the edge sends every `/api/*` path except `/api/auth/*` to
the cms.

The receiver's logic lives in `apps/web/src/lib/live-emit.ts` (the route
file only delegates to it) and is pinned by `live-emit.test.ts`: 503 without
the secret, 401 for a missing, wrong or length-mismatched header, and with
`LIVE_EVENTS_DISABLED=1` a 204 without publishing, after the secret check.
The move there (2026-09-28) changed no behaviour: it ships with a normal
deploy; run `infra/live-smoke.sh` afterwards as usual.

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
# — or run infra/live-smoke.sh for the full comment→ping proof (it finds its
# target with GETs, posts one "[live-smoke]" comment, expects the ping on an
# uncompressed text/event-stream, and removes the comment and the
# notification it caused; with an announcement author as SMOKE_EMAIL it
# also expects the notification frame).
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

Without `ENTRA_ENABLED=1` there is no Microsoft button: check local sign-in
instead (`<URL>/` redirects to `/sign-in`, e-mail + password lands on the
dashboard with your display name in the top-right), and that
`POST <cms>/api/auth/entra/exchange` answers 404. With Microsoft sign-in
configured ([Microsoft Entra ID sign-in](#microsoft-entra-id-sign-in)):

1. Open `<URL>/` → you should be redirected to `/sign-in`.
2. Click **Sign in with Microsoft** → complete the Microsoft sign-in.
3. You land on the dashboard with your display name in the top-right.
4. The cms log has one `[entra] user=<id> … result=created role=new->…` line
   (`docker logs infra-cms-1 2>&1 | grep '\[entra\]'`), without any token.
5. In the Strapi admin → **Content Manager → User**, your account exists:
   username `entra-<object id>`, provider `microsoft`, the role of your app
   role (at most `member` in dry-run), *Role source* `entra`.
6. `/profile` shows name, job title, phone and office as read-only; *Sign
   out* goes through Microsoft and returns to `/sign-in`.

### 6.4 Role enforcement (optional)

As a non-admin user, try to edit a wiki page you don't own via the Strapi API.
You need that user's Strapi JWT. The web no longer hands it out
(`/api/auth/session` has not carried it since 2026-09-24), and the edge sends
`/api/auth/*` to Auth.js, so get one for a local test account from inside the
stack:

```bash
read -rp 'Test user e-mail: ' TEST_EMAIL
read -rsp 'Password: ' TEST_PASSWORD; echo
export TEST_EMAIL TEST_PASSWORD
docker exec -e TEST_EMAIL -e TEST_PASSWORD infra-web-1 node -e '
  fetch("http://sinnlos-cms:1337/api/auth/local", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      identifier: process.env.TEST_EMAIL,
      password: process.env.TEST_PASSWORD,
    }),
  }).then((r) => r.text()).then(console.log)'
unset TEST_PASSWORD
# → {"jwt":"<your-strapi-jwt>","user":{…}}
```

`sinnlos-cms` is the cms's alias on the project network (since batch 10; on
an older stack use `cms`). In Traefik mode the plain name `cms` also
resolves on the shared `frontend` network, where another project's container
could answer and receive the password. The password reaches the container
through the environment of `docker exec`, not its command line, so it does
not show up in the host's process list.

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

Poll department targeting: take a published poll restricted to one
department (its numeric id is the `id` in `GET <URL>/api/polls` for an
admin JWT) and ask for its results as a member of another department and as
an editor outside it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' <URL>/api/polls/<poll-id>/results \
  -H "Authorization: Bearer <other-department-member-jwt>"
# Expect: 404 (the same answer as for a poll that does not exist)

curl -s <URL>/api/polls/<poll-id>/results \
  -H "Authorization: Bearer <editor-jwt>"
# Expect: 200 with "canVote":false and the poll's departments under "audience"
```

### 6.5 Common failure signals

| Symptom | Likely cause |
|---|---|
| `/admin` returns 502 for 60+ seconds | Strapi still building admin panel — wait and check `docker compose logs -f cms` |
| `/sign-in` redirects loop | `AUTH_URL` doesn't match the host header — check env vars |
| MS login `AADSTS50011` | Redirect URI missing in the Entra app registration — add `<WEB_PUBLIC_URL>/api/auth/callback/microsoft-entra-id` ([Microsoft Entra ID sign-in](#microsoft-entra-id-sign-in), step 1) |
| Microsoft sign-out ends on Microsoft's "You signed out" page instead of `/sign-in` | `<WEB_PUBLIC_URL>/sign-in` is not a registered Web redirect URI of the app ([Microsoft Entra ID sign-in](#microsoft-entra-id-sign-in), step 2); the intranet session is already gone |
| cms stops at boot with `[entra] ENTRA_ENABLED=1, but the Entra configuration is invalid: …`, or every web request answers 500 with `[auth] ENTRA_ENABLED=1, but …` in the web log | The named Entra setting is invalid (a tenant `common` or a non-GUID, a short `ENTRA_EXCHANGE_SECRET`, …). Fix it in `infra/.env` (`infra/deploy.sh --check` names the keys) or unset `ENTRA_ENABLED` |
| `infra/deploy.sh` stops with `ERROR: ENTRA_ENABLED=1, but these Entra settings in infra/.env are invalid: …` | The same check before the deploy ([§3.6](#36-deploy)) |
| Microsoft sign-in lands on `/sign-in` with *"Microsoft sign-in is unavailable right now"* | The web log says why: the cms is unreachable, the two `ENTRA_EXCHANGE_SECRET` values differ (401 unauthorized), or `ENTRA_ENABLED` is not `1` for the cms (404); or the cms could not reach Microsoft (its log: `[entra] exchange failed …`). See [the sign-in errors](#microsoft-entra-id-sign-in) |
| Microsoft sign-in lands on `/sign-in` with *"already exists"* | A local account uses the e-mail address; check whose it is, then bind or delete it ([the 409 procedure](#an-e-mail-address-that-already-has-an-account-409)) |
| Local sign-in answers "Invalid email or password" for an account created through Microsoft sign-in, although an admin set its password | The account still has `provider = microsoft`; Strapi's local login only matches `provider = local`. Change **Provider** to `local` in **Content Manager → User** ([upgrade step 2](#upgrading-to-the-strapi-5551-release-2026-09-25)) |
| Local sign-in answers "This provider is disabled" | `ENTRA_ENABLED=1` without `AUTH_LOCAL_ENABLED=1`: the cms refuses password sign-ins (Entra only). Set `AUTH_LOCAL_ENABLED=1` for a break-glass account. After an image rollback to a cms from before batch 9 that alone does not help: restart this release's cms on it before the rollback, or re-enable the Email provider in the Strapi admin panel afterwards ([Rolling back after switching Microsoft sign-in on](#rolling-back-after-switching-microsoft-sign-in-on), step 2) |
| Dashboard shows "0 departments" even after creating one | Strapi permissions — confirm `public` role has `find` access to departments, OR you're signed in |
| cms restarts in a loop, log says `[env-guard] placeholder value in … Refusing to start in production` | A secret in the env still holds a template placeholder — generate real values (`infra/deploy.sh --check` names the keys) |
| cms log says `[draft-twins] <type> <documentId>: could not create the draft (…)` | The boot repair could not give that published entry its draft twin (the reason is in the parentheses; `the pending draft of … links another …` is a saved, unpublished move of a lesson or wiki page: publish or discard that draft, then restart the cms); the cms runs normally and retries on every boot. Fix the named entry before you edit or publish the entries linked to it (its course, lessons, space, pages, parent or child pages): until it has a draft, publishing one of them drops its link to the named entry. See [Upgrading to the draft-twin repair (FX38)](#upgrading-to-the-draft-twin-repair-fx38), step 8 |
| cms restarts in a loop, log says `[org-dp] departments still holds N draft row(s)` (or `teams`) | The database still has department/team drafts from an earlier release (not migrated, a pre-migration dump restored, or a roll-forward after an image rollback). The data is untouched; run [One-time: org draft/publish off](#one-time-org-draftpublish-off) step 0 (preflight), then steps 3 to 7 |
| `docker compose up` fails with `… must be set` | A required key in `infra/.env` is empty (see [§3.6](#36-deploy)) |
| Traefik mode: right after a deploy every path answers `404 page not found`, and `infra/deploy.sh`'s smoke check fails with HTTP 404 | `DOMAIN` in `infra/.env` is not the bare public host name (a scheme, a port, a typo, the example host), so no router matches. Correct it and run `docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml up -d --no-build web cms`; an image rollback does not help ([§3.6 B](#b-shared-traefik-live-production-layout)) |
| Traefik mode: the site answers 404, or shows another instance's data, after a second Sinnlos stack started behind the same Traefik | One Sinnlos stack per Traefik: the `sinnlos-*` routers of both stacks conflict (Traefik log: `Router defined multiple times with different configurations`) or their services merge. Stop the second stack and give it its own host or Traefik ([§3.6 B](#b-shared-traefik-live-production-layout)) |
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
| every web page answers 500, web log: `… instrumentation hook: The web process runs in …, not in APP_TIME_ZONE …` | A web image from before the web datetime port (batch 8) runs with the current compose file's `TZ=UTC`, usually a rollback without the override: add `-f infra/docker-compose.web-legacy-tz.yml` ([rollback](#upgrading-to-the-web-datetime-port-batch-8-lane-3a)). With that override (or an older compose file) it also appears when Node cannot find the zone: spell `APP_TIME_ZONE` exactly as the tz database does (`Europe/Berlin`, not `europe/berlin`) |
| after a web rollback every page shows times one or two hours early (Berlin), no error | A web image from before the datetime release of 2026-09-27 (such as `:pre-datetime`) runs with the current compose file's `TZ=UTC`: it has no start check and renders in its process zone. Re-up it with `-f infra/docker-compose.web-legacy-tz.yml` ([rollback](#upgrading-to-the-web-datetime-port-batch-8-lane-3a)) |
| web log: `[datetime] The web process runs in …, not UTC` | The current web image runs with a `TZ` other than UTC (a leftover `infra/docker-compose.web-legacy-tz.yml`, or an orchestrator setting): dates are unaffected, but remove it so the web runs in UTC |
| `infra/deploy.sh` stops with `ERROR: the running database still stores datetimes in the pre-contract format …` | Set `DATETIME_LEGACY_ZONE` (and on some instances `DATETIME_LEGACY_UTC_UNTIL`), see the upgrade section |
| `infra/deploy.sh` stops with `ERROR: docker compose up failed …` (compose: `dependency failed to start: container infra-cms-1 …`) | The new cms refused to start; `docker logs infra-cms-1` says why. Fix and re-run, or roll back with the commands it prints ([Rolling back this release](#rolling-back-this-release): before the repair only with the legacy-zone override) |
| `live-smoke: FAIL — timestamp without time zone columns remain` | The guard did not run or failed: check `docker logs infra-cms-1 \| grep datetime` |
| `live-smoke: FAIL — subscribe: … came back compressed (Content-Encoding: …)` | The edge compresses `text/event-stream`, so pings wait in the encoder's buffer: take the compression off the `/live` route |
| `live-smoke: FAIL — sign-in as … produced no session cookie (HTTP 302, redirect …error=CredentialsSignin…)` | Wrong password in the demo credentials file, or the account is blocked or locked. On an Entra-only instance live-smoke skips its sign-in steps by itself |
| `infra/deploy.sh` stops with `ERROR: another infra/deploy.sh is running for compose project infra` | A deploy of the same project runs (the lock goes with its process); let it finish, then re-run |
| `infra/deploy.sh` stops with `ERROR: the checkout … has changed tracked files` | Commit, stash or revert the listed files, then re-run; nothing was changed |
| `infra/deploy.sh` prints `WARNING: CI is …` (or stops, with `--require-green-ci`) | GitHub has no green CI run for the checked-out commit yet: not pushed, still running, or failed |
| `infra/deploy.sh` stops with `failed during '<step>'` | An unexpected error; before `start` the running containers are untouched, from `start` on the rollback commands follow |
| `backup.log` has a `FAIL <kind> <step>` line, or `pg-backup: FAILED at …` | The backup stopped at that step (its plaintext is removed); a pre-deploy one also stops the deploy. Fix the cause (usually the db container is down or the key is missing) and re-run |

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

The volume of compose project `infra` is `infra_cms_uploads` (project name,
underscore, `cms_uploads`); `docker volume ls | grep cms_uploads` shows it.

```bash
# Copy uploads out of the named volume
docker run --rm \
  -v infra_cms_uploads:/uploads \
  -v "$(pwd)/backups":/backup \
  alpine tar czf /backup/uploads-$(date +%Y%m%d-%H%M%S).tar.gz -C /uploads .
```

Restore:

```bash
docker run --rm \
  -v infra_cms_uploads:/uploads \
  -v "$(pwd)/backups":/backup \
  alpine sh -c "cd /uploads && tar xzf /backup/uploads-20260415-120000.tar.gz"
```

### 7.3 Automated daily backups (cron)

The live host ships a ready-made script: **`infra/backup/pg-backup.sh`**. It is
the canonical backup for the `infra` project and does more than the manual
snippets above:

- dumps Postgres from `infra-db-1` (`pg_dump -Fc --no-owner`) and **verifies**
  the dump with `pg_restore --list` before keeping it;
- tars the `infra_cms_uploads` volume, and copies `infra/.env` (every
  secret; the dumps do not hold it);
- gzips each artifact, then **GPG-encrypts** it to the VPS backup public key
  (asymmetric — a host/NAS compromise can't decrypt; the private key lives
  off-box);
- writes into the offsite dir under a `sinnlos/` namespace so the existing
  NAS `rrsync` pull replicates it automatically;
- leaves **no plaintext** behind: everything it writes is `0600` (umask
  077), and a cleanup trap removes this run's plaintext dump, tar, `.env`
  copy, their `.gz` and a partial `.gpg` on every exit, errors and
  `INT`/`TERM`/`HUP` included. A `kill -9` or the OOM killer cannot be
  trapped: what such a run leaves in the backup root (outside the offsite
  dir) every later run reports as `WARN stale plaintext <name>` in
  `backup.log` and on stderr, until the owner deletes it. A root run
  (`deploy.sh`) gives the files it creates the owner of the offsite dir, so
  the cron user and the NAS pull keep reading them;
- **retention**, per series (database, uploads, `.env`; each once for the
  nightly and once for the pre-deploy artifacts): an artifact is removed
  only when it is **older than 7 days** (by the timestamp in its name)
  **and** not among the **newest 7** of its series, and only after the new
  artifact of that series is encrypted. `deploy.sh` runs the script with
  `SINNLOS_BACKUP_KIND=predeploy`: those artifacts are named
  `sinnlos-db-<YYYYmmdd-HHMMSS>-predeploy.dump.gz.gpg` (uploads and `.env`
  alike) and never push a nightly one out. Files of any other name are
  never removed;
- logs to `backup.log` in the offsite dir: `ok <series> <artifact> <size>`,
  `pruned …`, `skip …` (no uploads volume, no `infra/.env`, no quick-access
  `.env` copy to refresh), `FAIL <kind> <step>` and `done <kind>`; and
  writes `last-success` there (`<time> nightly <db artifact>`) after every
  complete **nightly** run, for a freshness monitor. A pre-deploy run
  writes `last-success-predeploy` instead, so a deploy never makes a dead
  cron look fresh.

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

The paths come from `SINNLOS_BACKUP_DIR`, `SINNLOS_GNUPGHOME`,
`SINNLOS_BACKUP_KEYID`, `SINNLOS_ENV_FILE`, `SINNLOS_DB_CONTAINER`
(`infra-db-1`) and `SINNLOS_UPLOADS_VOLUME` (`infra_cms_uploads`); the
defaults are the owner's host, which the cron line relies on.

**Is it running?** `tail -n 5 <offsite>/backup.log` ends with `done nightly`
after 03:00, and `cat <offsite>/last-success` names last night. A `FAIL`
line names the step; the plaintext of that run is already gone. The rule
for a monitor: `last-success` (its modification time, or the time it
starts with) younger than 26 hours; older means the nightly cron stopped
or failed. Only nightly runs write it.

**Restoring an encrypted artifact** (on a machine with the private key,
never on the VPS):

```bash
# Owner-only files in a private directory: the dump and the .env copy hold
# every secret, and a plain `>` would create them with your umask (often 0644).
umask 077
mkdir -m 700 restore && cd restore
gpg --decrypt ../sinnlos-db-<ts>.dump.gz.gpg | gunzip > sinnlos-db-<ts>.dump
gpg --decrypt ../sinnlos-env-<ts>.env.gz.gpg | gunzip > infra.env
```

Then restore the dump as in §7.1 (copy it to the host first, or stream it:
`gpg --decrypt … | gunzip | ssh <host> docker exec -i infra-db-1 pg_restore
-U sinnlos -d sinnlos --clean --if-exists`). The uploads artifact is a
gzipped **plain** tar: once decrypted and gunzipped it is an uncompressed
`.tar`, which `tar xf` reads (the `tar xzf` of §7.2 is for its own
`.tar.gz` and fails on it). Stream it into the volume, so no plaintext
copy lands on disk:

```bash
gpg --decrypt ../sinnlos-uploads-<ts>.tar.gz.gpg | gunzip \
  | ssh <host> docker run --rm -i -v infra_cms_uploads:/uploads alpine tar xf - -C /uploads
```

Delete the plaintext afterwards (`cd .. && rm -rf restore`).

**Restore drill** (off-box, where the key is): `infra/backup/restore-drill.sh`
proves the newest database backup restores. It picks the newest
`sinnlos-db-…dump.gz.gpg` of a directory (the NAS copy of the offsite dir;
nightly and pre-deploy alike) or takes one file, warns when it is older
than 36 hours, starts a throwaway `postgres:16-alpine` without network and
with its data on a tmpfs, streams `gpg --decrypt | gunzip | pg_restore
--exit-on-error` into it (nothing decrypted touches the disk), prints the
row count of every table and fails unless `up_users` came back; the
container goes with its volumes on exit. It needs bash, gpg, gunzip, tar
and docker:

```bash
infra/backup/restore-drill.sh /path/to/copy/of/offsite/sinnlos           # your keyring, gpg asks for the passphrase
infra/backup/restore-drill.sh --key private.asc --passphrase-file pass.txt --all /path/to/copy/of/offsite/sinnlos
```

`--all` also decrypts the newest uploads and `.env` artifacts and checks
them (a tar listing and a key count; no value is shown). `--keep` leaves the
container running for a look (`docker exec -it <name> psql -U drill -d drill`).
Run it after changes to the backup and every few months.

> **Order matters:** the crontab runs in the **host's** zone, while the
> uploads and search-log janitors run at 03:30 / 03:35 **`APP_TIME_ZONE`**
> ([datetime contract](#310-datetime-contract)). The backup must come first,
> so every swept file is still in the previous backup. With the host in
> `APP_TIME_ZONE` the line above is right; on a UTC host with
> `APP_TIME_ZONE=Europe/Berlin` use `0 1 * * *`.

### 7.4 Update procedure (production-safe)

On the live Traefik host the wrapper handles the checks, backup, build,
smoke checks and the SHA tags of the last-known-good deploy in one shot
([§3.6](#36-deploy)):

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

**Rollback.** Since batch 10, `deploy.sh` keeps the images of every good
deploy: after the smoke check and live-smoke pass it tags what web and cms
run as `infra-web:<sha>` / `infra-cms:<sha>` (the first 12 characters of
the commit) and records them as **last-known-good** in
`.git/sinnlos-deploy/infra.state` of the checkout (`history` next to it;
the newest five SHA tags stay, `DEPLOY_KEEP_TAGS`). A failed deploy never
moves that state. When a deploy fails, the script prints the rollback to
it, with every override and extra step the target needs; run it as
printed. By hand:

```bash
grep '^TAG=' .git/sinnlos-deploy/infra.state      # TAG=<sha>
docker tag infra-web:<sha> infra-web:latest
docker tag infra-cms:<sha> infra-cms:latest
docker compose -p infra \
  -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
  up -d --no-build web cms
```

`--no-build` is essential: `--build` would rebuild the broken image.
`docker images infra-web` lists the SHA tags that are still there; any of
them is a rollback target the same way. `:pre-deploy` names the images that
ran when the latest `deploy.sh` run started (it keeps them resolvable
through the build); the script never rolls back to it, and after a failed
deploy it may name that failed deploy's images. **First run of this version:**
there is no state yet, so that one run tags the running images
`infra-web:rollback` / `infra-cms:rollback` before the build, as every
earlier version did, and prints those in its rollback commands; use
`:rollback` in the commands above in that case. It notes their image ids
in `.git/sinnlos-deploy/infra.bootstrap`: a re-run before the first
successful deploy keeps the first run's `:rollback` (the images from
before this version, not the ones a failed run left running) and says
`:rollback kept from <time>`. The first recorded deploy deletes that file;
delete it by hand only to have the next run tag what runs then. The special cases below apply whatever the
target is called (rolling back the datetime release needs an extra override
file, see [Rolling back this release](#rolling-back-this-release); rolling
back the web to an image from before the web datetime port (batch 8) needs
`-f infra/docker-compose.web-legacy-tz.yml` on top of the live compose
files, see below; rolling back poll guest access needs a step **before**
the retag, see
[Rolling back poll department targeting](#rolling-back-poll-department-targeting)).

Since the web datetime port (batch 8) the compose file runs the web in UTC.
A web image from before it renders dates in its process zone and must run
in `APP_TIME_ZONE`; check the image before the re-up:

```bash
docker image inspect -f '{{ index .Config.Labels "org.sinnlos.datetime" }}' infra-web:rollback
```

`zone-explicit` means no override (the command above). An empty line or
`<no value>` means the image predates the port: re-up with the web
override after the live compose files:

```bash
docker compose -p infra \
  -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
  -f infra/docker-compose.web-legacy-tz.yml \
  up -d --no-build web cms
```

Without it, a web from the datetime release (2026-09-27) up to batch 7
answers every request with 500, and an older one (such as `:pre-datetime`)
quietly shows every date and time in UTC. This applies to every recipe in
this document that re-ups a web image from before batch 8, also where its
command lists only the live compose files (it was written before the
port); add the override next to any other override file there. Details:
[Upgrading to the web datetime port](#upgrading-to-the-web-datetime-port-batch-8-lane-3a).

A cms image from before the ICS and cms start fixes, whose
`docker image inspect -f '{{json .Config.Cmd}}'` shows `["pnpm","start"]`
(including `infra-cms:rollback` right after deploying that release), runs
`pnpm start` and downloads pnpm from registry.npmjs.org at every start. Its
build date does not tell: the image that release's first deploy tags
`:rollback` was built on the same day. If the registry is unreachable, start
it directly: see the rollback note of
[Upgrading to the ICS and cms start fixes (2026-09-27)](#upgrading-to-the-ics-and-cms-start-fixes-2026-09-27).
Current images (`["node_modules/.bin/strapi","start"]`) start without
registry access.

If a code revert is needed instead, reset and rebuild (`deploy.sh` refuses a
checkout with changed tracked files, and tags the rebuilt images by that
commit):

```bash
cd /opt/sinnlos
git reset --hard <previous-commit-sha>
infra/deploy.sh
```

If the database schema changed, restore from the pre-deploy backup
(`sinnlos-db-<ts>-predeploy.dump.gz.gpg`; decrypt it first with the off-box
private key, [§7.3](#73-automated-daily-backups-cron)):

```bash
docker exec -i infra-db-1 pg_restore -U sinnlos -d sinnlos --clean --if-exists \
  < sinnlos-db-<timestamp>.dump
```

A dump taken before the org draft/publish migration, restored under a
release from 2026-09-26 on, makes the cms refuse to boot (`[org-dp]`) until
`migrate.sql` has run on it again
([One-time: org draft/publish off](#one-time-org-draftpublish-off), step 0, then
steps 3–7).

#### Rolling back poll department targeting

Stop, revoke, retag, revoke again. The previous images run on the
upgraded database without a restore and need no override file, but the
previous cms never removes the guest vote permission this release added
and ignores the guest switches and the targeting: with that row, every
guest can vote on every open poll there. So, **before** the retag
commands above: save the list of restricted polls
([Checking targeted polls after rolling forward](#checking-targeted-polls-after-rolling-forward)),
stop the cms (`docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml stop cms`;
every start of the new cms grants the permission again) and remove the
permission with `infra/rollback/revoke-guest-poll-vote.sql`, also when
the database or the admin panel shows none. Then retag and start, and
once the previous cms is up, run the removal again: it must remove
nothing. When a deploy fails, `deploy.sh` prints the stop and the removal
before its retag commands and the second removal after them whenever
`infra-cms:rollback` predates guest access or cannot be checked. The
steps, the check and a query for guest votes cast in a late-removal
window are under **Rollback** in
[Upgrading to poll department targeting](#upgrading-to-poll-department-targeting).
Until you roll forward, poll targeting and guest access are not enforced
(guests see every poll and its results again, but cannot vote). Never roll
the cms back to `808e2e7` alone: it lets guests see and vote on every
company-wide poll. Run the checks of
[Checking targeted polls after rolling forward](#checking-targeted-polls-after-rolling-forward)
after rolling forward.
Deployed together with the ICS and cms start fixes, `:rollback` holds the
images from before both (the datetime and draft-twin release of 2026-09-27): roll back web and cms
together, as the commands above do, and mind the `["pnpm","start"]` note
above: that cms image downloads pnpm at every start.

#### Rolling back the ICS and cms start fixes

The retag commands above are enough, web and cms together (the new web
links events by documentId, which the previous cms answers with 500);
nothing in the database changed. The previous cms image starts with
`pnpm start` and needs the registry (see above); the direct start without
it is under **Rollback** in
[Upgrading to the ICS and cms start fixes (2026-09-27)](#upgrading-to-the-ics-and-cms-start-fixes-2026-09-27).

#### Rolling back this release

The previous cms image (the 2026-09-26 release, `7f75ae4`) has no `TZ` of
its own: its compose file ran it in `Europe/Berlin`, and it wrote naive
columns as Berlin wall clocks. The current `infra/docker-compose.yml` runs
the cms in UTC. **Always re-up the previous cms with the override
`infra/docker-compose.cms-legacy-tz.yml`**, which sets the cms's `TZ` to
`DATETIME_LEGACY_ZONE`, using the images pinned in step 7. Since the web
datetime port (batch 8) the compose file also runs the web in UTC, and the
previous web image predates that port: it renders dates in its process
zone and has no start check, so in UTC it would quietly show every date
and time in UTC. Add `infra/docker-compose.web-legacy-tz.yml` as well,
which runs it in `APP_TIME_ZONE` as its own compose file did:

```bash
cd /opt/sinnlos
docker tag infra-cms:pre-datetime infra-cms:latest
docker tag infra-web:pre-datetime infra-web:latest
docker compose -p infra \
  -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
  -f infra/docker-compose.cms-legacy-tz.yml \
  -f infra/docker-compose.web-legacy-tz.yml \
  up -d --no-build web cms
```

(Standalone Caddy box: leave out the Traefik file. Without the step 7 tags,
`:rollback` is only right if `deploy.sh` ran once for this release: every
run tags whatever is running then.) `docker logs infra-cms-1` must not show
`[datetime]` lines (those come from the new image only), and
`docker exec infra-web-1 sh -c 'echo "$TZ"'` must print your
`APP_TIME_ZONE` (`Europe/Berlin` by default).

Whether the repair has run on the database the previous cms will use:

```bash
docker exec -i infra-db-1 sh -c 'psql -X -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT count(*) AS repair_recorded FROM strapi_migrations
 WHERE name = '2026.10.05T00.00.00.datetime-timestamptz.js';
SELECT count(*) AS naive_app_columns FROM information_schema.columns
 WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'
   AND table_name NOT IN ('strapi_migrations', 'strapi_migrations_internal', 'strapi_database_schema');
SQL
```

A first line `0` or a second line above `0` means it has not.

- **Before the repair the override is mandatory**: after a failed first
  boot, after restoring a pre-repair dump, and whenever the check above
  says so. The columns still hold Berlin wall clocks. An old cms in UTC
  reads every one written since 2026-08-15 two hours late (pg parses a
  naive value in the process zone), and each `Date` it writes arrives with
  `+00:00`, which a naive column drops: it stores UTC wall clocks among the
  Berlin ones. The next roll forward (same θ) reads those as Berlin time
  and moves them another one to two hours; the gap check cannot see them,
  they lie far after θ.
- **After the repair** the override is merely better. Re-upping the previous
  image on a repaired database is safe **without** a `pg_restore` (rehearsed
  on Postgres 16): it boots without any schema change (its schema sync finds
  the same schema; the unknown `strapi_migrations` record is ignored), reads
  every instant unchanged, and writes correct instants in any process zone
  (pg sends a `Date` with its offset, and `timestamptz` keeps the instant).
  With the override its date logic (birthday cards, digest days, classified
  expiry) keeps Berlin days; without it those use UTC days, off by one
  between midnight and 02:00 Berlin time. Its cron times are Berlin either
  way (hard-coded there). Rolling forward again is a no-op: the repair is
  recorded and never runs twice.
- Roll forward with `infra/deploy.sh` as usual: it uses the live compose
  files only, so the new cms runs in UTC again. Do not keep the override for
  the new image.
- If you want the previous compose file as a whole instead of the override,
  write it **next to** the live one, because compose takes the directory of
  the first `-f` file as the project directory and reads `.env` there:
  `git show 7f75ae4:infra/docker-compose.yml > infra/docker-compose.prev.yml`,
  then `-f infra/docker-compose.prev.yml -f infra/docker-compose.traefik.yml`
  (a copy under `/tmp` fails with `required variable … is missing a
  value`: compose then looks for `/tmp/.env`). Remove the file after the
  roll forward.
- Do **not** restore the pre-deploy dump just to roll back. If you restore it
  anyway (it predates the repair), it is a pre-repair database: boot the
  previous cms on it only with the override, and keep `DATETIME_LEGACY_ZONE`
  / `DATETIME_LEGACY_UTC_UNTIL` set. The next boot of the new cms repairs it
  again, correctly, **provided no previous cms ran in UTC on it in the
  meantime** (see above: those values cannot be repaired by rule; restore
  again, or correct them by hand). Values written between the deploy and
  the restore are lost with the restore, as with any restore.
- A web-only rollback brings back the old poll close rule (the card treats the
  closing second as open) and nothing else. At that release the web needed
  no override (both compose files ran it in `Europe/Berlin`); since the web
  datetime port (batch 8) the compose file runs the web in UTC, and every
  web image from before that port needs
  `-f infra/docker-compose.web-legacy-tz.yml`
  ([rollback](#upgrading-to-the-web-datetime-port-batch-8-lane-3a)).

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
| TLS | none | none (`DOMAIN=http://localhost`) or Caddy's internal CA | Auto (Let's Encrypt, needs `DOMAIN`) | Auto (Let's Encrypt, needs `DOMAIN`) | Managed by Azure |
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

**Browser certificate warning on `https://localhost`**

With `DOMAIN` unset or `localhost`, Caddy serves `https://localhost` with a
certificate from its own internal CA, which the browser does not trust. For
local Docker either set `DOMAIN=http://localhost` (plain HTTP, and `http://`
in `WEB_PUBLIC_URL`/`CMS_PUBLIC_URL`), or import Caddy's root certificate
(`docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`)
into the browser or OS trust store. (`caddy trust` inside the container only
trusts it inside the container.) Let's Encrypt only issues for a real host
name in `DOMAIN`.

**Microsoft sign-in returns "AADSTS50011: The redirect URI does not match"**

The redirect URI in your Entra app registration must match exactly (including
trailing slash) what Auth.js sends: `<WEB_URL>/api/auth/callback/microsoft-entra-id`
(`AUTH_URL`, compose: `WEB_PUBLIC_URL`). An old
`<CMS_URL>/api/connect/microsoft/callback` entry is unused and can go (see
[Microsoft Entra ID sign-in](#microsoft-entra-id-sign-in)).

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
