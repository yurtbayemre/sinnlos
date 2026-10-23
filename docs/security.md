# Security model

How Sinnlos decides who may see and do what: sign-in and sessions, roles,
the fine print of the permission matrix, the route policies, the global
guards, the per-type access rules, the upload hardening and the frontend's
role gating. The grants themselves are the two tables in the README,
[Roles and permissions](../README.md#roles-and-permissions), which
`infra/readme-permissions.test.ts` pins to the code.

The rules point to the code that enforces them. When this file and the
code disagree, the code wins: fix this file in the same change. The German
[architecture map](./architecture.md) has the history and the reasoning
behind most rules (its §5 conventions and §7 open issues).

## Contents

- [Principles](#principles)
- [Sign-in and sessions](#sign-in-and-sessions)
  - [Local sign-in](#local-sign-in)
  - [Microsoft Entra ID](#microsoft-entra-id)
  - [OIDC (Keycloak, authentik, Zitadel)](#oidc-keycloak-authentik-zitadel)
  - [Sessions and the role flow](#sessions-and-the-role-flow)
  - [Token versions](#token-versions)
- [Roles](#roles)
- [Permission matrix fine print](#permission-matrix-fine-print)
- [Route policies](#route-policies)
  - [Write-side guards](#write-side-guards)
  - [Field-level write allowlist](#field-level-write-allowlist)
  - [Read-side filters](#read-side-filters)
  - [Shared policy helpers](#shared-policy-helpers)
  - [Request ids](#request-ids)
- [Global guards](#global-guards)
  - [Document Service guards](#document-service-guards)
- [Content types and their access rules](#content-types-and-their-access-rules)
  - [Announcement and event targeting](#announcement-and-event-targeting)
  - [Poll department targeting](#poll-department-targeting)
  - [Poll guest access](#poll-guest-access)
  - [Private user fields](#private-user-fields)
  - [Blocked and anonymised people](#blocked-and-anonymised-people)
  - [Module and feature switches](#module-and-feature-switches)
- [Upload hardening](#upload-hardening)
- [Frontend role gating](#frontend-role-gating)
- [Tests that pin these rules](#tests-that-pin-these-rules)

## Principles

- **The cms decides.** A request passes the users-permissions grant of the
  caller's role (the README tables), then the route's policies, the
  field-level write allowlist and the global guards. The web's own checks
  are about the session (its pages, `/live/*` and the `/uploads` proxy need
  a signed-in user) and the shared secret of its internal
  `/api/live/emit`; its role helpers only keep the UI from offering, or
  asking for, what the cms would refuse.
- **Fail closed.** Role checks compare exact role types (`hasRole` from
  `@sinnlos/domain`, re-exported by `apps/cms/src/bootstrap/roles.ts`); an
  unknown, `null` or differently-cased role never passes. Policies return
  strict booleans (Strapi treats `undefined` as a pass). An empty list of
  visible ids becomes `{ id: { $eq: -1 } }`, never `$in: []`, which Strapi's
  query sanitizer would strip (fail open).
- **Hidden reads like missing.** The read filters and the write allowlist
  answer a row the caller may not see like a row that does not exist (an
  empty list, a 404 or the same 400).
- **The boot sync removes only what it lists.** It writes the missing
  grants and the listed revocations in one transaction; an unwanted grant
  on an action the code manages is reported, and a grant on any other
  action is neither removed nor reported (see
  [Permission matrix fine print](#permission-matrix-fine-print)).

## Sign-in and sessions

### Local sign-in

Local e-mail and password sign-in against Strapi (`POST /api/auth/local`,
through Auth.js on the web) is on whenever `ENTRA_ENABLED` is not `1`, and
next to Microsoft only with `AUTH_LOCAL_ENABLED=1`. The cms mirrors that
rule into the users-permissions provider store at every boot
(`apps/cms/src/bootstrap/auth-providers.ts`), so an Entra-only install
refuses password sign-ins in the cms as well, not only in the web form.

- **Registration** (`POST /api/auth/local/register`) is gone (v0.27):
  users-permissions' `allow_register` is false at every boot, the route is
  revoked for `public`, and a leftover `LOCAL_REGISTRATION=1` only earns a
  boot warning. Accounts come from an admin's invitation at
  `/manage/users`, the Strapi admin, or an identity provider.
- **Default role:** the same boot pins `default_role` to `member`, so a new
  local user is a `member`.
- **Passwords:** at least 12 characters, at most 72 bytes (bcrypt), and not
  one of the 5,000 most common passwords of that length (SecLists, in
  `apps/cms/src/utils/common-passwords.ts`, never shipped to the browser).
  The rule runs on every write that carries a password: the Content
  Manager, the user-write guard of the Document Service, the plugin's
  change-password validator and the set-password link. Sign-in never
  re-checks it, so older, shorter passwords keep working until changed.
- **Password links** (invitation and reset): the plugin's own
  `forgotPassword` and `resetPassword` answer 404 at the controller and stay
  revoked for `public`. Instead the web's `/forgot-password` and
  `/set-password` pages call `POST /api/auth/password/forgot` and `/set` on
  the cms: `auth: false`, but only with `x-internal-token` equal to
  `INTERNAL_UPLOAD_TOKEN` (404 without it, or while it is unset on either
  side), and under `/api/auth/*`, which the edge sends to the web, so
  nobody outside reaches them.
  - Links exist only for a local account bound to no identity provider,
    and never hand an Entra or OIDC account a password.
  - The link is `/set-password#<user id>.<43 base64url characters>`: the
    token sits in the fragment, so it reaches no server log and no
    `Referer`; the page reads it once and removes it from the address bar.
    The cms keeps only its SHA-256, with purpose, expiry (invitation 7
    days, reset 1 hour) and the token version, in `resetPasswordToken`.
  - Redemption is one transaction (row lock, constant-time compare,
    password rule, hash, token cleared, token version raised). It issues
    **no** JWT: the user signs in afterwards, second factor included. A
    newer link, a block or a password change invalidates an older link.
  - `forgot` answers the same 202 at once, before any lookup, and sends
    the mail afterwards, so neither the answer nor its timing tells whether
    an account exists. The web limits submissions per IP and per address,
    and Traefik's sign-in edge limit covers both pages.
- **E-mail addresses** are unique ignoring case: the boot creates the
  unique index `up_users_email_lower_uq` on `lower(email)`. If
  case-duplicates already exist it logs an error and skips the index, and
  invitations answer 409 `email_duplicates_exist` until an admin resolves
  them.
- **Password change** (`POST /api/auth/change-password`, the `/profile`
  form): the cms keeps a token version per user and refuses older JWTs, so
  the change signs the account out of every other browser and device; the
  tab that changed it stays signed in (it gets a JWT of the new version,
  which keeps that session's second-factor assurance only when the
  request's token version was still current). A password an admin sets in
  the Strapi admin raises the version as well and signs that user out
  everywhere. How the version works is under
  [Token versions](#token-versions).
- **Blocking** a user in the Strapi admin takes effect on their next request
  (Strapi refuses a blocked user's JWT), and they lose the uploaded files
  within 60 seconds (the web's `/uploads` proxy re-checks the JWT).

### Second factor (TOTP)

v0.27. Password sign-ins of the roles in `MFA_REQUIRED_ROLES` (unset or
empty: `admin_role`, `editor`; `none`: nobody; an unknown role refuses the
boot) need an authenticator app; anyone else may turn it on at `/profile`.
Single sign-on users get their second factor from their identity provider.

- **Claims.** Every JWT the cms issues carries `am` (`pw` for a password
  sign-in, `idp` for the Entra and OIDC exchanges) and, after a verified
  code, `mfa: 1`. The assurance comes only from the request that issues the
  token, never from the user row.
- **Per-request gate** (`apps/cms/src/extensions/users-permissions/strapi-server.ts`, decorating the
  users-permissions strategy): `am: idp` passes; a password token passes
  with `mfa: 1` or when the user needs no second factor. A required but not
  yet enrolled user gets a **restricted** session: only `GET /api/me`,
  `POST /api/me/mfa/setup` and `/activate`; everything else answers 403
  `MfaSetupRequired`, and the web sends that session to `/mfa/setup`. An
  enrolled user's token without `mfa: 1`, a token from before v0.27 of a
  required user, or an unknown claim value answers 401. Role changes and
  resets therefore count on the next request.
- **Sign-in.** `POST /api/auth/local` takes an optional `otp` (a code or a
  recovery code). Only after a correct password does the cms answer
  `mfa_required` or `mfa_invalid`. A code is accepted once (its time step is
  stored with a conditional update), a recovery code too.
- **Enrollment.** The cms generates the secret and hands the web a sealed
  enrollment, bound to the user, their token version and 10 minutes.
  Activation needs a valid code **and the current password**, also in a
  restricted session; it stores the secret encrypted with Strapi's
  `admin::encryption` (`ENCRYPTION_KEY`), returns ten recovery codes once
  (stored as hashes) and a JWT with `mfa: 1`.
- **Resets.** An admin resets a user's second factor at `/manage/users`;
  a locked-out sole admin runs `infra/mfa-reset.sh <email>` on the host.
  Both clear the factor and raise the token version, so every session of
  that user ends. A wrong or rotated `ENCRYPTION_KEY` makes codes fail
  (never a bypass); recovery codes still work, and a rotation needs
  `mfa-reset.sh` for every enrolled user, so keep the key in the `.env`
  backup.
- **Limits.** API tokens (the `content-api-token` strategy) are outside
  this guarantee. The web's live stream and uploads re-check `GET /api/me`
  at most every 60 seconds; a live stream that is already open ends at its
  next rotation, 15 to 30 minutes later (accepted).

### Microsoft Entra ID

Optional and off unless `ENTRA_ENABLED=1` (D-ENTRA-01,
`apps/cms/src/entra/`). Setup:
[README](../README.md#microsoft-entra-id-sign-in-optional); runbook:
[DEPLOYMENT.md](./DEPLOYMENT.md#microsoft-entra-id-sign-in).

1. Auth.js runs the OIDC code flow against the one configured tenant
   (scope `openid profile email User.Read`, no refresh token) and refuses an
   account of any other tenant.
2. The web POSTs the ID token and the Graph access token to the cms
   (`POST /api/auth/entra/exchange`, `auth: false`, authenticated by
   `ENTRA_EXCHANGE_SECRET`; 404 while `ENTRA_ENABLED` is not `1`). The cms
   verifies the ID token itself (the tenant's signing keys, issuer,
   audience, issued at most 10 minutes ago plus 5 minutes of clock
   tolerance), reads Graph `/me`, and finds the user by **tenant id +
   object id**, never by e-mail, backed by a unique database index.
3. A new user is created on the spot (username `entra-<object id>`) with
   the role of their Entra app
   role (`ENTRA_SYNC_MODE=dry-run`: at most `member`). A local account with the same e-mail is never taken over: the
   sign-in answers "account exists" until an admin who has confirmed the
   account is theirs binds it
   ([the 409 procedure](./DEPLOYMENT.md#an-e-mail-address-that-already-has-an-account-409)).
4. With `ENTRA_SYNC_MODE=on` and a successful Graph `/me`, display name,
   job title, phone and office location are synced at every sign-in, and
   department (`ENTRA_SYNC_DEPARTMENT=1`) and manager
   (`ENTRA_SYNC_MANAGER=1`) optionally too; `dry-run` changes no existing
   user and only logs department and manager. For every account bound to
   Entra the four profile fields are read-only on `/profile`.
5. The cms issues a Strapi JWT for `ENTRA_SESSION_TTL` (12 hours by
   default). Each exchange writes one `[entra] user=… result=…` audit line
   without tokens.

Strapi's own Microsoft provider is not used: the cms forces it off and
clears its client id and secret at every boot.

**Entra app role → Strapi role** (`apps/cms/src/entra/roles.ts`). The app
roles come from the signed ID token; the highest privilege wins:

| Entra app role (or `ENTRA_GROUP_ROLES` group) | Strapi `role.type`                                                    |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `Intranet.Admin`                              | `admin_role`                                                          |
| `Intranet.Editor`                             | `editor`                                                              |
| `Intranet.DepartmentHead`                     | `department_head`                                                     |
| `Intranet.TeamLead`                           | `team_lead`                                                           |
| `Intranet.Member`                             | `member`                                                              |
| `Intranet.Guest`                              | `guest`                                                               |
| _(tenant member, no match)_                   | `ENTRA_DEFAULT_ROLE`: `member` (default), `guest` or refused (`deny`) |
| _(B2B guest, no match)_                       | refused                                                               |

The table decides for new users and for the accounts Entra owns
(`roleSource` = `entra`). It does not touch a **manual** account (below):
such an account keeps its role and signs in even when the table says
refused, for example an unassigned B2B guest bound to an existing `member`
account, or `ENTRA_DEFAULT_ROLE=deny`. The same holds for an Entra-owned
account whose role an admin changed: the sign-in turns it manual
(`role=manual-override`; in `dry-run` it only logs that) instead of
refusing it. To keep such a person out, block the account in the Strapi
admin. With _Assignment required_ = Yes on the enterprise application,
Entra refuses unassigned users before it issues a token at all.

`ENTRA_GROUP_ROLES` (optional, `<roleType>:<groupObjectId>,…`, at most 20
groups) adds group **object ids**, checked through Graph
`/me/checkMemberGroups`, for nested groups or tenants without Entra ID P1;
group names never count. Who owns a user's role is stored per user
(`roleSource`): users the sign-in created are `entra` and follow Entra at
every sign-in; every account that existed before, and every account whose
role an admin changes in the Strapi admin, is `manual` and keeps its role.

**When Graph fails** (`resolveEntraRole` and `decideRoleWrite` in
`apps/cms/src/entra/roles.ts`):

- A configured group check (`ENTRA_GROUP_ROLES`) that fails leaves the
  result unknown, app roles included: an existing user keeps their role, a
  new user is refused (_unavailable_).
- A failed Graph `/me` does not stop the signed app roles: they need no
  Graph call, so a match still applies and moves an Entra-owned user up or
  down (with `ENTRA_SYNC_MODE=on`). Only without any app-role or group
  match is the result unknown, because member and B2B guest cannot be told
  apart without `/me`: then an existing user keeps their role and a new
  user is refused.
- A failed `/me` also skips the profile, department and manager sync for
  that sign-in.

`ENTRA_SYNC_MODE=dry-run` (the default) changes no existing user (it logs
what `on` would do) and creates new users as `member` at most; refusals
apply in both modes. More in
[What Entra owns](./DEPLOYMENT.md#what-entra-owns).

### OIDC (Keycloak, authentik, Zitadel)

Optional and off unless `OIDC_ENABLED=1` (v0.25.0, `apps/cms/src/oidc/`,
the shared steps in `apps/cms/src/idp/exchange-core.ts`); never together
with Entra. Runbook and recipes:
[DEPLOYMENT.md](./DEPLOYMENT.md#oidc-sign-in-keycloak-authentik-zitadel).
The same exchange pattern as Entra, without Graph:

1. Auth.js runs the OIDC code flow with PKCE against `OIDC_ISSUER`. It
   checks the issuer of discovery and token but **not** the ID token's
   signature (the oauth4webapi code-flow path), and takes the allowed
   algorithms from discovery, so it would accept an HS256 token signed with
   the client secret: the cms check is the gate.
2. The web POSTs the ID token to `POST /api/auth/oidc/exchange` (`auth:
false`, authenticated by `OIDC_EXCHANGE_SECRET`; 404 while
   `OIDC_ENABLED` is not `1`). The cms reads the issuer's discovery
   document (its `issuer` must equal `OIDC_ISSUER` after URL normalisation;
   the token's `iss` must then equal the discovered issuer exactly),
   verifies the signature against the published keys with **asymmetric
   algorithms only** (RS*, PS*, ES*, EdDSA; never HS* or `none`), the
   audience (and `azp` when present), `exp`, a non-empty `sub`, an issue
   time at most 10 minutes ago plus 5 minutes of clock tolerance, and
   requires one `email` address with `email_verified: true`. With
   `OIDC_ALLOW_HTTP` not `1` the issuer and every endpoint the discovery
   document names must be HTTPS, in the cms and in the web: the web's
   provider fetch (`lib/auth/oidc-fetch.ts`) refuses an http request and a
   discovery document naming an http endpoint before Auth.js redirects to
   it or posts the code and the client secret. A discovery document that
   does not fit the configuration refuses the cms boot; an unreachable
   identity provider is only logged (sign-ins answer 503).
3. The user is found by **issuer + subject** (`oidcIssuer`, `oidcSubject`),
   never by e-mail, backed by a unique database index; a new user is
   created on the spot (`oidc-<hash>`), and a local account with the same
   e-mail is never taken over (the same 409 procedure as Entra).
4. **Admission**: the `Intranet.*` roles under `OIDC_ROLES_CLAIM` decide
   (the highest wins). Without one the sign-in is refused
   (`OIDC_DEFAULT_ROLE=deny`, the default), **also for a manual account**:
   unlike Entra, a hand-set role never admits by itself, so taking the role
   away in the identity provider always stops new sign-ins. A hand-set role
   only chooses which role an admitted user gets. A non-`deny` default
   admits every user of the identity provider.
5. **Zitadel**: with `OIDC_ZITADEL_ORG_ID` the web asks for that
   organisation's scope, and the cms requires
   `urn:zitadel:iam:user:resourceowner:id` to equal it and counts only role
   entries granted for it; an organisation that received a project grant
   cannot make its users admins. The cms refuses a `urn:zitadel:` roles
   claim without it.
6. The display name (and, for rows the sign-in created, the e-mail) is
   synced at every sign-in, the department only with
   `OIDC_DEPARTMENT_CLAIM`; claims that grant rights (roles, department)
   must be admin-controlled in the identity provider. The JWT lasts
   `OIDC_SESSION_TTL` (12 hours by default); disabling a user in the
   identity provider stops new sign-ins, a running session ends with that
   TTL or a block in Sinnlos.

The exchange trusts the web through the shared secret: an ID token alone
cannot call it, and whoever holds the secret could exchange a captured,
still young token again (as with Entra); there is no replay ledger.
Strapi's own `keycloak` provider (it links accounts by e-mail) stays off.

### Sessions and the role flow

A user's role lives in Strapi (`user.role`) and is read **per request**.
Nothing role-related is stored in the web session, so a role change in the
Strapi admin applies on the user's next page load, without a new sign-in:

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Sign-in (web/src/auth.ts, Auth.js)                          │
│     local:     POST /api/auth/local → Strapi JWT                │
│     Microsoft: ID token + Graph token (ENTRA_ENABLED=1) →       │
│                POST /api/auth/entra/exchange → Strapi JWT       │
│                (the cms verifies, provisions, sets the role)    │
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
│     can* predicates, read sections, capabilitiesFor (SH02)      │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼ Server Action / fetch with the caller's JWT
┌─────────────────────────────────────────────────────────────────┐
│  4. Strapi decides: permission matrix + route policies          │
│     + the write allowlist + the global guards                   │
└─────────────────────────────────────────────────────────────────┘
```

JWTs last 7 days for local sign-ins and `ENTRA_SESSION_TTL` for Microsoft
sign-ins, unless a password change revokes them earlier
([Token versions](#token-versions)); rotating `JWT_SECRET` signs everyone
out once. When the session has ended (its JWT expired, or the cms rejects
it), every path ends on the sign-in page with the "session expired" notice:
`web/src/proxy.ts` sends a page load to `/sign-in?expired=1&from=…` and
answers a Server Action with the redirect Next's action client follows,
instead of a 307 it cannot use; a form posted without JavaScript gets a
303, so the browser loads the sign-in page with a GET instead of posting
the form to it again; a Strapi 401 inside a render or an action redirects
the same way.

### Token versions

users-permissions runs its legacy JWT mode (`jwtManagement:
'legacy-support'`, pinned in `apps/cms/config/plugins.ts`): a Strapi JWT is
a signed token, valid until it expires. The cms extension
`apps/cms/src/extensions/users-permissions/strapi-server.ts` (FX40) adds a
per-user token version so that a password change can end the older ones:

- **The claim.** Every JWT the cms issues carries the user's current
  `tokenVersion` in the claim `tv`, for local and Microsoft sign-ins alike.
  Every JWT it verifies must carry exactly the user's current version; a
  JWT without the claim counts as version 0. A mismatch fails like a bad
  signature: the request is unauthenticated (401), and the web sends the
  session to `/sign-in?expired=1`. That costs one primary-key read per
  authenticated request.
- **The bump.** A password change raises the version by one (a single
  atomic statement) and saves the new password in **one database
  transaction**. Nobody sees the new version next to the old password, and
  overlapping changes of one user wait for each other, so the stored
  password always belongs to the change with the highest version. Fail
  closed: when the bump or the save fails, the transaction rolls both back
  and nothing changed (the old password and every session stay, the user
  sees an error, the cms logs `[auth] password not changed: user=<id>`);
  a new password never stands next to older JWTs that still work. It
  covers `POST /api/auth/change-password`, `reset-password` (revoked for
  `public`, should an operator grant it again), `PUT /api/users/:id` with a
  password, and every Document Service update of a user that carries a
  password, the Content Manager in the admin panel included (a guard
  registered in `register()` of `apps/cms/src/index.ts`, which runs the
  bump and the write in one transaction the same way; the cms refuses to
  boot without it). The password actions answer, once the transaction
  committed, with a JWT of exactly the version their bump set, which the
  web stores in the session of the tab that changed it
  (`apps/web/src/lib/profile-actions.ts`).
- **Sign-in races.** A local sign-in reads the version before the
  password hash and stamps that version, so it sees either both old (its
  JWT carries the old version, which the change's commit revokes) or both
  new; a sign-in with the old password that overlaps a change never gets a
  JWT that outlives the change.
- **No input sets it.** The field is private, not searchable and hidden in
  the admin panel (`visible: false`: no field in the edit view, no field
  permission). The same Document Service guard drops `tokenVersion` from
  the data of every create, update and clone of a user (Content Manager,
  `PUT /api/users/:id`, registration, `POST /api/users`, seeds) and logs
  `[auth] tokenVersion dropped …`. Only the atomic bump writes it, so it
  never goes down and a revoked JWT never becomes valid again.
- **Rollback.** A cms from before batch 13 ignores the claim and would
  accept every revoked JWT again under the same `JWT_SECRET`. A rollback of
  the cms to such an image therefore rotates `JWT_SECRET` first (owner
  decision 2026-10-12; everyone signs in again once). The rollback commands
  `infra/deploy.sh` prints after a failed deploy check the target image for
  the token version and demand the rotation when it lacks it
  ([batch 13 rollback](./DEPLOYMENT.md#deploying-batch-13-2026-10-12)).
  The same holds for every **restore** of a database dump or of the
  backed-up `infra/.env`, also with the same images: the dump brings back
  older token versions (and the `.env` possibly an older `JWT_SECRET`), so
  JWTs that a later password change revoked would work again; rotate
  `JWT_SECRET` before the cms starts (`infra/restore-db.sh` rotates it
  between the restore and the start and refuses to start the apps
  without it:
  [Restoring a database dump](./DEPLOYMENT.md#restoring-a-database-dump)).
- **Limits.** The web's `/uploads` proxy caches the cms's answer for up to
  60 seconds, so a revoked JWT can fetch file bytes for up to that minute;
  an open live stream keeps its content-free pings until its next rotation
  (at most 30 minutes, plus that minute). Each change logs
  `[auth] password changed: user=<id> tokenVersion=<n>`. With
  `jwtManagement: 'refresh'` the plugin's own session manager would revoke
  sessions, and the extension steps aside; switching modes is a separate
  decision.

## Roles

| Role              | Who                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin_role`      | Full access, user management, the `/manage` area and reports                                                                                                                                                                                                                                                                           |
| `editor`          | Authors announcements, events, polls, documents, quick links and the wiki; announcements, events, polls and quick links also in the web at `/manage` (since batch 15); moderates comments, reactions and ads                                                                                                                           |
| `department_head` | Edits their own department (description, colour) and its teams (description); writes wiki pages; since batch 15 authors announcements, events and documents of their own department (announcements and events at `/manage`)                                                                                                            |
| `team_lead`       | Edits their own team (description); writes wiki pages                                                                                                                                                                                                                                                                                  |
| `member`          | Reads, comments, reacts, gives kudos, posts ads, answers RSVPs, edits wiki pages they wrote                                                                                                                                                                                                                                            |
| `guest`           | Restricted reader: no announcements (and so no read receipts), no departments or teams, no kudos, no marketplace, no RSVPs, no training; sees only the polls opened to guests                                                                                                                                                          |
| `authenticated`   | users-permissions' built-in role. Neither local registration (`member`) nor the Entra sign-in (an intranet role) assigns it; it applies to accounts an admin put there, or that predate the `member` default. Reads like a `member`, but holds none of the staff-only grants (celebrations, uploads, posting ads) and deletes nothing. |
| `public`          | Anonymous callers: no content grants at all                                                                                                                                                                                                                                                                                            |

The six intranet roles are created at every boot
(`apps/cms/src/bootstrap/roles.ts`). The **staff roles** are the five
intranet roles other than `guest` (`STAFF_ROLES`); the **moderators** are
`admin_role` and `editor` (`MODERATORS`). The Strapi admin panel
(`/admin`) has its own accounts (`admin_users`), separate from these
roles; Strapi's community edition has no SSO for it.

## Permission matrix fine print

The grants are seeded from `PERMISSION_MATRIX`, `CUSTOM_ACTION_GRANTS` and
`USER_READ_ACTIONS` in `apps/cms/src/bootstrap/permission-matrix.ts` and
listed in the [README tables](../README.md#roles-and-permissions). A grant
only lets a request reach the route; what the matrix encodes beyond the
letters:

- **Acknowledgements are immutable read receipts:** only `admin_role` may
  update or delete them.
- **RSVPs:** `delete` is `admin_role` only (removing someone else's RSVP is
  an admin correction); `update` is ownership-gated (`is-event-rsvp-owner`).
- **Classifieds:** create, update and delete for the staff roles, but
  update and delete are ownership-gated by `is-classified-author` (update:
  `admin_role` bypass; delete: `admin_role` and `editor` bypass, for
  moderation). `authenticated` only reads, and holds no upload grant.
- **Comments and reactions:** delete is ownership-gated (`is-comment-author`,
  `is-reaction-author`; moderators bypass).
- **Kudos:** create for every staff role and `authenticated`, but delete
  only for the moderators (`is-admin-or-editor` on the route).
- **Departments and teams (batch 17):** `U` and `editable` use
  `can-edit-department` / `can-edit-team` and the
  [write allowlist](#field-level-write-allowlist). Only `admin_role`
  moderates org content; heads/leads retain their row rights. Every class
  is checked. Content-API create/delete routes and grants are removed;
  structure remains in the panel. Wiki page `C`/`U` uses `can-edit-wiki`.
- **Department authors (batch 15).** `department_head` holds `C` and `U` on
  announcements, events and documents, plus the five authoring actions
  (`publish`, `unpublish`, `discardDraft`, `authoringList`, `editable`) on
  the same three types. `global::can-author` admits the role only with a
  `user.department` and only on items that department owns
  (`ownerDepartment`) and targets ([below](#field-level-write-allowlist));
  there is no `delete` grant, and no authoring grant on quick links, polls,
  wiki spaces or training.
- **The authoring actions (batch 15).** Moderators hold `publish`,
  `unpublish`, `discardDraft`, `authoringList` and `editable` on
  announcements, events, quick links and documents, and `authoringList`
  and `editable` on polls (a poll publishes at create and closes through
  `closesAt`). Never `guest` or `authenticated`. Neither editors nor
  department heads hold `role.find`: audience roles are written as role
  types and resolved on the server.
- **Courses and lessons (batch 17):** `admin_role` and `editor` may create,
  update, list/edit drafts, publish, unpublish and discard drafts through
  `can-author`. There is no content-API delete route. Discard without a
  published version returns `neverPublished` and preserves the document.
- **Activity (batch 17):** only `admin_role` has `audit-event.list` at
  `GET /api/audit-events`; the controller enforces that role independently.
  No generic detail, create, update or delete route is exposed.
- **`search-log`** is write-only telemetry: no content-API route lists raw
  rows; the aggregates come from the `summary` route, granted to
  `admin_role` only.
- **No role holds a `poll-vote` grant.** Votes are cast and counted only
  through the custom `vote` and `results` actions and the batched
  `GET /api/poll-results?ids=` (`batchResults`, up to 50 polls), which every
  role holds, `guest` included; whether a caller may see or vote on a given
  poll is decided per poll ([below](#poll-department-targeting)), and a
  poll the caller may not see is simply left out of the batched answer.
- **Removed core routes.** Generic routes the web never calls are removed
  from the routers (`only:`), not merely left ungranted: all of
  `/api/poll-votes`, notification create and update (rows are written by
  cms lifecycles only), comment, kudos and reaction update, and
  lesson-progress update and delete (receipts are immutable). Corrections
  of those rows happen in the Strapi admin. Their permission rows are
  revoked for every role at boot (`REMOVED_CORE_ACTIONS` →
  `REVOKED_PERMISSIONS`); `routes.matrix.test.ts` pins every content-API
  route to its policies and cross-checks the grants against the routes that
  exist.
- **Nobody reads wiki revisions** (batch 15.1). Since batch 16 a revision
  records a page's draft after each save (and a baseline of its content at
  an upgrade; older rows hold the body before an edit), so whenever a
  page's draft differs from its published version it holds unpublished
  text. Up to batch 15 every staff
  role and `authenticated` read them (`/api/wiki-revisions`,
  `populate=revisions`, filters through the relation). Now
  `/api/wiki-revisions` has no route at all (404), no role holds any of its
  five actions (revoked for every role at boot; a batch-15 database loses
  18 rows), and `wiki-page.revisions` is a closed relation for every
  caller, `admin_role` and `editor` included: without a
  `wiki-revision.find` grant Strapi drops a populate of it and refuses a
  root filter or sort with 400, and the relation guard refuses the filter
  and sort inside a populate, which Strapi does not check
  ([Global guards](#global-guards)). The lifecycle writes revisions in the
  save's transaction; the only reader is `utils/wiki-revisions.ts`, which
  the wiki-page history actions call (lane 16B: the page's editors and
  moderators, fixed projections, a revision of another page is a 404).
  The web reads none otherwise. The type is hidden from the Content Manager and the
  Content-Type Builder, and nobody, super admins included, can create,
  change, publish or delete a revision there: the Content Manager
  registers those actions for displayed types only, and every boot
  removes such grants from every admin role
  (`bootstrap/hidden-type-permissions.ts`; Strapi's own cleanup pages while
  it deletes and can skip rows). An admin role keeps the read it holds (a
  revision opens read-only by its URL); the panel is the moderators' tool,
  which shows every draft anyway, and decision 06 lets moderators read
  history. The role editor does not list hidden types (`@strapi/admin`
  5.57 leaves them out), so it cannot untick that read; the `revisions`
  it lists under Wiki Page is the page's relation field, not a grant on
  revisions. Since batch 16.1 (issue #81) the wiki page form has no
  _Revisions_ field (the schema's `config.attributes.revisions.hidden`:
  the panel neither shows nor writes it, and drops it from a hand-made
  request), and the wiki checks refuse a write that would link or unlink
  a revision through the content API or in code (400 on `revisions`). Batch
  16 had made the field list the draft's revisions (draft & publish off,
  lane 16D), and its add and remove could move one to another page.
- **Revocations must be listed.** The boot sync only ever adds rows, so
  removing an entry from the matrix revokes nothing on an existing
  database: obsolete pairs go into `REVOKED_PERMISSIONS`, which must stay
  disjoint from the grants. The boot's `[bootstrap] permission drift` line
  reports, without removing it, an unwanted grant only on a **managed**
  action, i.e. one that some role is granted or has revoked in the code
  (`planPermissionSync` in `apps/cms/src/bootstrap/sync-permissions.ts`).
  A grant on any other action, for example
  `plugin::users-permissions.user.update` added to `member` in the admin
  panel, is neither revoked nor reported, and the line still says
  `permission drift: none`. The full audit is
  `infra/diagnostics/prod-perm-diff.sql` (read-only, Postgres): its
  `EXTRA_IN_DB` rows list every grant in the database the code does not
  expect, whatever the action. The boot refuses to start when a
  granted action matches no controller action it loaded, and writes all
  missing grants and revocations in one transaction.
- **`guest` exceptions,** on purpose: **no kudos** (celebrations leak hire
  dates), **no classifieds** (the marketplace is internal, and ads populate
  author contact data), **no announcements and therefore no
  acknowledgements** (a guest can never see a mandatory announcement, so
  ack grants were dead attack surface), **no event RSVPs** (guests read the
  calendar but neither respond nor see attendee names, and hold no RSVP
  `summary` grant), and **no training** (no course, lesson or
  lesson-progress grants), while `search-log.create` is granted (search
  telemetry is anonymous by design). Guests hold the poll read, results and
  vote grants, but see and vote only on the polls an admin or editor opened
  to them ([Poll guest access](#poll-guest-access)). Grants that older
  versions handed to `guest` are revoked again through
  `REVOKED_PERMISSIONS`.
- **Every role reads users,** `guest` included:
  `plugin::users-permissions.user.find`, `findOne` and `me`, so populated
  relations such as author, lead and head survive, and the people directory
  works. An earlier attempt to revoke them from `guest` turned every guest
  read that populates a user relation (and the notification visibility
  filter) into a 400, because Strapi's core controllers run `validateQuery`
  before the sanitize pass; on Strapi 5.55.1 such a populate is dropped
  silently instead, which would still strip every author name from guest
  pages, and a filter through a user relation still answers 400. The
  contact fields this would expose are closed on both sides: the
  [contact-field sanitizer](#global-guards) removes them from responses,
  and the [sensitive-query guard](#global-guards) refuses filtering,
  sorting or searching by them.
- **Custom actions** are seeded through `CUSTOM_ACTION_GRANTS`: ICS export
  (every role); celebrations (staff roles only, not `guest` or
  `authenticated`: even without e-mail, the years and days until the
  anniversary reconstruct every hire date); the RSVP `summary` behind
  `/events` (exactly the roles that hold event-rsvp `find`: the staff roles
  and `authenticated`, never `guest`); poll `vote`, `results` and
  `batchResults` (every role); notification mark-read and mark-all-read,
  `/api/me` and `changePassword` (every role); `role.find` (`admin_role`
  only, for the acknowledgement report's audience roles); the search-log
  `summary` (`admin_role` only); the upload grant and the classified
  `cleanupUploads` endpoint (staff roles only).

## Route policies

Policies live in `apps/cms/src/policies/` (22 files) and are attached per
route in `apps/cms/src/api/*/routes/*.ts`.

### Write-side guards

- `can-author` (batch 15, decision 06 §B2): create and update of
  announcements, events, quick links, documents, polls, (batch 16) wiki
  spaces and (batch 17) courses/lessons, and their authoring actions (publish, unpublish, discard-draft,
  the `/authoring` list and the `/:id/editable` form read), configured per
  route with
  `{ uid }` (and the action's `intent`). `admin_role` and `editor` are the
  `moderator` class: **no bypass**, their payloads go through the
  allowlist below like everyone's. A `department_head` with a
  `user.department` is the `departmentAuthor` class on announcements,
  events and documents, on an existing item only when every row of it
  (draft and published) is owned by that department and lies in its
  scope: announcement `department` = theirs, `team` null or one of theirs,
  audience roles staff role types only; event and document `departments`
  = exactly theirs. Everyone else, and every item outside that scope,
  gets 403 on the generic create/update and on the list, and 404 on the
  custom actions (like a hidden findOne, so the answer says nothing about
  the item). Before it reads any row the gate reads the document's
  revision, and the document lock accepts the write only when the locked
  revision still equals it as well as the client's `If-Match`; on a
  mismatch the lock asks the gate's classifier again on the rows under
  the lock, so a caller whose class went away in between (a moderator
  widened the item, the department was deleted, the head was demoted)
  gets 403/404, never 412, and never the new revision.
- `is-admin-or-editor`: delete of announcements, events, polls, documents,
  quick links, wiki spaces and wiki pages (with `If-Match`; a space with
  pages answers 400 `spaceNotEmpty`); kudos delete; the search-log `summary` route.
- `can-edit-department`: update/editable for `admin_role` (`moderator`:
  `description`, `color`, `headerImage`) and the `department_head` whose
  current `user.department` matches (`departmentHead`: `description`,
  `color`, `#rrggbb`). `department.head` is display-only; editors have no class.
- `can-edit-team`: update/editable for `admin_role` (`moderator`:
  `description`, `avatar`), the team's lead (`teamLead`) or its department's
  head (`departmentHead`), both with `description` only. Lead precedence
  applies within the existing `department_head`/`team_lead` grants; a stored
  lead relation never grants access to editors or members. Both org gates
  use the same single-row classifier for reads and locked writes.
- `can-edit-wiki` (rebuilt in batch 16 on the `can-author` model, kind
  `row-write-gate`): every wiki-page route but the reads and the delete,
  configured with `{ uid }` (and the action's `intent`). `admin_role` and
  `editor` are the `moderator` class: **no bypass** since batch 16, their
  payloads go through the allowlist's moderator rule. Create (and
  `createDraft`) by `department_head` and `team_lead` (class `author`)
  only into a space they can read; every action on a page by its author,
  the head of its department or the lead of its team, decided on EVERY row
  of the page (draft and published; `@sinnlos/domain` `classifyWikiEditor`,
  the rule the web's Edit buttons use) and only while the page sits in a
  space the caller can read; `unpublish` and the `/authoring` list for
  moderators only. A refusal is 403 on the generic create/update and the
  lists, 404 on the page actions. The gate reads the page's revision
  before its rows and the lock re-classifies on a mismatch, as for
  `can-author`. A discard of a page without a published row deletes it:
  only its author or a moderator (404 for the other classes, decided under
  the lock).
- `is-classified-author`: ad update and delete only by its author (update:
  `admin_role` bypass only; delete: `admin_role` and `editor` bypass, for
  moderation).
- `is-comment-author`: comment delete only by its author; `admin_role` and
  `editor` bypass. A refusal answers 403 `Forbidden`; an id that names no
  comment reaches the controller's 404.
- `is-reaction-author`: reaction delete only by its author; `admin_role`
  and `editor` bypass.
- `is-event-rsvp-owner`: RSVP update only by the responding user;
  `admin_role` bypasses, `editor` deliberately does not (an RSVP is a
  personal statement, not content).
- `is-notification-recipient`: notification delete only by its recipient;
  `admin_role` bypasses, `editor` does not (personal data).

### Field-level write allowlist

The write policies decide _whether_ a caller may write a row and in which
role class (department head, team lead, author, moderator, department author, …);
`apps/cms/src/utils/write-allowlist.ts` decides _what_ that class may send
(FX07). It is the single place those payload rules live. Since batch 15 it
also holds the `admin_role`/`editor` payloads on announcements, events,
quick links, documents and polls (the `moderator` class), since batch 16
on wiki spaces and wiki pages, and since batch 17 on courses, lessons,
departments and teams. `WRITE_BYPASS_ROLES`, `isWriteBypassRole` and the
`KNOWN_OPEN_PAYLOADS` exceptions are removed: every exposed authored
create/update is checked for every granted role.

The v2 authoring rules (batch 15, decision 06 §B1):

- **Exact keys per class.** The fields each class may send are listed in
  `@sinnlos/domain` (`authoring/fields.ts`) and pinned equal to the rules.
  Department authors get no `pinned`, `requiresAck`, `ackDeadline`,
  `publishAt` or `unpublishAt`. Never writable by anyone: the targeting
  flags (`audience`, `notifyAudience`, `retargetRequired`), ownership
  (`author`, `organizer`, `uploadedBy`, `ownerDepartment`, a page's
  `lastEditor`), `scheduleError`, the derived slugs and the inverse sides
  (`wiki-space.pages`, `wiki-page.children`, `wiki-page.revisions`). A test
  walks every schema attribute of the authored types: each is a field of
  some class or listed in `REFUSED_ATTRIBUTES` with its reason.
- **Document files** (batch 16): `file` in both document rules, a file row
  id. A newly attached file must be the caller's own upload (stamped by
  `POST /api/upload`), carry an allowed stored mime, not be on its way out
  (tombstoned) and be linked by nothing but this document; keeping the
  stored file passes unchecked. That check runs in the policy, before the
  transaction, so it only refuses early: the media claims (Document
  Service guards, below) check the same under the file row's lock.
- **Course and org images (batch 17):** `course.coverImage`,
  `department.headerImage` and `team.avatar` share those claims and early
  checks. They accept JPEG, PNG and WebP up to 5 MB from the domain upload
  table; the actual field selects its MIME rule. Only `admin_role` can
  edit org images; heads/leads gain no org-image capability.
- **Values have codes.** A refused value answers its key in
  `details.keys` and, where the check names a reason, a code in
  `details.codes` (`tooLong`, `invalidInstant`, `invalidUrl`,
  `endBeforeStart`, `notMidnight`, `scheduleInPast`,
  `unpublishBeforePublish`, `expiresBeforePublish`, `optionCount`,
  `frozenAfterVotes`, … : `@sinnlos/domain` `authoring/codes.ts`). A
  relation, role or media value that does not resolve, is foreign or lies
  outside the caller's department answers its key and **no code**, exactly
  like a malformed one: no existence oracle.
- **Relations and roles.** To-one relations and to-many lists are resolved
  to documentIds and written as a full replacement (a to-one targeting key
  takes exactly one target or `null`; a disconnect or an empty shape such
  as `{ connect: [] }` is refused, so it can neither skip a department
  author's pin nor count as a re-target); audience roles are
  role types (`member`, `team_lead`, …) resolved to the users-permissions
  roles on the server, `public` and `authenticated` refused.
- **Targeting never widens implicitly.** `audience` (announcement, poll,
  document, quick link) and the event's `notifyAudience` are re-derived
  ("departments" iff a target is linked) only when the payload carries a
  targeting key; an announcement's `retargetRequired` marker is lowered
  only by a payload that carries `department`, `team` or `audienceRoles`.
  A department author's targeting is pinned to their department (set on
  create when missing; `null`, `[]`, another department or its team are
  refused), and their creates set `ownerDepartment` to it.
- **Server-set fields.** The author, organizer or uploader is the caller
  on create (which also keeps authors out of their own notifications).
- **Cross checks** run over the stored draft overlaid with the payload:
  end after start, an all-day event's local midnights in `APP_TIME_ZONE`,
  the schedule order, an acknowledgement deadline only with
  `requiresAck`, and early publish readiness when `publishAt` is set.
- **Polls.** 2 to 20 answers, unique after trimming (every writer, the
  poll lifecycle); at most 200 characters each through the content API.
  Once a poll has a vote, its options and anonymity can no longer change:
  compared with the published row, refused early here and again under
  the poll's lock at the write ([Poll department targeting](#poll-department-targeting)).
- **No client query on writes.** The authoring controller refuses every
  query key but `status`, takes the status explicitly per type
  (announcements, events, quick links, documents, courses and lessons need
  `draft` or `published`; polls always publish), writes through the Document Service
  and answers a fixed DTO (`documentId`, `version`, `status`,
  `publishedAt`, the schedule fields) with `ETag: "<version>"`. Updates and
  the custom actions need `If-Match` (428 without it, 412 with the current
  revision when stale). A department author's discard of an item without
  a published version answers 400 `neverPublished` instead of deleting it.

The wiki (batch 16, `@sinnlos/domain` `authoring/wiki.ts`):

- Wiki spaces, moderators only: `name`, `icon`, `description`,
  `visibility` with its target (`visibilityTarget`), `allowedRoles` as role
  types, `department`, `team`; the slug derived on create; always
  published.
- Wiki pages: the author classes write `title`, `body`, `summary`, `tags`,
  `tocEnabled`, `order` and `parent`, plus `space` on create and the edit
  note `revisionSummary` on update; moderators also `department`, `team`,
  `publishAt` and the edit note on create. No class moves a page to
  another space or edits its slug (both stay in the admin panel). A
  `parent` must sit in the page's space (for the author classes: a page
  they can read); a NEW parent below the page answers `parentCycle` early,
  and the wiki checks refuse every loop a write adds, for every writer.
- Drafts only through `createDraft`/`saveDraft` (never published) and the
  history actions with fixed answers; the author classes' generic create
  and update stay pinned to published.

Training and organisation authoring (batch 17):

- Courses allow `title`, `description`, `mandatory`, `completionMode`,
  `coverImage`, `publishAt`; lessons allow `title`, `body`, `order`, `course`,
  `videoUrl`, `quiz`, `publishAt`. Slugs remain derived; inverse relations
  and internal fields are refused. The lesson list applies its validated
  course documentId filter before pagination/count. Only the authorised
  editable DTO and panel expose quiz keys; learner responses stay answerless.
- Org writes allow only the exact role fields above. Since v0.22
  admin_role also writes names, the display head, a team's department, lead
  and members (a full replacement), and creates and deletes departments and
  teams (If-Match; the delete hooks run in the same transaction); every other
  role keeps the create/delete revocation. Slugs and inverse links are
  refused for everyone. Both editable and update reject every query key, including
  `status`; the Document Service receives no publication option. Raw legacy
  descriptions are preserved when another field is saved.
- User administration (v0.23): only admin_role reaches `/api/user-management`
  (grant plus controller check); it writes role, department, manager and
  blocked under one directory lock (the Entra sign-in's role write takes it
  too), re-reads the caller there (an admin demoted meanwhile gets 403),
  refuses one's own role or block, Entra-synced fields of bound accounts and
  manager cycles, raises the token version on a block and records an audit
  row. The plugin's generic user writes are revoked for every role,
  `public` included.
- Org update requires `If-Match`, returns only `documentId`/`version` with
  ETag, and reclassifies access under the existing lock before reporting a
  stale version. Missing access is 403 on update and 404 on editable.
- `routes.matrix.test.ts` requires every authored create/update grant to
  have a matching allowlist gate, with no tolerated org payload exception.

The org forms and training authoring web pages belong to the following
batch-17 web step; these guarded backend endpoints are already implemented.
Department-head and team-lead rights compare
department and team row ids, which is valid because departments and teams
have no draft & publish (one row each, stable id). An instance that ran an
earlier release with org drafts runs the one-time migration first
([One-time: org draft/publish off](./DEPLOYMENT.md#one-time-org-draftpublish-off));
the cms refuses to boot until then.

### Read-side filters

- `wiki-visibility`: wiki spaces and pages, by the space's `visibility`
  (public, role, department or team); pages inherit their space's. Its
  revision level has no route since batch 15.1.
- `document-visibility`: documents without departments are company-wide;
  otherwise only the owning departments see them; a document whose
  `audience` is `departments` but whose departments are all gone is for
  `admin_role` and `editor` only until it is re-targeted.
- `quick-link-visibility`: the same scheme as documents.
- `notification-visibility`: only the caller's own rows (recipient =
  caller), for every role: since v0.28 `admin_role` no longer bypasses it;
  `/manage/analytics` reads `GET /api/notifications/unread-count`
  (`admin_role`, a number only).
- `published-only`: pins reads without a row filter (event, department,
  team) to `status=published`, so `?status=draft` returns no unpublished
  entries; department and team have no drafts of their own, but `status`
  still decides which rows of their populated draft & publish relations
  come back. The custom ICS, vote and results actions read published rows
  only as well.
- `poll-visibility`: [poll department targeting](#poll-department-targeting)
  and [guest access](#poll-guest-access), resolved to a non-relational id
  filter; pins `status=published`.
- `acknowledgement-visibility`: only the caller's own read receipts;
  `admin_role` bypasses for the `/manage/acknowledgements` report, except
  while `read-confirmations` is in `FEATURES_OFF`.
- `event-rsvp-own-rows`: raw RSVP reads only the caller's own answers
  (`$and`-ed onto the request, so a client filter only narrows); a client
  filter on the `user` relation answers 400. `admin_role` bypasses
  (corrections); editors do not. The event-rsvp controller also answers
  400 to a `Strapi-Response-Format` header from anyone but `admin_role`.
  Everyone else's answers come only through the aggregated `summary`.
- `announcement-visibility`: server-side audience targeting:
  `department` AND `team` AND `audienceRoles`, each only when set
  (`@sinnlos/domain` `isAnnouncementTargetedTo`; the `audience` field is not
  part of the decision), resolved to a non-relational id filter; pins
  `status=published`.
- `comment-target-visibility`: comment and reaction reads filtered to
  targets the caller may see (the create side checks the same in the
  controllers via `isTargetVisible`). A read that pins exactly one
  `{targetType, targetDocumentId}` with `$eq` (the web's comment sections)
  checks only that target; any other filter resolves every visible target.
  Both judge a target by its published row when it has one, so a wiki
  space widened or a page moved only in an unpublished draft, or a
  published page whose space was never published, opens no threads.
- `training-visibility`: courses and lessons pinned to `status=published`;
  a lesson is visible only while its course is published (fail closed).
- `lesson-progress-visibility`: only the caller's own completion receipts;
  `admin_role` bypasses for the `/manage/training/report` report, except
  while `training-reports` (or `training`) is in `FEATURES_OFF`.

The visibility filters (wiki, documents, quick links, `published-only`,
polls, announcements, comment targets, training) let `admin_role` and
`editor` through, drafts included; the own-row filters (acknowledgements,
RSVPs, lesson progress) only `admin_role`, the first and the last not
while their feature is switched off; notifications let nobody through.

### Shared policy helpers

In `apps/cms/src/utils/`:

- `policy-query.ts`: `getMutableQuery` (policies must mutate the real Koa
  `request.query`; `policyContext.query` is a copy the core controllers
  never read), `narrowFilters` (a policy's clause is always `$and`-composed
  with the client filter, never spread-merged, so a client filter can only
  narrow), `restrictiveIdFilter` (an empty id list becomes
  `{ id: { $eq: -1 } }`), `boundedIdFilter` (a list longer than one SQL
  statement can bind answers with nothing and logs a `[policy]` error line
  instead of a 500; it covers the loaders that bind only an id list: wiki
  pages and revisions, lessons and the comment and reaction wiki anchors)
  and `forcePublishedStatus` (after the bypass: pins `status=published` and
  drops `publicationFilter`, `hasPublishedVersion` and the v4
  `publicationState`, so a reader can neither fetch drafts nor learn which
  published entries have pending edits).
- `policy-factories.ts` builds the policies from those steps:
  `ownRowsFilter` (acknowledgements, notifications, lesson progress,
  RSVPs), `visibleIdsPolicy` (ids resolved server-side: announcements,
  documents, quick links, wiki, polls, lessons) and `ownerGate`
  (write/delete only by the row's owner: classifieds, comments, RSVPs,
  notifications, reactions), plus `findByRef`, the id lookup the ownership
  gates and several controllers share.
- `visible-ids.ts` (`loadUserScope`, read once per request and user;
  `visibleWikiSpaceIds`), `target-visibility.ts` (`visibleTargetAnchors`,
  `isTargetVisible`) and `wiki-edit-context.ts` (carries the authenticated
  editor, the edit note and a restore's source revision from the wiki-page
  write paths into the revision lifecycle; a save in the Strapi admin
  records the admin user from the request's admin strategy instead, never
  from the payload).

### Request ids

Every custom handler and policy that looks an entry up by an id from the
request (a route `:id`, or ids in a request body) checks it first with
`apps/cms/src/utils/entry-id.ts`: a positive row id within the int4 range,
or a documentId in the shape Strapi generates (the FX07 write policies keep
their own, wider documentId rule). Anything else answers like an unknown
entry (404, or `false` in an ownership policy) or, for a body, 400, where
Postgres used to fail the lookup with a 500. The web's ICS route applies the
same check (`apps/web/src/lib/entry-id.ts`; both re-export it from
`@sinnlos/domain`).

## Global guards

None of these is attached per route: the relation guard, the query-key
allowlist and the contact-field sanitizer hook into Strapi's content-API
query and output handling, and the other three are global middlewares
(`config/middlewares.ts`) that see every request:

- **Relation guard** (`registerRestrictedRelationGuard` in
  `apps/cms/src/bootstrap/restricted-relation-guard.ts`, rules in
  `utils/restricted-relations.ts`): a relation into a visibility-filtered
  type is only followed from that type's own filter domain. It protects
  wiki pages (`department.pages`, `team.pages` and any chain that reaches
  them, e.g. `/api/users?populate[department]…`), polls and, since batch
  15.2, comments (`comment.parent`/`replies`: comment-target-visibility
  decides per target, and nothing keeps a parent on its reply's target) —
  the last two with no trusted source at all: such relations are dropped
  from `populate`, rejected with a 400 in `filters`/`sort`, and deleted
  from responses. `admin_role` and `editor` bypass it, except for the
  closed targets (`CLOSED_RELATION_TARGETS`, batch 15.1): wiki revisions
  are cut the same way for every caller. It wraps
  `strapi.contentAPI.sanitize.query`, so it covers core, users-permissions
  and upload routes, reads and writes; the boot fails if that hook point
  or `strapi.auth.verify` disappears after a Strapi upgrade.
- **Relations in populate filters and sort** (batch 15.2, same guard):
  Strapi 5.57 refuses a root filter or sort through a relation whose
  target the caller holds no `find` on (400 `Invalid key`), but never asks
  for the `filters` and `sort` nested in a populate (`validatePopulate`
  passes no auth; `sanitizePopulate` skips those keys). The guard applies
  the root rule there: every relation a populate's `filters` or `sort`
  follow, at any populate depth, through `$and`/`$or`/`$not` and in every
  sort shape, needs the caller's `<target>.find`, asked as the core asks it
  (`strapi.auth.verify` with the request's `auth`, i.e. the caller's
  users-permissions role; anonymous callers have the `public` role). Else
  the answer is the core's own 400, `Invalid key <relation> at <path>`,
  whatever the value. No bypass: `admin_role` and `editor` are held to
  their own grants. In practice guest cannot select or sort through
  `department` or `team`, no role but `admin_role` through
  `users-permissions.role` (`author.role`, `space.allowedRoles`,
  `manager.role`), and nobody through `role.permissions`. Relations only,
  as at the root: media, components and scalars are not grant-checked.
  **A populate's `sort` follows no relation and no media at all** (batch
  16): Strapi 5.57 builds such a populate query with a broken alias and
  answered 500 with an SQL error even for a caller holding the grant, so
  the guard refuses every one with the same 400, for every caller;
  scalar sorts inside a populate and root sorts are unchanged. The web
  sends no populate filter or sort.
- **Root query-key allowlist** (`utils/rest-query-params.ts`, same wrapper,
  every role): keys outside Strapi's REST parameters (`where`, `orderBy`,
  `select`, `groupBy`, `offset`, …) are dropped before any service sees
  them.
- **Contact-field sanitizer** (`registerUserContactSanitizer`,
  `utils/sanitize-user-contact.ts`, #10): removes `email`, `phone`,
  `hireDate`, `officeLocation` and `microsoftOid` from every response to
  callers outside the staff roles (`guest`, `authenticated`, unknown
  roles), on `/api/users` reads and on every populated user relation.
- **`global::sensitive-query-guard`** (FX22): the query side of the same
  rule: for those callers a filter, sort, nested populate filter or sort,
  or users `_q` on one of these fields answers 400 `Invalid key`, on
  `/api/users*` and through every user relation. Each refusal is logged as
  `[sensitive-query-guard] 400 …`.
- **`global::uploads-auth`**: the bytes under `/uploads/*` only for requests
  carrying `INTERNAL_UPLOAD_TOKEN` (the web's session-gated proxy);
  everything else gets 404, whatever the encoding of the path (`..`,
  `%2e%2e`, `%2f`, any case). Without the token configured it answers 404
  in production and is off in development. The web proxy also asks Strapi
  whether the session's JWT is still accepted, with a cache of up to 60
  seconds, so a blocked account loses the files within a minute.
  It must stay a global middleware (`config/middlewares.ts`); the edge
  routes `/uploads` to the web, not to the cms.
- **`global::auth-path-guard`**: any spelling of `/api/auth/*` other than
  the literal lower-case one (`/api/Auth/local`, `%61uth`, `//`, `..`)
  answers 404, so no variant reaches Strapi's local login past the web's
  login rate limiter.

`apps/cms/src/middlewares/sensitive-query-guard.test.ts` reads
`config/middlewares.ts` and fails when the list loses one of the three
global middlewares.

### Document Service guards

Since batch 15 a second layer sits under every writer, not only the
content API: Document Service middlewares, registered in one place and in
one order (`apps/cms/src/bootstrap/document-middlewares.ts`). The content
API, the admin panel's Content Manager, the scheduler and the boot
writers all pass them, and the cms refuses to boot when
`strapi.documents.use` is gone.

- **Offset-less instants** (DT-OFFSETLESS,
  `utils/offsetless-datetime-guard.ts`, first): a datetime attribute sent
  as a string without `Z` or a numeric offset answers 400 `ValidationError`
  with `details.keys`, before any transaction. Strapi would read such a
  value in the process zone (UTC). Date objects, numbers and null pass;
  `date` attributes are not instants.
- **The document lock** (`utils/document-lock.ts`, second): every create,
  update, clone, delete, publish, unpublish and discard of a guarded type
  (the seven scheduled types, poll, wiki space, department, team) runs in a
  transaction that locks the document's revision row and advances the
  revision afterwards, whoever writes. Inside the authoring scope the web
  routes open (batch 15 lane 15A: `If-Match`), the lock accepts only the
  current revision, and re-checks the caller's class on a mismatch: a
  caller who lost it gets 403 or 404 and never learns the new revision; one
  who kept it gets 412 with the current revision. Raw writes of guarded
  rows are inventoried by `raw-writers.test.ts`: each takes the lock and
  advances the revision, or only raises a targeting flag.
- **The wiki checks** (`utils/wiki-checks.ts`, batch 16): every mutating
  wiki-page and wiki-space action takes ONE structure lock (a reserved
  revision row), whoever writes (a space publish re-creates its published
  row from the page links it read first: no page write runs in between). A write that adds a parent link closing a loop is refused
  (`parentCycle`) and rolled back; only added links are judged, so a loop
  that already exists blocks no other save and can be repaired. A space
  that any page links can be neither deleted nor unpublished
  (`spaceNotEmpty`): the admin panel's unpublish used to drop its pages'
  space links; a discard of a space's draft is refused when it would take
  an unpublished page out of the space (Strapi re-links only pages with a
  published version). `infra/diagnostics/wiki-parent-cycles.sql` lists loops,
  cross-space parents and pages without a space, read-only. The page slug
  `new` and the space slug `drafts` are refused for every writer (the
  web's routes use them as words). A page write whose `revisions` would
  change a link is refused (`details.keys: ["revisions"]`, batch 16.1),
  and a clone gets no revisions (Strapi would copy the source's, moving
  them): only the lifecycle links revisions.
- **Publish readiness** (`utils/publish-readiness.ts`): a publish of a
  scheduled type needs the fields the published validation requires, and
  a lesson's course and a wiki page's parent must be published; a publish
  that would drop that link anyway is refused and rolled back. This binds
  the admin panel and the scheduler too.
- **The media claims** (`utils/media-claims.ts`, lane 16A, registered in
  batch 16, extended in batch 17): `document.file`, `course.coverImage`,
  `department.headerImage` and `team.avatar` lock each file their payload names
  or the action copies (`FOR UPDATE`, ascending ids, after the document's
  own revision row and the other locks), refuses one that is gone or
  being removed, and re-checks a newly linked stamped file under that lock
  (linked by nothing but this document, the caller's own, an allowed
  mime); two saves that attach one fresh upload serialise and the second
  answers `invalid`. A stamped file that no row of the document links
  after the action (a replace, a publish of a replaced draft, a discard, a
  delete; web, panel or scheduler) is removed after the commit through
  `claimAndRemove`. Admin-panel uploads (unstamped) are never claimed nor
  removed. A unit pin keeps every media field the allowlist accepts tied
  to this registration.
- **The audit trail** (`utils/audit.ts`, last of the content middlewares):
  one `audit_events` row per change of a guarded document, written in the
  change's transaction (a failing insert rolls the change back): the
  action, the document, the revision, who (user, admin user or system) and
  from where (content API, admin panel, scheduler, boot), the role class
  the gate admitted, and the changed attribute names, never values. The
  rows are append-only: a lifecycle refuses every create, change and delete
  except the recorder's creates and the retention janitor's deletes
  (`AUDIT_RETENTION_DAYS`, default 365). The admin panel can read them, not
  change them; a database superuser still can (an application trail, not
  tamper-evident storage). Not covered: user and role changes, refused
  attempts, raw writes other than the scheduler's.
- **The activity read** (batch 17): `GET /api/audit-events` accepts only
  `page`, `targetUid`, `actorKind`, `actorId`, `actorClass`, `from` and `to`.
  Pages contain at most 25 rows; filters apply before count/page and order
  is `createdAt DESC, id DESC`. Dates require offsets and inclusive ordered
  bounds; actor ids require the user/admin namespace. Only fixed event
  fields and actor labels are returned, with deleted-actor fallbacks and
  `private, no-store`; no populated user/admin objects or generic query surface.

## Content types and their access rules

The [README content model](../README.md#content-model) lists the types;
this is who sees and changes what, per type.

| Type              | Access rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `department`      | Readable by every role except `guest`; one stable row without draft & publish. Admin edits description/color/headerImage; the head of current user.department edits description/color. No editor bypass, structural API writes or create/delete routes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `team`            | Like `department`; admin edits description/avatar, a permitted lead or the head of its department edits description. Structure remains panel-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `announcement`    | Visible to its audience only: `department`, `team` (member or lead) and `audienceRoles`, AND-combined over the criteria that are set; none set = everyone. Fails closed: `audience` = `departments` without a department or team, or `retargetRequired` (a targeted department or team was deleted), is admins' and editors' only and notifies nobody ([below](#announcement-and-event-targeting)). Gone for others from `expiresAt`.                                                                                                                                                                                                                                                                                                                                             |
| `acknowledgement` | One per user, anchored to the announcement's `targetDocumentId` (stable across re-publishes), immutable once created (since v0.28 the core update and delete routes are gone; corrections in the Strapi admin). Deleted once the confirmed document is gone in every state, and on anonymisation; no age rule. Only the announcement's audience can acknowledge it, and only until it expires (admins and editors excepted); anyone else gets the same 400 as for a missing announcement.                                                                                                                                                                                                                                                                                         |
| `comment`         | Anchored by `targetType` + `targetDocumentId` (no foreign key). Reads and creates are filtered to targets the caller may see; an unpublished announcement's thread answers like a missing target until it is published again. Delete by the author or a moderator. `parent`/`replies` are not followed below the moderators (batch 15.2).                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `reaction`        | The same anchor and target visibility as comments. `create` toggles; with the boolean `reacted` it sets that end state instead (a repeated request changes nothing). Two simultaneous creates can both store a row; each keeps the oldest copy and deletes the others right after its insert, and removing deletes every copy. Delete takes the documentId or the numeric id.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `kudos`           | `from` is always the sender; `to` must be another user. Readable by the staff roles and `authenticated`; the celebrations feed by the staff roles only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `notification`    | Written by the cms itself (`utils/notify.ts`; the content API has no create or update), read by the recipient only (`admin_role` included since v0.28) and deleted by the recipient, except anchored rows (announcement, event, training reminder), which the API refuses to delete. Publishing an announcement or event notifies its targeted users whose role holds the type's read grant (read from the permissions table at runtime) and who are not blocked, after the publish is saved; admins and editors get strictly the targeted audience. Mark-read takes up to 200 ids and only ever changes the caller's own unread rows.                                                                                                                                            |
| `event`           | Not visibility-scoped: every role with `event.find`, `guest` included, sees all published events. `departments` decide who is notified, not who can read; `notifyAudience` = `departments` without a department notifies nobody ([below](#announcement-and-event-targeting)). ICS export at `/api/events/:documentId/ics` (the numeric id of the published row also works, anything else is a 404).                                                                                                                                                                                                                                                                                                                                                                               |
| `event-rsvp`      | One answer per user and event (`create` is an upsert; the capacity gate counts each user's newest answer). Raw reads return only the caller's own rows (admin: all). Everyone else's answers come from `GET /api/event-rsvps/summary?targets=<documentIds>` (at most 50 published events): the yes/maybe/no counts, the names of the "yes" answers and the caller's own answer; who answered maybe or no never leaves the cms.                                                                                                                                                                                                                                                                                                                                                    |
| `poll`            | See [poll department targeting](#poll-department-targeting) and [guest access](#poll-guest-access). The author is set to the caller on `POST /api/polls`; 2 to 10 different, non-empty options, checked for every writer including the admin panel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `poll-vote`       | No generic routes. `POST /api/polls/:id/vote` and `GET /api/polls/:id/results` take the poll's documentId or its published row id. A vote cannot be changed; the results count each voter's first ballot only, and a vote removes the voter's later rows right after it is stored. The card sends the answer text it showed, and the cms refuses a vote whose option moved ("Poll options changed").                                                                                                                                                                                                                                                                                                                                                                              |
| `document`        | No departments = company-wide; with departments, only their members. `audience` = `departments` (set on every row that links a department, by each write and a boot backfill) keeps a document moderator-only once its departments are gone, until it is re-targeted or set back to `all`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `classified`      | Staff roles post; the author edits (admin bypass) and deletes (moderator bypass). Photos only through the [hardened upload](#upload-hardening), and only images the caller uploaded (moderators excepted). Expired ads leave the list at once and are deleted with their photos 90 days after `expiresAt` (03:45 cron).                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `quick-link`      | Like `document`. No editing UI in the web; maintained in the Strapi admin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `course`          | Published learner reads; admin/editor authoring through `can-author`, explicit status and revision checks. No content-API delete; nondeleting discard. Cover images use registered media claims.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `lesson`          | Generic reads omit the private quiz, including nested reads. Player/check require a published lesson and parent for every granted role and reject all query parameters. Player selects question/options only; check accepts bounded indexed answers, writes no receipt and returns no per-question verdicts for exam, including completed review. Author editable and the panel retain the answer key; admin/editor authoring uses the same revision and publication-readiness guards as courses. Video URLs remain lifecycle-validated and render-gated.                                                                                                                                                                                                                         |
| `lesson-progress` | Own rows only (admin: the `/manage/training/report` report), anchored on lesson documentId; no update/delete. Since v0.28 a completion must send back the player's `version` (the published course's and lesson's `publishedAt`; otherwise 409 `changed`), and the receipt stores a `snapshot` (schema-`private`, read only through the report and the admin evidence route) of what was completed; retention: `TRAINING_EVIDENCE_RETENTION_YEARS` ([data-protection.md](data-protection.md#4-schulungsnachweise)). Completion independently validates the current published quiz and answers; malformed quiz content fails with `quizContentInvalid`. Existing receipts survive quiz edits. No attempt limit: answers can be guessed. Course completion is derived at read time. |
| `search-log`      | Anonymous by design (term and result count, no user relation), write-only content API; aggregated, admin-only `/api/search-logs/summary`; `SEARCH_LOG_RETENTION_DAYS` retention (default 90, 03:35 cron). A term can still name a person. With `search-logging` in `FEATURES_OFF` the create answers 204 without storing and the summary 404.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `wiki-space`      | `visibility`: public, role (`allowedRoles`), department or team. Moderators write.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `wiki-page`       | Inherits its space's visibility. Written as described under `can-edit-wiki` and the write allowlist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `wiki-revision`   | No route and no grant for any role, and closed as a relation for every caller (batch 15.1): it can hold unpublished draft text. Since batch 16 one published row per revision, anchored by `pageDocumentId`, written in the save's transaction after every content change of a page's draft (web editor or panel admin); the boot and `deploy.sh` refuse revision drafts. Read only through the history actions. Hidden in the admin panel.                                                                                                                                                                                                                                                                                                                                       |
| _profile_         | `GET`/`PUT /api/me`, the caller's own record. The output is an allowlist (no password hash or tokens; the manager is a summary). `PUT` takes only the whitelisted fields, trims them, answers 400 above 255 characters and accepts `locale` `en` or `de` only. For a user bound to Entra, display name, job title, phone and office location belong to Entra: `PUT` ignores them and both answers list them in `entraManagedFields`. Guests see no digest options, and `PUT` ignores theirs.                                                                                                                                                                                                                                                                                      |
| _entra-auth_      | `POST /api/auth/entra/exchange`, server to server only ([above](#microsoft-entra-id)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Announcement and event targeting

Batch 15 makes department targeting fail closed (decision 06 §B6, §N9).
Enforced by the cms for every reader and every notification:

- **Announcements** are read through one rule,
  `packages/domain/src/audience.ts` (`isAnnouncementTargetedTo`), which the
  read policy, the bell and digest fan-outs, the comment and reaction
  target checks, the acknowledgement controller and the web acknowledgement
  report all ask. Besides the AND-combined criteria, two states target
  nobody, whatever else is set:
  - **D-PT01:** `audience` is `departments` but neither a department nor a
    team is linked (a legacy row, an unlink in the admin panel, or a
    delete that removed the last target). Until batch 15 such a row was
    company-wide.
  - **`retargetRequired`:** a department or team the announcement targeted
    was deleted. Deleting one AND-combined criterion would widen the
    audience to what remains (a department-plus-team announcement would
    reach the team's members in other departments, or the whole
    department), so the department and team delete hooks set the marker
    first.

  Such an announcement is readable by admins and editors only (their read
  bypass), its thread answers like a missing target, nobody is notified
  of it or gets it in a digest, and the acknowledgement report counts no
  audience. It stays so until a moderator re-targets it.

- **Events** stay readable calendar-wide. `notifyAudience` is
  `departments` on every event row that links a department; such an event
  without a department left notifies nobody when it is published, instead
  of the whole company.
- **The flags only restrict.** The cms raises the announcement `audience`
  and the event `notifyAudience` on every row that links a target, in the
  same transaction as each write (admin panel, content API, scheduler;
  `apps/cms/src/utils/targeting-flags.ts`), and a boot backfill raises them
  on rows written before. Before a department or team delete cascades its
  links away, the delete sets the flags and the marker on the rows that
  linked it and advances the revision of every announcement, event and
  document that linked it, so a form opened before the delete gets a
  conflict or "not found" instead of writing over it (a delete outside a
  transaction, which only a script can make, is refused). Every reader
  reads the flag and the marker once more after the targeting relations
  and keeps the raised value, so a delete between those statements never
  pairs the old marker with the new links; a row that second read no
  longer finds (unpublished, republished or deleted in between) counts as
  restricted. Nothing lowers a
  flag or the marker except an explicit re-target: in the admin panel, set
  Audience (or Notify audience) to `all` or clear Retarget required; a
  save that still links a target is flipped back to `departments`.
- **Residual:** an admin-panel form opened before a department or team
  delete still holds the old marker value (false) and saves it back; the
  admin panel is not revision-checked. The audit trail shows the save.

### Poll department targeting

Enforced by the cms, not only in the UI:

| Caller                                              | Poll without departments                                      | Poll whose departments include the caller's | Poll of other departments               |
| --------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------- | --------------------------------------- |
| member, team lead, department head, `authenticated` | see, vote, results                                            | see, vote, results                          | not found (list, detail, vote, results) |
| guest                                               | as the poll's guest access says (below); by default not found | the same                                    | not found                               |
| admin, editor                                       | see, vote, results                                            | see, vote, results                          | see and results; voting refused         |

- "The caller's department" is the `department` of their user record. Role
  never adds membership; a user without a department sees company-wide
  polls only. A department change applies on the next request; votes
  already cast stay counted.
- A poll is restricted when its **Audience** field (`all` | `departments`)
  is `departments` **or** it has departments. Only the flag keeps a poll
  restricted after all its departments are deleted (then only admins and
  editors see it, and the card asks to re-select departments), so the cms
  sets it itself: every save of a poll that leaves departments selected
  (admin panel, content API and web form alike, draft and published row,
  in the same transaction) sets Audience = `departments`
  (`apps/cms/src/utils/poll-audience-guard.ts`), and deleting a department
  sets it on every poll that still has the department. To open a
  restricted poll to everyone, remove its departments **and** set Audience
  to `all` (in the web, an explicit departments change; the content API
  derives Audience from it and refuses a client `audience` since batch 15).
- **Options and anonymity freeze at the first vote** (batch 15). A vote
  stores an option index and may be anonymous, so once a poll has a vote,
  no writer (web, content API, admin panel) can publish other options or
  another anonymity: the poll guard compares what a publish, a Save and
  publish or a draft save that carries them would write with the
  currently **published** row (votes are cast on it) and refuses with
  `frozenAfterVotes`. It runs under the poll's document lock, which the
  vote handler takes before it reads, checks and inserts, so a vote and an
  options change sent at the same moment cannot both succeed. That row is
  the only baseline, so a voted poll keeps it: an unpublish of a poll with
  a vote is refused (an unpublish deletes the published row and with it
  the ballots' links, and a republish would compare with nothing), and a
  poll with linked votes but no published row can no longer be published
  (Codex review of 15A, finding 1). A poll unpublished before batch 15 has
  no such votes: that unpublish deleted its vote links, so it counts as
  unvoted and its orphaned ballots count nowhere (DEPLOYMENT.md
  "Deploying batch 15", step 6).
- Where it is enforced: the `poll-visibility` read policy (list and
  detail), the custom `vote`/`results` actions and the batched
  `GET /api/poll-results`, all through `apps/cms/src/utils/poll-audience.ts`.
  Departments are compared by documentId. `results` also tells the web
  whether the caller may vote (`canVote`) and which departments a poll
  targets.

### Poll guest access

Polls are **hidden from guests** (role type exactly `guest`) unless an
admin or editor opens them, per poll, with two fields (owner decision
2026-09-27):

| Visible to guests | Guests can vote | A guest in the poll's audience                                                                                                          |
| ----------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| off (default)     | any             | not found: not listed, not in search, 404 on results and vote                                                                           |
| on                | off             | sees the poll and its results; a vote answers 403 "Guests cannot vote on this poll" and the card says "Guests can't vote on this poll." |
| on                | on              | sees, votes, results                                                                                                                    |

- The department rule still applies: a guest never gets a poll of another
  department. "Guests can vote" without "Visible to guests" does nothing.
  NULL (a poll from before the fields) counts as off. Both fields apply once
  the poll is published.
- `canSeePoll` and `canVoteOnPoll` in `apps/cms/src/utils/poll-audience.ts`
  decide for the list/detail policy and the vote/results actions alike.
- No other path hands a poll to a guest: notifications, live pings, e-mail
  digests, comments and reactions never concern polls, the search goes
  through the filtered `/api/polls`, and relations into polls are cut by
  the relation guard (`apps/cms/src/poll-exposure.test.ts` fails when a new
  module starts reading polls).
- A cms from before guest access ignores both fields and never removes the
  guest vote grant, so a rollback to one removes it first
  (`infra/rollback/revoke-guest-poll-vote.sql`;
  [Upgrading to poll department targeting](./DEPLOYMENT.md#upgrading-to-poll-department-targeting),
  Rollback).

### Private user fields

The users-permissions **User** is extended with fields that are
schema-`private`: Strapi leaves them out of its content-API output. Only
`/api/me`, which reads the caller's own row directly, returns some of them,
to that caller (the birthday and the digest settings):

- `microsoftOid` and `entraTenantId`: the identity of a Microsoft user (an
  admin sets both, lower case, to bind an existing account once its owner
  is confirmed; `/api/me` reads `entraTenantId` to mark the Entra-owned
  profile fields); `oidcIssuer` and `oidcSubject`, the identity of an OIDC
  user (v0.25.0, bound the same way); `roleSource` (`entra` | `oidc` |
  `manual`), `entraAppliedRole` (the role the identity provider's sign-in
  last wrote, Entra or OIDC) and `entraManagerOid`, read by the exchanges. These and
  `digestFrequency` are also `searchable: false`, so no `_q` finds them.
- `tokenVersion`: private, `searchable: false` and hidden in the admin
  panel; no write can set it ([Token versions](#token-versions)).
- `birthday` / `birthdayVisible`: birthdays are strictly opt-in, maintained
  through `/api/me`, never exposed through user reads, and surface without
  the year of birth in the celebrations feed only when `birthdayVisible` is
  set.
- `digestAnnouncements`, `digestMentions`, `digestKudos`, `digestFrequency`
  and the cron-owned `lastDigestAt`. Digests go only to users whose role
  holds `announcement.find`, never to guests or blocked users (the kudos
  section also needs `kudos.find`); a digest lists only announcements the
  user may read.

`manager` (with its inverse `directReports`), `department` and `teams` are
regular relations. In responses about users, the contact fields `email`,
`phone`, `hireDate` and `officeLocation` reach the staff roles only
([Global guards](#global-guards)); `/api/me` returns the caller's own.

### Blocked and anonymised people

Since v0.28 ([data-protection.md](data-protection.md) describes the result in German):

- **Directory.** `/api/users` lists active people only (`blocked` false
  or NULL, for every role, `admin_role` included); `/api/users/:id` of a
  blocked or missing person answers 404. The directory relations
  (`manager`, `directReports`, department `head`/`members`, team
  `lead`/`members`) populate active people only, in every populate form
  and depth, counts included (the relation guard's query wrapper).
  `/api/me` drops a blocked manager. `/manage/users` still lists them.
- **Attribution.** Every other populated user (authors, organisers,
  `uploadedBy`, kudos `from`/`to`, notification actors) that is blocked
  is cut to `{ id, documentId, displayName, username, blocked }` for every
  caller, staff included (the contact-field sanitizer). Filters through a
  relation onto any other user field match active people only, and a root
  sort through a relation onto such a field answers 400.
- **Writes.** Kudos to a blocked person answer 400 `recipient`; comment
  and kudos notifications skip blocked recipients; a profile update and
  the Entra/OIDC profile, department and manager sync re-check `blocked`
  under the user's row lock and write nothing for a blocked person.
- **Anonymisation** (`POST /api/user-management/:id/anonymise`,
  `admin_role`, only for a blocked person, confirmed with the username):
  one transaction under the directory, caller and target locks. The row
  keeps its identity-provider ids, so an SSO sign-in finds the blocked row
  and is refused before any sync instead of provisioning a new account,
  and gets `anonymisedAt`. The user Document Service guard drops
  `anonymisedAt` from every write and refuses update, delete and clone of
  an anonymised row under its row lock (Content Manager and
  `PUT /api/users/:id` alike); user administration refuses it with
  `anonymised`. A nightly erasure sweep (03:20) repeats the row deletions
  (the ads too, through the Document Service; not the avatar) and the notification rewrite for every
  anonymised account.
- **Export** (`GET /api/user-management/:id/export`, `admin_role`):
  explicit projections, never a secret; `export-coverage.test.ts` fails on
  a relation to the user model that is neither exported nor listed as not
  included. Export and anonymisation write an audit row and run whatever
  `FEATURES_OFF` says.

### Module and feature switches

`FEATURES_OFF` (cms and web, the same value; parser in `@sinnlos/domain`
`features.ts`; an unknown value refuses the boot) switches modules and
features off. At `register()` every route of a module's APIs gets
`global::module-enabled` in front of its policies, and the feature routes
get `global::feature-enabled`; off answers 404 for every caller (after the
grant check).

- **Modules:** `events` (event, event-rsvp), `training` (course, lesson,
  lesson-progress), `marketplace` (classified), `kudos` (kudos except
  `/celebrations`), `celebrations`, `polls` (poll, poll-vote),
  `duty-plans`, `kpis`.
- **Features:** `read-confirmations` (ack create; the admin read bypass
  ends; authoring refuses `requiresAck: true`), `training-reports` (both
  report routes; the admin read bypass on lesson-progress ends),
  `search-logging` (the create stores nothing, the summary is gone).
- The scheduler, the fan-outs, the training reminders, the digest and the
  Meilisearch rebuild skip off modules. The user administration routes
  (export, anonymisation, training evidence) and the retention jobs are
  never switched.
- The Strapi admin panel is not covered: technical admins still see every
  type.

## Upload hardening

The only granted content-API upload route, `POST /api/upload` (marketplace
ad photos, since batch 16 document files, and since batch 17 course/org images), is wrapped by
`apps/cms/src/extensions/upload/strapi-server.ts` on top of the permission
grant, with the pure rules in `apps/cms/src/utils/upload-guard.ts`,
`upload-zip.ts` and `upload-ooxml.ts` (deep-dive decision 06 §E1, owner
amendment 2). The admin panel's media library uses the separate admin
routes: its uploads are bound only by `deniedTypes` (below).

- **Create-only:** the core action's `?id=` replace/update path answers 403
  (it would let any uploader overwrite arbitrary existing media).
- **Body allowlist:** the only accepted multipart text field is `fileInfo`.
  Anything else (`ref`/`refId`/`field`, which core would turn into a link
  on _any_ entry, someone else's ad, an avatar, a document, or `path`) is
  refused by key. `fileInfo` is checked against core's schema (a malformed
  one answers 400 `fileInfo`, not core's 500) and its `name` is dropped:
  core would prefer it over the canonical name.
- **Two profiles by role.** Moderators (admin_role, editor) and department
  heads may upload PDF, DOCX, XLSX and PPTX (20 MB, exactly one per
  request) and images; every other role JPEG, PNG and WebP only (5 MB, at
  most 4 per request). Images are capped at 5 MB for every role. The size
  is checked before any byte is read (`fs.stat` when the reported size is
  missing; never waved through). The table lives in `@sinnlos/domain`
  (`uploads.ts`), shared with the web's file input.
- **The format comes from the content**, read from the temp file through
  one handle (the head, a PDF's or zip's tail, the zip directory, every
  local header and data descriptor, and `[Content_Types].xml`; never the
  whole file):
  - images by magic bytes; no SVG (stored XSS), no GIF (decompression
    bombs);
  - a PDF by `%PDF-` at offset 0 **and no zip archive anywhere in the
    file**: the whole PDF is scanned in 64 KiB reads for an end record whose
    central directory stands where it says (also behind padding, which some
    zip readers skip), so a PDF that is also a zip is refused;
  - DOCX, XLSX and PPTX by the **Office Open XML rule**: a zip in exactly
    one layout (no prefix, no gap, no trailing data, one end record at the
    end, every local header equal to its directory record, methods 0 and
    8, strict ASCII names, no duplicates under case folding, no Info-ZIP
    Unicode Path field that would give some readers another name; ZIP64,
    multi-disk and encrypted entries refused; at most 5 000 entries and
    1 MiB of directory), `[Content_Types].xml` read by a bounded tokenizer
    for a fixed XML subset (no DTD, so no entity is ever expanded; no
    comments, PIs, CDATA, text or prefixes; references decoded before any
    comparison; at most 64 KiB compressed, 256 KiB inflated, CRC-checked),
    exactly one main part of the table in its folder, and no macro-enabled
    content type, VBA part or Excel 4.0 macro sheet. Every macro-enabled,
    template, slideshow and binary variant is refused, renamed or not.
- **What the sniff proves, and what not.** Proven: the container format;
  for Office files one zip layout every reader sees alike and the main
  part's type; that `[Content_Types].xml` declares none of the macro
  carriers the rule knows; that no entry carries a conventional VBA part
  name or lies under `xl/macrosheets/`. Not proven: that the file is valid;
  that Office finds no code in a part declared under another type; that
  the other entries decompress to a safe size (the limits protect the
  scanner, not the reader's machine); that the file is free of other active
  content (PDF JavaScript, embedded OLE objects, ActiveX, external
  relationships, DDE fields). An image that is also a zip is stored as the
  image. Files are served as downloads behind the session gate with
  `X-Content-Type-Options: nosniff`.
- **Canonical name and mime:** the stored name becomes `<stem><extension of
the sniffed format>` and the mime the table's (core stores and serves by
  extension, so a JPEG named `x.pdf` was served as `application/pdf`). A
  stem core cannot turn into a slug becomes `image` or `document`.
- **Refusals** answer 400 `ValidationError` with `details.keys` and
  `details.codes.file` (`fileType`, `fileTooLarge`, `required`, `invalid`);
  core's own type, image and size refusals are mapped the same way.
- **Uploader attribution:** every stored file is stamped with the caller's
  user id in `provider_metadata.uploadedBy`, also the files already stored
  when a later file of the same request fails. The classified controller
  only accepts image ids whose `uploadedBy` matches the caller (admin and
  editor bypass), and every write of an ad, from any source (the Content
  Manager too), locks its image rows and refuses one that is being removed
  (the classified lifecycle); the media
  claims cover document files and course/org images. New content-API
  attachments must be the caller's own upload, of the field's allowed mime,
  linked by nothing else, checked under the file row's lock. Every writer,
  including the panel, refuses a tombstoned file on those registered fields;
  no publish, clone or discard copies one that is being removed.
- **Removal:** every delete, the app's and the Media Library's, first
  takes one reservation (`reserveRemoval`, `utils/upload-orphans.ts`): it
  locks the file row, re-reads it (a file that is gone or already being
  removed is skipped, so overlapping deletes remove and record it once),
  and commits a tombstone with the audit row before the bytes go; the
  document, course/org and classified writes refuse a tombstoned file, and the janitor
  retries an unlinked tombstoned row after 10 minutes. The app's removers
  (`claimAndRemove`) add their rules under the lock: stamped, linked by
  nothing, old enough; and they delete the bytes and the row under the
  lock again, only while nothing links the file (`removeReserved`): a
  user avatar or another unregistered media field can still be linked by
  an admin-panel picker without checking the tombstone, so a link made in
  between keeps the file (a warning, `[uploads] kept file <id>: …`). Known
  limit: after a removal that failed between bytes and row, those
  unregistered fields can still link it. Since batch 17 department header
  images, team avatars and course covers no longer have this exception.
  `cleanupUploads` removes only the
  caller's own files; the nightly uploads janitor (03:30) only stamped files
  older than 24 hours, now including moderators' and department heads'
  unattached document uploads. Admin-panel uploads carry no stamp and are
  never removed by the app.
- **The delete trail:** every ad delete (the author, a moderator's
  takedown, the Content Manager, the classified janitor) and every file
  delete (the image cleanup, `cleanupUploads`, the uploads janitor, the
  media claims, the admin Media Library's single, bulk and folder deletes)
  writes one append-only `audit_events` row (`utils/delete-audit.ts`): the
  actor (user id, admin id, or system) with batch 15's class (`author` for
  one's own ad or upload, `moderator` for someone else's, or the v2
  authoring class; none for admins and janitors), the source
  (`content-api`, `admin`, `cron`), and in `detail` a user's role type, the
  ad's title or the file's id, mime, size, related document and name. No IP
  address, no token, no request data. The insert is never caught: a
  failing insert fails the delete. For a file the row records the removal
  decision: it commits with the reservation, right before the bytes go; a
  failed byte removal is retried by the janitor, not recorded again.
- **Admin-panel backstop:** `security.deniedTypes` (`config/plugins.ts`)
  adds `application/vnd.ms-{word,excel,powerpoint}.*macroenabled*`. Strapi
  matches them against the declared type, the extension's type and
  file-type's guess from the first 4100 bytes, so the panel refuses
  macro-enabled Office files by extension and, renamed, when file-type
  recognises them. A renamed `.xlsb` or `.xlam`, or a renamed macro file
  whose `[Content_Types].xml` lies beyond those 4100 bytes, passes the
  panel: the known limit (the content API does not depend on the backstop).
- **Upgrade tripwire:** the wrapper depends on Strapi internals (the
  controller and service factories, the `upload` dispatch, `remove(file)`);
  if an upgrade changes them, the cms fails at boot instead of silently
  serving an unhardened endpoint or deleting unrecorded.

The grant itself (`plugin::upload.content-api.upload`) goes to the staff
roles only, never `guest` or `authenticated`, and there are deliberately no
`find`/`findOne`/`destroy` grants on the upload content API (no browsing or
deleting the media library from outside the admin panel). In production
the uploaded bytes are served only through the web's session-gated
`/uploads` proxy (`global::uploads-auth`, [Global guards](#global-guards)).
In development without `INTERNAL_UPLOAD_TOKEN` the cms serves them
directly.

## Frontend role gating

The frontend has no roles of its own. It reads the viewer's role per
request with `getViewer()` (`apps/web/src/lib/viewer.ts`, `GET /api/me`) and
gates the UI with the fail-closed allowlist helpers in
`apps/web/src/lib/roles.ts`: `null`, unknown or differently-cased roles
never pass, and exclusion checks such as `role !== "guest"` are not
allowed. Every helper and role set is pinned to the cms grants by
`apps/web/src/lib/roles-matrix-parity.test.ts`: a grant change in
`permission-matrix.ts` that the web does not mirror fails CI.

| Helper                 | Roles                                   | Used for                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isAdmin`              | `admin_role`                            | `/manage/analytics` (redirects non-admins to `/`), and the reports and Strapi admin links on the `/manage` landing                                                                                                                                                                                                                            |
| `capabilitiesFor`      | per role (decision 06 §L2)              | `manage` (the _Manage_ nav entry and the `/manage` shell: `admin_role`, `editor` and, since batch 15, `department_head`), `author` and `authorScope` per area (the `/manage` tiles, lists, forms and buttons; `ownDepartment` for a department head), `reports` (the acknowledgement and training reports), and the wiki and org capabilities |
| `canCreatePolls`       | `admin_role`, `editor`                  | the _New poll_ button on `/polls` (`/polls/new` redirects to `/manage/polls/new`, which needs the `create` verb of `author.polls`); the "Visible to guests" / "Guests can vote" notes on poll cards                                                                                                                                           |
| `canRsvp`              | the five staff roles + `authenticated`  | RSVP controls and the RSVP summary fetch on `/events` (the same roles hold the `summary` grant)                                                                                                                                                                                                                                               |
| `canPostAds`           | the five staff roles                    | _New ad_ button, `/marketplace/new`                                                                                                                                                                                                                                                                                                           |
| `canEditAnyAd`         | `admin_role`                            | editing someone else's ad (the _Edit_ link and `/marketplace/[id]/edit`)                                                                                                                                                                                                                                                                      |
| `canDeleteAnyAd`       | `admin_role`, `editor`                  | the _Moderation_ card with _Delete ad_ on someone else's ad                                                                                                                                                                                                                                                                                   |
| `canComment`           | the five staff roles + `authenticated`  | the comment form                                                                                                                                                                                                                                                                                                                              |
| `canReact`             | the five staff roles + `authenticated`  | the reaction bar                                                                                                                                                                                                                                                                                                                              |
| `canDeleteOwnComments` | the five staff roles                    | the delete button on one's own comments                                                                                                                                                                                                                                                                                                       |
| `canTrain`             | the five staff roles + `authenticated`  | no caller yet (pinned by the parity test); the training report counts the same set (`TRAINING_ROLES`), and the training pages gate with `isReadDenied(role, "training")`                                                                                                                                                                      |
| `canReceiveDigests`    | the five staff roles + `authenticated`  | the digest options on `/profile` (the announcement readers)                                                                                                                                                                                                                                                                                   |
| `isReadDenied`         | a known role without the section's read | pages skip the request and show _Not available for your account_; the nav hides the entry (guest: announcements, departments, teams, kudos, marketplace, training; `authenticated`: the celebrations on `/kudos`)                                                                                                                             |
| `isGuest`              | `guest`                                 | wording only, never a gate: the poll card's "Guests can't vote on this poll." instead of the department hint                                                                                                                                                                                                                                  |

Poll voting has no role helper: the poll card renders what the cms answers
per poll in `GET /api/polls/:id/results` (`canVote`, the targeted
departments, the guest-access fields), so an admin or editor outside a
poll's departments, and a guest on a poll without guest voting, see its
results with the vote buttons disabled.

The ad detail page shows the _Edit_ link to the ad's owner and to
`admin_role`; the owner deletes on the edit page. On someone else's ad, a
moderator (`admin_role`, `editor`) gets a _Moderation_ card with _Delete
ad_; editors cannot edit other people's ads. A role that cannot read a
section sends no request for it: its pages show _Not available for your
account_, the dashboard leaves those sections out, the navigation hides
them, and the ⌘K search skips them. The admin area lives under
**`/manage`**: `/admin` is the Strapi admin panel, routed to the cms by the
reverse proxy.

## Tests that pin these rules

- `apps/cms/src/bootstrap/document-middlewares.test.ts`,
  `index.register.test.ts`: the Document Service middleware slots and their
  order; `framework-contract.test.ts` pins the Strapi behaviour they rely
  on (registration order is run order, a middleware's transaction is
  joined, create/update with status published publish without a publish
  pass, publish drops a link to an unpublished target).
- `apps/cms/src/raw-writers.test.ts`: every module that writes through the
  query layer, and the rule each raw writer of a guarded type satisfies.
- `apps/cms/src/integration/{datetime-guard,document-concurrency,scheduled-publish,audit,targeting-flags-backfill}.integration.test.ts`:
  the document layer on SQLite and Postgres 16, through the Content Manager
  as well.

- `infra/readme-permissions.test.ts`: the README permission tables against
  `PERMISSION_MATRIX`, `CUSTOM_ACTION_GRANTS`, the user reads and the set
  the boot sync converges to.
- `apps/cms/src/routes.matrix.test.ts`: every content-API route against its
  policies, the grants against the routes that exist, the write allowlist
  on every non-bypass write route, `REVOKED_PERMISSIONS` disjoint from the
  grants.
- `apps/cms/src/bootstrap.permissions.test.ts`: the real permission sync
  against the stub; the role|action set of a fresh database is a file
  snapshot (`src/__snapshots__/bootstrap.permissions.txt`), revocations,
  the one-transaction rollback and the unknown-action refusal.
  `prod-perm-diff.test.ts` builds `infra/diagnostics/prod-perm-diff.sql`
  from the same set. After a deliberate grant change rewrite both:
  `pnpm vitest run apps/cms/src/bootstrap.permissions.test.ts apps/cms/src/prod-perm-diff.test.ts -u`.
- `apps/cms/src/policies/policies.contract.test.ts`: every policy returns
  strict booleans, has a bypass table entry and follows the
  `request.query` rules.
- `apps/cms/src/framework-contract.test.ts`: the Strapi behaviour these
  rules rely on, against the installed packages. Run it before every
  `@strapi/*` upgrade; its version pin fails first on purpose.
- `apps/cms/src/middlewares/sensitive-query-guard.test.ts`: the global
  middleware list.
- `infra/sensitive-queries.test.ts`: the web's user and search query
  builders run through the cms's own sensitive-query walk for guest,
  `authenticated` and a role-less caller.
- `infra/contracts.test.ts`: what the cms and the web both state (the
  announcement audience and the acknowledgement report, lesson videos,
  comment anchors, schema enums, the search's contact-field roles).
- `apps/web/src/lib/roles-matrix-parity.test.ts`: the web role helpers
  against the cms grants.
- `apps/cms/src/poll-exposure.test.ts`: no module reads polls past the
  poll rules.
- `packages/domain/src/audience.test.ts`, `apps/cms/src/utils/targeting-flags.test.ts`
  and the department and team lifecycle suites: D-PT01, the re-target
  marker, the flags raised and never lowered, the delete hooks' revision
  advance in ascending order; `integration/targeting-fail-closed.integration.test.ts`
  runs them over HTTP on SQLite and Postgres, with the batch-14 discard
  case and the read-only diagnostics.
- `apps/cms/src/extensions/users-permissions/strapi-server.test.ts`: the
  token versions: the claim, the bump and the save in one transaction and
  its rollback, the admin-panel guard and the dropped `tokenVersion`;
  `apps/cms/src/utils/deploy-preflight.test.ts` covers the rollback hint's
  rotation step.
- `apps/cms/src/integration/authoring-wiki-revisions.integration.test.ts`
  and `authoring-wiki-revision-dp.integration.test.ts` (batch 16): the
  after-images and who they name (web editor, panel admin), atomicity with
  the save, no read path for any role, the boot guard against revision
  drafts on both engines, and the migration rehearsal with the real SQL on
  Postgres 16; `infra/deploy-flow.test.ts` and
  `apps/cms/src/utils/deploy-preflight.test.ts` the deploy refused while
  revision drafts exist.
- `apps/cms/src/integration/wiki-revisions-closed.integration.test.ts`:
  every caller, `admin_role` and `editor` included, on SQLite and
  Postgres 16: no `/api/wiki-revisions` route, no revision through any
  populate shape or root, every filter and sort through `revisions` (root,
  `$or`, deep, nested in a populate) refused or blind, the 18 batch-15
  rows revoked with the runbook's boot lines, and the admin panel's view.
- `apps/cms/src/integration/nested-relation-grants.integration.test.ts`
  (batch 15.2), on SQLite and Postgres 16: per role, every relation it may
  not `find`, in a populate's filters and sort in several shapes, answers
  400 whatever the value; nested filters through what the role reads
  answer as before; comment parent/replies and the other row-level
  targets; the web's four relation filters in their exact shapes.
  `utils/restricted-relations.test.ts` checks the rule against the
  permission matrix's own grants.
- `pnpm test:integration` (`apps/cms/src/integration/`): the real cms per
  role over HTTP: removed routes, `?status=draft` on every draft & publish
  type, relation side channels, contact-field filters, guest polls, RSVP
  privacy, publish cycles, the role read snapshot, token versions
  (including a password set through the Content Manager, on SQLite and
  Postgres) and the Entra provisioning.

Batch 17 web implementation (merged into main afcbd51, not a deployment claim): training author pages use the guarded editable/list/write endpoints; learner pages keep the answerless DTO. Org forms use one status-free save and preserve raw descriptions on unrelated changes. Detail markup uses escaped legacy text or the existing safe Markdown renderer. The admin activity page reads the bounded fixed DTO and escapes audit values; actor IDs remain scoped to user/admin namespaces. The combined review found no confirmed new findings; focused checks and exact-commit main CI passed (plan-batch-17.md section 16). Browser acceptance and rollback rehearsal remain pending.
