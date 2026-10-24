# Single sign-on

There are two optional ways to sign in, next to the local e-mail and password or instead of it:

- Microsoft Entra ID;
- one OIDC identity provider: Keycloak, authentik or Zitadel.

You can use one of them, never both at once. Both are off by default. How the cms checks their tokens: [security.md](security.md), "Sign-in and sessions".

## Microsoft Entra ID sign-in

Sinnlos signs users in with e-mail and password (local sign-in) by default.
**Microsoft Entra ID** (formerly Azure AD) single sign-on is optional and
**off unless `ENTRA_ENABLED=1`** is set; without it every `MS_*` and
`ENTRA_*` value is ignored (leftover `MS_*` lines in `infra/.env` only earn
a note from `infra/deploy.sh`, or a warning when they are a real app
registration; see [the upgrade notes](archive/deployment-history.md#upgrading-to-the-entra-sign-in-batch-9-lane-4a)).
The owner's instance runs without it.

How it works (D-ENTRA-01): Auth.js runs the OIDC code flow against exactly
one tenant. The web then POSTs the ID token and the Graph access token to the
cms (`POST /api/auth/entra/exchange`, server to server, authenticated by
`ENTRA_EXCHANGE_SECRET`). The cms verifies the ID token itself against the
tenant's signing keys, reads Graph `/me`, finds the user by **tenant id +
object id** (backed by a unique index, never by e-mail), creates new users on
the spot with the role of their **app role**, syncs the Entra-owned profile,
and answers with a Strapi JWT that lasts `ENTRA_SESSION_TTL` (12 hours by
default). The web session ends with that JWT, and with
`ENTRA_SYNC_MODE=on` every sign-in re-syncs roles and profile. The cms
therefore needs outbound HTTPS to `login.microsoftonline.com` (signing
keys) and `graph.microsoft.com`. Without the signing keys every Microsoft
sign-in fails with _entra_unavailable_; without Graph, existing users
still sign in (their role as under [What Entra owns](#what-entra-owns), no
profile sync) and a new user only with an app role. Local sign-in is
unaffected.

### Step 1 — Create the app registration

1. Open the [Microsoft Entra admin center](https://entra.microsoft.com) →
   **App registrations** → **New registration**.
2. **Name**: `Sinnlos Intranet` (or any name).
3. **Supported account types**: _Accounts in this organizational directory
   only_ (single tenant). Multi-tenant registrations are not supported: the
   apps refuse `common`, `organizations` and `consumers`.
4. **Redirect URI** (platform _Web_):
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
step 1 (and `http://localhost:3000/sign-in` for local development). _Sign
out_ ends the intranet session, then sends Microsoft users to
`https://login.microsoftonline.com/<tenant>/oauth2/v2.0/logout` with
`post_logout_redirect_uri=${WEB_PUBLIC_URL}/sign-in`, which ends their
Microsoft session as well. Microsoft only sends them back to that address
when it is one of the app's registered redirect URIs; without it they stay
on Microsoft's generic "You signed out" page (the intranet session is gone
either way).

Leave the **Front-channel logout URL** empty. It is a different mechanism
(single sign-out: Microsoft calls it when the user signs out of _another_
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

| Permission                   | Why                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `openid`, `profile`, `email` | The OIDC sign-in and its ID token                                                                                                     |
| `User.Read`                  | Graph `/me` (display name, job title, department, office, phone, member or guest) and `/me/checkMemberGroups` for `ENTRA_GROUP_ROLES` |
| `User.Read.All`              | **Only with `ENTRA_SYNC_MANAGER=1`**: `/me/manager`                                                                                   |

Then **Grant admin consent for \<tenant\>**. `GroupMember.Read.All` (the old
group-name mapping) is not needed; remove it from existing registrations.

### Step 5 — App roles and assignment

**App roles** → **Create app role**, six times, _Allowed member types_:
_Users/Groups_:

| Value                     | Intranet role     |
| ------------------------- | ----------------- |
| `Intranet.Admin`          | `admin_role`      |
| `Intranet.Editor`         | `editor`          |
| `Intranet.DepartmentHead` | `department_head` |
| `Intranet.TeamLead`       | `team_lead`       |
| `Intranet.Member`         | `member`          |
| `Intranet.Guest`          | `guest`           |

Then **Enterprise applications** → the app → **Properties** → _Assignment
required?_ = **Yes** (recommended: without it every member of the tenant can
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

| Name                    | Default | Effect                                                                                                                                                                                                                                                                                          |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENTRA_ENABLED`         | 0       | Master switch for cms and web. With anything but `1`, Entra is fully off and `MS_*` values are ignored. With `1`, the config is validated and an invalid one refuses the start (the cms at boot, the web on its first request) and the deploy (`infra/deploy.sh --check`), naming the variable. |
| `MS_TENANT_ID`          | (unset) | Tenant GUID (required). Web: `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID`; the issuer is computed from it.                                                                                                                                                                                               |
| `MS_CLIENT_ID`          | (unset) | Application (client) GUID (required); the cms checks the ID token's audience against it. Web: `AUTH_MICROSOFT_ENTRA_ID_ID`.                                                                                                                                                                     |
| `MS_CLIENT_SECRET`      | (unset) | Web only (`AUTH_MICROSOFT_ENTRA_ID_SECRET`, required).                                                                                                                                                                                                                                          |
| `ENTRA_EXCHANGE_SECRET` | (unset) | At least 32 characters, the same for web and cms (`openssl rand -hex 32`); distinct from every other secret.                                                                                                                                                                                    |
| `ENTRA_SYNC_MODE`       | dry-run | cms. `on` applies Entra's roles and departments. `dry-run` logs them, never changes an existing user, and creates new users at most as `member`.                                                                                                                                                |
| `ENTRA_DEFAULT_ROLE`    | member  | cms. Role of tenant members with no recognised app role or group: `member`, `guest` or `deny`. Unassigned B2B guests are refused, unless their account is manual (it existed before, an admin bound it, or an admin changed its role); block such an account to keep it out.                    |
| `ENTRA_GROUP_ROLES`     | (empty) | cms, optional. `<roleType>:<groupObjectId>,…`, at most 20 groups (see step 5).                                                                                                                                                                                                                  |
| `ENTRA_SYNC_DEPARTMENT` | 0       | cms. `1` sets the user's department to the one published department whose name equals Entra's `department` (case-insensitive); an empty value, no match or several matches clear it, so access does not survive a move. Only admins and editors can rename departments.                         |
| `ENTRA_SYNC_MANAGER`    | 0       | cms and web. `1` requests `User.Read.All` (admin consent) and syncs the manager from `/me/manager`; a manager who has not signed in yet is linked on their first sign-in.                                                                                                                       |
| `ENTRA_SESSION_TTL`     | 12h     | cms. Lifetime of an Entra sign-in's session, `<n>m`, `<n>h` or `<n>d`, at most `7d`. Local sign-ins keep 7 days.                                                                                                                                                                                |
| `AUTH_LOCAL_ENABLED`    | 0       | Web and cms. `1` keeps local e-mail + password sign-in next to Microsoft (break-glass admin account). Without Entra, local sign-in is always on.                                                                                                                                                |
| `LOCAL_REGISTRATION`    | —       | Removed in v0.27: there is no self-registration any more (admins invite people at `/manage/users`). A leftover `1` only logs a warning at boot.                                                                                                                                                 |

The cms logs one line at every boot: `[entra] disabled`, or
`[entra] enabled tenant=<guid> mode=<on|dry-run> default=<role> groupRules=<n>
syncDepartment=<0|1> syncManager=<0|1> ttl=<ttl> local=<0|1>`.

### What Entra owns

- **Identity**: tenant id + object id, stored in the private user fields
  `entraTenantId` and `microsoftOid`. A new user's username is
  `entra-<object id>`, the e-mail is Graph's `mail`, else the ID token's
  `email`, else the UPN, else `preferred_username` (lower case; without any
  the sign-in answers _entra_unavailable_), and `provider` is `microsoft`;
  such accounts have no password.
- **Role**, per user (`roleSource`, private): users the sign-in created are
  `entra` and follow Entra at every sign-in (also downwards). Every account
  that existed before is `manual`, and so is every account whose role an
  admin changes in the admin panel (detected at the next sign-in): the
  sign-in never touches a manual role, and a manual user is not refused for
  a missing assignment. The app roles come in the signed ID token and need
  no Graph call: when Graph `/me` fails, a matching app role (or a group
  of a successful `ENTRA_GROUP_ROLES` check) still applies and, with
  `ENTRA_SYNC_MODE=on`, can move an Entra-owned user up or down. Without
  such a match the result is unknown: an existing user keeps their role
  and a new user is refused (_entra_unavailable_). When a configured
  `ENTRA_GROUP_ROLES` check fails, the result is unknown even with an
  app-role match (same rules in
  [security.md](./security.md#microsoft-entra-id), "When Graph fails").
  To hand a user back to Entra, use _Rolle an Entra zurückgeben_ on the
  user's page at `/manage/users` (since v0.23), or set _Role source_ =
  `entra` and clear _Entra applied role_ in the admin panel; the next
  sign-in applies Entra's role. A role set at `/manage/users` makes the
  user manual at once.
- **Profile**: display name (only overwritten with a non-empty value), job
  title, phone (first business phone) and office location are copied from
  Entra at every sign-in with `ENTRA_SYNC_MODE=on` and a successful Graph
  `/me` (in `dry-run` only a new account gets them, when it is created; a
  failed `/me` skips them for that sign-in; an empty value clears them; a value over 255
  characters is cut to 255, the column size, e.g. Entra's 256-character
  display names) and are read-only on
  `/profile` (`PUT /api/me` ignores them). Accounts the sign-in created also
  get their e-mail from Entra, unless another account uses that address.
- **Department** and **manager** only with `ENTRA_SYNC_DEPARTMENT=1` /
  `ENTRA_SYNC_MANAGER=1` (table above).
- **Blocking** a user at `/manage/users` (since v0.23; it also raises the
  token version, so old JWTs stay dead after an unblock) or in the admin
  panel takes effect on their next request (Strapi refuses a blocked user's
  JWT) and refuses their next sign-in (_entra_blocked_). Offboarding in Entra takes effect at the latest when
  the session ends (`ENTRA_SESSION_TTL`).

### Staging dry-run, then on

1. Configure a staging instance with `ENTRA_ENABLED=1` and
   `ENTRA_SYNC_MODE=dry-run` (the default), on its own host or behind its
   own Traefik, never behind the production one
   ([§3.6 B](INSTALL.md#behind-your-own-traefik)); run `infra/deploy.sh --check`
   until it prints `Preflight OK`, then deploy (the smoke checks follow
   its `DOMAIN`; a compose project other than `infra` also needs
   `SMOKE_URL`, [§3.6 B](INSTALL.md#behind-your-own-traefik)). The cms logs
   `[entra] enabled … mode=dry-run`.
   `infra/deploy.sh` ends with `infra/live-smoke.sh`, which signs in with
   local demo accounts. On an identity-provider-only instance
   (`ENTRA_ENABLED=1` or, since v0.25.0, `OIDC_ENABLED=1` without
   `AUTH_LOCAL_ENABLED=1`, as the web container runs) live-smoke
   runs its datetime check, then prints `live-smoke: SKIPPED the sign-in
steps: identity-provider-only instance …` and passes; `deploy.sh` runs it there
   even without the demo credentials file. Check the live pings in a
   browser instead: a comment from a second session refreshes the card in
   the first. This holds for every deploy of such an instance, step 5
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
database (the users-permissions _grant_ store): e-mail sign-in on exactly
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
      [§7.4](UPGRADE.md#update-procedure-production-safe)). From the first
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
   Email** → _Enable_ on → _Save_; the web still needs
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
_"An intranet account with your e-mail address already exists"_, and the
cms logs `result=conflict`. Binding hands that account, with everything
it holds, to the Microsoft user. An admin:

1. **checks whose account it is.** Bind only an account you know belongs
   to this person: one an admin created for them, or one they have used
   themselves. Before v0.27 the cms offered self-registration
   (`LOCAL_REGISTRATION=1`) and never verified such an address: if it was
   ever on, anyone could have registered the address first. Do not bind such an
   account while you cannot confirm its owner; **delete it** instead
   (**Content Manager → User** → the user → _Delete_). The cms refuses
   the sessions of a deleted user at their next request, and the next
   Microsoft sign-in creates a fresh account;
2. looks up the user's **Object ID** in the Entra admin center (_Users_ →
   the user → _Overview_) and the tenant's **Directory (tenant) ID**;
3. opens the existing user in the Strapi admin (**Content Manager → User**)
   and sets **entraTenantId** and **microsoftOid** to those two GUIDs, in
   **lower case**, then saves;
4. asks the user to sign in with Microsoft again.

User id, password, provider, e-mail and role stay as they were; the role
stays **manual** until an admin sets _Role source_ = `entra`, and the
Entra-owned profile fields are synced from then on (and read-only on
`/profile`). The binding ends nothing that existed before it: the kept
password still signs in while `AUTH_LOCAL_ENABLED=1`, and sessions issued
earlier stay valid until they expire (7 days) or the password changes. So
when anyone else might know the password, set a new one on the user in the
same Content Manager form (or have the owner change it on `/profile` after
a local sign-in): since batch 13 either change also ends every older
session of the user ([security.md](./security.md#token-versions)). A row with a `microsoftOid` but
no `entraTenantId` (from an old release or a self-registration) is never
trusted.

### Sign-in errors

| The sign-in page says                              | Cause                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _belongs to another organisation_ (`entra_tenant`) | An account of another tenant; Auth.js' own issuer check usually refuses it earlier                                                                                                                                                                                                                                                |
| _already exists_ (`entra_account_exists`)          | See the 409 procedure above                                                                                                                                                                                                                                                                                                       |
| _has no access_ (`entra_not_assigned`)             | No app role and `ENTRA_DEFAULT_ROLE=deny`, or a B2B guest without `Intranet.Guest` (new or Entra-owned accounts only; a manual account is never refused for this)                                                                                                                                                                 |
| _is blocked_ (`entra_blocked`)                     | The account is blocked in the admin panel                                                                                                                                                                                                                                                                                         |
| _could not be verified_ (`entra_invalid`)          | The ID token was refused (clock skew over 5 minutes, issued more than about 15 minutes before the exchange, another app's token) or Graph `/me` is another user                                                                                                                                                                   |
| _unavailable right now_ (`entra_unavailable`)      | The cms is unreachable or cannot reach Microsoft, the two `ENTRA_EXCHANGE_SECRET` values differ (the web logs it), `ENTRA_ENABLED` is not `1` for the cms, a new user's role could not be decided (the Graph group check failed, or Graph `/me` failed and no app role or group matched), or a new identity has no e-mail address |

A failed database write shows in the cms log as `[entra] exchange failed (<code>)`
(the sign-in answered _unavailable_) or `[entra] user=<id>: <step> failed (<code>)`
(an optional profile, department or manager write; the sign-in went on).
`<code>` is a Postgres SQLSTATE such as `22001` (value too long), a SQLite or
Node error code, or an error class name; the SQL and the profile values are
never logged.

---

## OIDC sign-in (Keycloak, authentik, Zitadel)

Since v0.25.0 Sinnlos can sign users in through any standard OpenID Connect
identity provider; Keycloak, authentik and Zitadel are tested and have a
recipe below. It is **off unless `OIDC_ENABLED=1`** is set, and it is
**either Entra or OIDC**: with `ENTRA_ENABLED=1` and `OIDC_ENABLED=1` both
apps refuse to start (and `infra/deploy.sh --check` refuses the deploy).

How it works: the same pattern as Entra, without Graph. Auth.js runs the
OIDC code flow (with PKCE) against `OIDC_ISSUER`; the web then POSTs the ID
token to the cms (`POST /api/auth/oidc/exchange`, server to server,
authenticated by `OIDC_EXCHANGE_SECRET`). The cms reads the identity
provider's discovery document, verifies the ID token itself against its
signing keys (asymmetric algorithms only: an HS256 token is refused even
though Auth.js would accept it), finds the user by **issuer + subject**
(`sub`, backed by a unique index, never by e-mail), creates new users on
the spot with the role from the token, syncs the display name (and
department, if configured), and answers with a Strapi JWT that lasts
`OIDC_SESSION_TTL` (12 hours by default). The web session ends with that
JWT. Both apps need outbound HTTPS to the identity provider (discovery,
signing keys; the web also its token endpoint). Local sign-in is off while
OIDC is on, unless `AUTH_LOCAL_ENABLED=1` keeps it as break-glass.

### Configuration

Set these in `infra/.env` (compose hands each app the keys it reads); for
bare-metal development the cms keys go into `apps/cms/.env`, the web keys
into `apps/web/.env.local`. The redirect URI to register at the identity
provider is `${WEB_PUBLIC_URL}/api/auth/callback/oidc`.

| Name                    | Default                | Read by  | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OIDC_ENABLED`          | 0                      | cms, web | Master switch, exactly `1`. With anything else every `OIDC_*` value is ignored. With `1` the config is validated and an invalid one refuses the start (cms at boot, web on its first request) and the deploy, naming the variable.                                                                                                                                                                                                     |
| `OIDC_ISSUER`           | (unset)                | cms, web | Exactly as the identity provider's discovery document (`<issuer>/.well-known/openid-configuration`) writes `issuer`, at most 255 characters, `https:`. For an issuer with a path (Keycloak, authentik) a missing or extra trailing slash fails every sign-in; an issuer without a path (Zitadel) works either way (see the recipes). The cms refuses to start when the discovery document names another issuer or an `http:` endpoint. |
| `OIDC_CLIENT_ID`        | (unset)                | cms, web | The client id; the cms checks the ID token's audience against it.                                                                                                                                                                                                                                                                                                                                                                      |
| `OIDC_CLIENT_SECRET`    | (unset)                | web      | The client secret (confidential client). The cms never needs it.                                                                                                                                                                                                                                                                                                                                                                       |
| `OIDC_EXCHANGE_SECRET`  | (unset)                | cms, web | At least 32 characters, the same for web and cms (`openssl rand -hex 32`); distinct from every other secret.                                                                                                                                                                                                                                                                                                                           |
| `OIDC_SCOPE`            | `openid profile email` | web      | Must contain `openid`. Zitadel's department metadata needs `urn:zitadel:iam:user:metadata` in addition.                                                                                                                                                                                                                                                                                                                                |
| `OIDC_DISPLAY_NAME`     | `Single Sign-On`       | web      | Label of the sign-in button, at most 40 characters.                                                                                                                                                                                                                                                                                                                                                                                    |
| `OIDC_ROLES_CLAIM`      | `roles`                | cms      | Dotted path of the claim with the `Intranet.*` roles: an array of strings, or an object whose keys are the roles (Zitadel).                                                                                                                                                                                                                                                                                                            |
| `OIDC_DEPARTMENT_CLAIM` | (empty)                | cms      | Optional dotted path of a claim with the department **name**. When set, every sign-in sets the department to the one published department with that name (case-insensitive); an empty value, no match or several matches clear it, and the department is read-only at `/manage/users`. Values under `urn:zitadel:iam:user:metadata` are base64url-decoded.                                                                             |
| `OIDC_ZITADEL_ORG_ID`   | (empty)                | cms, web | Zitadel only, digits: the organisation whose users may sign in (required with a `urn:zitadel:` roles claim; see the Zitadel recipe).                                                                                                                                                                                                                                                                                                   |
| `OIDC_DEFAULT_ROLE`     | deny                   | cms      | Role of a user whose token carries no recognised `Intranet.*` role: `deny` (refused, _oidc_not_assigned_), `member` or `guest`. Anything but `deny` lets **every** user of the identity provider in (self-registered ones included): an explicit admission exception.                                                                                                                                                                  |
| `OIDC_SESSION_TTL`      | 12h                    | cms      | Lifetime of an OIDC sign-in's session, `<n>m`, `<n>h` or `<n>d`, at most `7d`. Local sign-ins keep 7 days.                                                                                                                                                                                                                                                                                                                             |
| `OIDC_ALLOW_HTTP`       | 0                      | cms, web | `1` allows an `http:` issuer and endpoints: local development and staging only, never in production (the signing keys would travel unprotected).                                                                                                                                                                                                                                                                                       |
| `AUTH_LOCAL_ENABLED`    | 0                      | cms, web | `1` keeps local e-mail + password sign-in next to OIDC (break-glass admin account).                                                                                                                                                                                                                                                                                                                                                    |

The cms logs one `[oidc]` status line at every boot and one `[oidc]` audit
line per sign-in (the result and the role, never a token or the full
subject).

### Roles: who gets in, with which role

- Each identity provider puts the user's roles into the **signed ID token**
  under `OIDC_ROLES_CLAIM`, with the same names as for Entra:
  `Intranet.Admin` → `admin_role`, `Intranet.Editor` → `editor`,
  `Intranet.DepartmentHead` → `department_head`, `Intranet.TeamLead` →
  `team_lead`, `Intranet.Member` → `member`, `Intranet.Guest` → `guest`.
  Several roles: the highest wins. Other values are ignored.
- **The identity provider is the admission gate.** Without a recognised
  role (and with the default `OIDC_DEFAULT_ROLE=deny`) the sign-in is
  refused (_oidc_not_assigned_), also for an account whose role an admin set
  by hand in Sinnlos. Taking the role away in the identity provider
  therefore always stops new sign-ins.
- Users the sign-in created follow the identity provider at every sign-in,
  also downwards. A role an admin sets at `/manage/users` makes the user
  **manual**: while the identity provider still admits them, that role is
  kept instead of the token's. The hand-back button on the user's page
  returns the role to the identity provider for the next sign-in.
- Claims that grant rights (the roles, and the department when
  `OIDC_DEPARTMENT_CLAIM` is set: department heads' rights follow it) must
  be controlled by the identity provider's admins only. Whoever can create
  or rename the groups or attributes they come from, or change memberships,
  can grant themselves the matching rights in Sinnlos.

### What the identity provider owns

- **Identity**: issuer + subject, in the private user fields `oidcIssuer`
  (the issuer exactly as discovery writes it) and `oidcSubject` (the `sub`
  claim, unchanged, case-sensitive). A new user gets the username
  `oidc-<hash of issuer and subject>`, `provider` `oidc`, no password, and
  the e-mail from the token. The token must carry `email` and
  `email_verified: true`; otherwise the sign-in is refused
  (_oidc_email_unverified_).
- **Display name**: from the token's `name` at every sign-in (only
  overwritten with a non-empty value) and read-only on `/profile`.
  Accounts the sign-in created also get their e-mail from the token,
  unless another account uses that address. Job title, office and phone
  stay editable on `/profile`; no manager is synced.
- **Department**: only with `OIDC_DEPARTMENT_CLAIM` (table above).
- **Sessions and offboarding**: disabling a user (or removing their role)
  in the identity provider stops their **next** sign-in; a running session
  lasts until `OIDC_SESSION_TTL` ends it. To end it at once, block the
  account at `/manage/users` (it raises the token version: the next request
  is refused). Signing out of Sinnlos ends only the Sinnlos session: the
  identity provider's own session stays, so the next sign-in may pass
  without a password prompt there (no single logout).
- **Replay model**: the exchange endpoint trusts the web through
  `OIDC_EXCHANGE_SECRET`; an ID token alone cannot call it. Whoever holds
  that secret could exchange a captured ID token again while it is young
  (about 15 minutes, as with Entra), so keep the secret as private as
  `AUTH_SECRET`.

### Recipe: Keycloak

Tested with Keycloak 26.8.1. Issuer: `https://<host>/realms/<realm>`
(**no** trailing slash; Keycloak before 17 had an extra `/auth`).

1. **Clients → Create client**: _OpenID Connect_, a client id such as
   `sinnlos-web` (`OIDC_CLIENT_ID`). _Client authentication_ **on**
   (confidential), _Standard flow_ on, _Direct access grants_ off.
   _Valid redirect URIs_: `${WEB_PUBLIC_URL}/api/auth/callback/oidc`.
   _Advanced → Proof Key for Code Exchange Code Challenge Method_: `S256`.
2. **Credentials** tab → _Client secret_ → `OIDC_CLIENT_SECRET`.
3. **Roles** tab of the client → create the six client roles
   `Intranet.Admin` … `Intranet.Guest`.
4. **Client scopes** tab → `<client>-dedicated` → _Add mapper_ → _By
   configuration_ → **User Client Role**: _Client ID_ = **this client**
   (left empty, the roles of every client count, and a same-named
   `Intranet.Admin` of another client would grant admin here),
   _Multivalued_ on, _Token Claim Name_ `roles`, _Claim JSON Type_ String,
   _Add to ID token_ **on** (by default Keycloak puts client roles only into
   the access token). `OIDC_ROLES_CLAIM` stays `roles`.
5. Assign the roles: _Users_ → the user → _Role mapping_ → _Assign role_ →
   _Filter by clients_, or to admin-managed groups.
6. E-mail: users an admin creates need _Email verified_ on (or the _Verify
   Email_ required action); `email_verified` comes from that flag. Turn
   _Realm settings → Login → User registration_ off unless self-registration
   is wanted (with `OIDC_DEFAULT_ROLE=deny` a self-registered user without a
   role is refused anyway).
7. Optional department: _Realm settings → User profile → Create attribute_
   `department`, editable by **admins only** (Keycloak 24+ drops attributes
   the user profile does not declare); then a **User Attribute** mapper
   (_User Attribute_ `department`, _Token Claim Name_ `department`, _Add to
   ID token_ on) and `OIDC_DEPARTMENT_CLAIM=department`.
8. A new hostname or a renamed realm changes the issuer: see
   [Identity changes](#identity-changes-issuer-or-subject) before you do it.

### Recipe: authentik

Tested with authentik 2026.8.5; run at least 2025.12.5 or 2026.2.3
(CVE-2026-40166 let non-admin users read the client secrets of confidential
providers). Issuer (issuer mode _per provider_):
`https://<host>/application/o/<application slug>/` **with** the trailing
slash.

1. **Applications → Providers → Create → OAuth2/OpenID Provider**:
   - _Authorization flow_: an authorization flow such as
     `default-provider-authorization-implicit-consent`;
   - _Client type_ **Confidential**; copy _Client ID_ and _Client Secret_;
   - _Redirect URIs_: strict, `${WEB_PUBLIC_URL}/api/auth/callback/oidc`;
   - _Signing key_: **select a certificate** (e.g. _authentik Self-signed
     Certificate_). Without one authentik signs with HS256 and the client
     secret, which the cms refuses (_oidc_invalid_ on every sign-in);
   - _Advanced protocol settings_: _Subject mode_ **Based on the User's
     hashed ID** (default) or _Based on the User's UUID_, never e-mail or
     username (they change); _Include claims in id_token_ on; _Issuer mode_
     _Each provider has a different issuer_; _Grant types_: at least
     **authorization_code** (on 2026.8.5 a provider created through the API
     had none and every sign-in failed with `invalid_request`).
2. **Applications → Create**: a name, a slug (e.g. `sinnlos`), the provider.
3. **Roles**, recommended: a **Scope Mapping** (_Customization → Property
   Mappings → Create → Scope Mapping_, _Scope name_ `profile`) that maps
   chosen group **UUIDs** to role names, added to the provider next to the
   stock mappings:

   ```python
   roles = {
       "<uuid of the admins group>": "Intranet.Admin",
       "<uuid of the editors group>": "Intranet.Editor",
       "<uuid of the members group>": "Intranet.Member",
   }
   return {"roles": [roles[str(group.pk)] for group in request.user.groups.all() if str(group.pk) in roles]}
   ```

   (direct memberships only). `OIDC_ROLES_CLAIM` stays `roles`. Shortcut
   for installs where **only admins** create or rename groups and change
   memberships: groups named `Intranet.*` and `OIDC_ROLES_CLAIM=groups`
   (the stock _profile_ mapping sends group **names**).

4. **E-mail**: the stock _email_ mapping always sends `email_verified:
False`, so with it **nobody** gets in (_oidc_email_unverified_). Remove
   it from the provider and add your own Scope Mapping with _Scope name_
   `email` that sends `email` and an `email_verified` that is true only for
   a verified **current** address, following authentik's guide
   [Verify email address](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/verify-email-address/).
   A constant `True` is only right where every address is set or verified
   outside authentik and users cannot change it. Test it by changing a
   user's address.
5. Optional department: a user attribute `department` that only admins set
   (the user settings flow must not write it), a Scope Mapping (_Scope
   name_ `profile`) returning `{"department": request.user.attributes.get("department")}`,
   and `OIDC_DEPARTMENT_CLAIM=department`.
6. An application without policy bindings is open to every authentik user;
   with `OIDC_DEFAULT_ROLE=deny` users without a role are refused by the
   cms anyway. Bind a group policy to the application to stop them at
   authentik already.

### Recipe: Zitadel

Tested with Zitadel v4.19.5. Issuer: the instance URL (e.g.
`https://<instance>.zitadel.cloud` or the custom domain), no path.

1. **Projects → Create** (e.g. `sinnlos`); in the project's _General_
   settings turn on **Assert Roles on Authentication** and **Check
   authorization on Authentication** (a user without a grant then sees
   "Login not possible").
2. _Roles_: add the keys `Intranet.Admin` … `Intranet.Guest`.
3. _Applications → New_: type **Web**, **Code** flow, authentication
   method _Basic_; redirect URI `${WEB_PUBLIC_URL}/api/auth/callback/oidc`;
   in the token settings turn on **User roles inside ID Token** and **User
   Info inside ID Token**. Copy client id and secret.
4. _Authorizations_: grant the roles to the users.
5. **`OIDC_ZITADEL_ORG_ID`** (required): the _Resource ID_ of the
   organisation whose users may sign in. The web then asks for the scopes
   `urn:zitadel:iam:org:id:<id>` (only that organisation's users can sign
   in) and `urn:zitadel:iam:user:resourceowner`, and the cms refuses users
   of other organisations and counts only roles granted for that
   organisation. Without it, an organisation that received a project grant
   including `Intranet.Admin` could make its own users admins here, and
   Zitadel's project checks do not stop that.
6. `OIDC_ROLES_CLAIM=urn:zitadel:iam:org:project:roles` (an object whose
   keys are the roles; the cms refuses this claim without
   `OIDC_ZITADEL_ORG_ID`).
7. Optional department: user **metadata** `department`, set by admins;
   add `urn:zitadel:iam:user:metadata` to `OIDC_SCOPE` and set
   `OIDC_DEPARTMENT_CLAIM=urn:zitadel:iam:user:metadata.department` (Zitadel
   sends metadata base64-encoded; the cms decodes it).
8. _Login behavior_: turn **Register allowed** off unless self-registration
   is wanted. Zitadel asked an imported user with an unverified address for
   the e-mail code before issuing a token; the cms checks `email_verified`
   in any case.

### An e-mail address that already has an account (409)

As for Entra, a new identity whose e-mail address an existing account uses
is never linked automatically (_oidc_account_exists_, cms log
`result=conflict`). An admin checks whose account it is first (exactly as
in [the Entra 409 procedure](#an-e-mail-address-that-already-has-an-account-409),
step 1: delete a self-registered account you cannot attribute), then opens
the user in **Content Manager → User** and sets **oidcIssuer** to
`OIDC_ISSUER` as discovery writes it and **oidcSubject** to the user's
subject exactly as the ID token carries it (case-sensitive): Keycloak the
user's _ID_, authentik the user's hashed _UID_ (or the UUID, per the
provider's subject mode), Zitadel the user's _Resource ID_. Then the user
signs in again. User id, password and role stay; the role stays manual
until it is handed back. As with Entra, a kept password still signs in
while `AUTH_LOCAL_ENABLED=1` and older sessions stay valid until they
expire, so set a new password when anyone else might know it.

### Identity changes (issuer or subject)

The identity is issuer + subject. A new hostname, a renamed Keycloak realm,
another authentik slug or issuer mode, or a changed authentik subject mode
makes **every** user a new identity: their next sign-in either creates a
second account or answers _oidc_account_exists_. Do not "fix" that with a
blind `UPDATE` of `oidc_issuer`: it is only safe when the new issuer keeps
the same subjects for the same people. Before such a change:

1. list the bound accounts (`oidc_issuer`, `oidc_subject`, e-mail) from a
   backup or a read-only query;
2. confirm, per person, the subject the new configuration will send (one
   test sign-in per kind of account on staging, or the identity provider's
   admin view);
3. after a fresh backup, write the new issuer (and, only where it changed,
   the new subject) on exactly those rows, keeping the user ids, and check
   that no two rows end up with the same pair (the unique index refuses
   it);
4. treat any account you cannot match like the 409 procedure, and remember
   that local passwords and running sessions are not touched by this.

### Sign-in errors

| The sign-in page reports                              | Cause                                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `error=Configuration` right after clicking the button | `OIDC_ISSUER` does not match the discovery document's `issuer` (a missing or extra trailing slash with Keycloak or authentik), the discovery document names an `http:` endpoint while `OIDC_ALLOW_HTTP` is not `1`, or the issuer is unreachable from the web |
| _could not be verified_ (`oidc_invalid`)              | The cms refused the ID token: HS256 (authentik without a signing key), another client's token, clock skew over 5 minutes, issued more than about 15 minutes before the exchange, or a missing `sub` or `exp`                                                  |
| _e-mail not verified_ (`oidc_email_unverified`)       | No `email`, or `email_verified` is not `true` (authentik's stock mapping, Keycloak's _Email verified_ off)                                                                                                                                                    |
| _has no access_ (`oidc_not_assigned`)                 | No recognised `Intranet.*` role with `OIDC_DEFAULT_ROLE=deny` (Keycloak mapper not in the ID token or without the client id), or a Zitadel user of another organisation                                                                                       |
| _already exists_ (`oidc_account_exists`)              | The 409 procedure above                                                                                                                                                                                                                                       |
| _is blocked_ (`oidc_blocked`)                         | The account is blocked at `/manage/users` or in the admin panel                                                                                                                                                                                               |
| _unavailable right now_ (`oidc_unavailable`)          | The cms is unreachable or cannot reach the identity provider's discovery document or signing keys, the two `OIDC_EXCHANGE_SECRET` values differ, `OIDC_ENABLED` is not `1` for the cms, or the issuer the cms sees differs from `OIDC_ISSUER`                 |

---

## AD or LDAP through Keycloak or authentik

sinnlos speaks OIDC only and never reads a directory itself. To sign people in with Active Directory or another LDAP directory:

1. Connect the directory to Keycloak ([User Storage Federation](https://www.keycloak.org/docs/latest/server_admin/#_user-storage-federation)) or to authentik ([LDAP source](https://docs.goauthentik.io/docs/users-sources/sources/protocols/ldap/)).
2. Connect sinnlos to that provider with its recipe above.

Directory groups reach sinnlos only through the provider's role claim ([Roles: who gets in, with which role](#roles-who-gets-in-with-which-role)).

## Second factor for SSO users

An SSO account never gets a sinnlos password or authenticator app. Its sign-in, including the second factor, belongs to the identity provider, so enforce MFA there:

- **Entra:** Conditional Access.
- **Keycloak, authentik and Zitadel:** their login flow or policy.

`MFA_REQUIRED_ROLES` applies to password accounts only.
