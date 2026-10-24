# Contributing

Thanks for your interest in sinnlos.

## Contributor License Agreement

sinnlos is licensed under the AGPL-3.0-only ([LICENSE](./LICENSE)). A commercial license will be offered next to it, so every contribution needs a signed Contributor License Agreement (CLA). The CLA text is not published yet. **Until it is, pull requests from outside contributors are not merged.** Issues, bug reports and ideas are welcome at any time.

To report a security vulnerability, do not open an issue; follow [SECURITY.md](./SECURITY.md).

## Development

Setup and the local stack: [Development setup](#development-setup) below. Before you open a pull request, run from the repository root (pnpm 10, through corepack):

```sh
pnpm typecheck          # the apps and the test sources
pnpm lint
pnpm format:check
pnpm test               # unit tests
pnpm test:integration   # Strapi in process, SQLite (and Postgres with SINNLOS_TEST_PG_URL)
```

CI runs the same checks plus the browser tests, the datetime matrix and both image builds. Commits are small and describe the why. Code follows the conventions in [docs/architecture.md](./docs/architecture.md) (§5, in [docs/architecture/](./docs/architecture/)).

## Development setup

### Prerequisites

- Node.js 22.13+ or 24 (`engines`: `^22.13.0 || ^24.0.0`; CI and the
  Docker images use 24; Node 20 is end of life)
- pnpm 10: `corepack enable` gives you the exact version the root
  `packageManager` names (pnpm 9 is refused)
- `openssl` (Git Bash or WSL on Windows) for generating secrets
- Docker with Compose v2, only for the full stack
- A Microsoft Entra ID tenant where you can register an app and grant admin
  consent, only for the optional Microsoft sign-in

### Local development (SQLite)

Runs the cms and the web directly with Node on a SQLite file. No database
server, no Docker, no Microsoft account.

1. Clone and install:

   ```bash
   git clone https://github.com/yurtbayemre/sinnlos.git
   cd sinnlos
   corepack enable
   pnpm install
   pnpm build:domain
   ```

   `corepack enable` writes the `pnpm` shim next to Node.js, so it needs
   write access there (an administrator shell for a Windows install under
   `Program Files`). pnpm 10 runs install scripts only for the dependencies
   listed in the root `pnpm.onlyBuiltDependencies` (better-sqlite3,
   esbuild, sharp). A
   `node_modules` that pnpm 9 created is removed and rebuilt on the first
   pnpm 10 install; answer yes (without a terminal: `CI=true pnpm install`).

2. Create the env files:

   ```bash
   cp apps/cms/.env.example apps/cms/.env
   cp apps/web/.env.example apps/web/.env.local
   ```

   The cms example already selects SQLite (`DATABASE_CLIENT=sqlite`, file
   `apps/cms/.tmp/data.db`). Fill in the secrets:

   - in `apps/cms/.env`, replace each `toBeModified` value (`APP_KEYS` takes
     two values, comma-separated), and in `apps/web/.env.local` the
     `AUTH_SECRET` value, each with its own `openssl rand -base64 32`;
   - set `REVALIDATE_SECRET` and `INTERNAL_UPLOAD_TOKEN`, each to one
     `openssl rand -hex 32` value used in **both** files: the first
     authenticates the live-update pings from the cms to the web, the
     second the web's `/uploads` proxy.

   In development the cms only warns about a placeholder and runs without
   the two shared secrets (no live pings, no `/uploads` gate). With
   `NODE_ENV=production` it refuses to start while a secret holds a
   placeholder, but it does not check that the two shared secrets are set:
   without them it starts, sends no live pings and answers every `/uploads`
   request with 404 (Docker Compose refuses to start without them).

3. Optional, for a first look: in `apps/cms/.env`, set `SEED_DEMO_DATA=1`
   for demo data, and `STRAPI_ADMIN_EMAIL` / `STRAPI_ADMIN_PASSWORD` for the
   first Strapi admin (8+ characters with an upper-case letter, a lower-case
   letter and a digit; without them you register the first admin at
   `/admin`).

4. Start both apps, each in its own terminal:

   ```bash
   pnpm cms:dev    # Strapi on http://localhost:1337
   pnpm web:dev    # Next.js on http://localhost:3000
   ```

   `pnpm dev` starts both in one terminal (output interleaved). The cms is
   ready when it logs `Strapi started successfully` (about half a minute);
   before that it logs `[entra] disabled` while Microsoft sign-in is off,
   and with the demo data `[seed-demo] done — 10 users, …`. Until the web
   is up it also logs `[live-emit] keepalive failed: fetch failed` once,
   and `[live-emit] keepalive reaches the web again` when it is.

5. Open http://localhost:3000. You are sent to `/sign-in`; sign in with
   e-mail and password (with the demo data:
   `alex.morgan@sinnlos.local` / `Demo-Passwort-2026!`, an `admin_role`,
   who enrolls an authenticator app at the first sign-in unless
   `MFA_REQUIRED_ROLES=none` is in `apps/cms/.env`; see
   [Standalone mode](#standalone-mode-no-microsoft)). The Strapi admin is
   at http://localhost:1337/admin.

Notes:

- **Strapi admin vs intranet users.** `/admin` accounts (`admin_users`) are
  separate from the intranet's users (Content Manager → User). Strapi's
  community edition has no SSO for `/admin`; Entra ID only signs users into
  the web.
- **Keep the dev cms off the network.** The example sets `HOST=0.0.0.0`,
  and `strapi develop` serves the admin through Vite's dev server, which has
  open advisories. On a shared network set `HOST=127.0.0.1` in
  `apps/cms/.env`
  ([details](#local-development-sqlite)).
- **Postgres locally:** set `DATABASE_CLIENT=postgres`, uncomment the
  Postgres block in `apps/cms/.env` with `DATABASE_HOST=localhost`, and add
  `TZ=UTC` (the cms must run in UTC on Postgres). A one-line Postgres
  container is in
  [Local development (SQLite)](#local-development-sqlite).
- **An older dev database** can still hold department or team drafts; the
  cms then refuses to boot with `[org-dp] … still holds N draft row(s)`.
  Delete `apps/cms/.tmp/data.db` and boot again (with `SEED_DEMO_DATA=1` if
  you want the demo data back). Because that check runs in `register()`,
  Strapi CLI commands such as `strapi ts:generate-types` and
  `strapi content-types:list` need the configured database as well.

### Standalone mode (no Microsoft)

Without `ENTRA_ENABLED=1` or `OIDC_ENABLED=1` (the default) both apps offer local e-mail and
password sign-in against Strapi; leftover `MS_*` or
`AUTH_MICROSOFT_ENTRA_ID_*` values are ignored. This is how the owner's
instance runs.

- **Accounts:** admins invite people at `/manage/users`; the invitation
  e-mail carries a set-password link that stays valid for 7 days (needs
  SMTP). The first admin, and anyone without e-mail, is created in the
  Strapi admin (**Content Manager → User**: e-mail, a password of at least
  12 characters, _confirmed_ on). There is no self-registration any more
  (v0.27). New local users get the `member` role; role, department,
  manager and blocking are managed at `/manage/users`.
- **Passwords:** at least 12 characters and not on a list of common
  passwords; existing shorter passwords keep working until they are
  changed. Users change their own on `/profile`, which signs that account
  out of every other browser and device (the tab that changed it stays
  signed in). A forgotten password: `/forgot-password` mails a reset link
  that stays valid for 1 hour, and an admin can send one from
  `/manage/users` (both need SMTP).
- **Second factor:** password sign-ins of the roles in
  `MFA_REQUIRED_ROLES` (default `admin_role`, `editor`) need an
  authenticator app (TOTP); everyone else can turn it on at `/profile`.
  Those users enroll at their next sign-in and get ten one-time recovery
  codes. An admin resets a lost second factor at `/manage/users`; a locked-out
  sole admin uses `infra/mfa-reset.sh <email>` on the host
  ([Local sign-in](./docs/security.md#local-sign-in)).
- **Demo data:** `SEED_DEMO_DATA=1` in `apps/cms/.env` seeds a database
  that has no department and no user yet (`apps/cms/src/seed-demo.ts`;
  later boots skip it). It writes **12 of the 24 collection types**:
  departments, teams, announcements, events, wiki spaces and pages, kudos,
  polls, poll votes, documents, comments and reactions, plus ten users
  (password `Demo-Passwort-2026!`): `alex.morgan@sinnlos.local` is `admin_role`;
  Sam Chen, Jordan Lee, Taylor Swift (`taylor.s@sinnlos.local`) and Riley
  Kim are `editor`; the other five are `member`. Publishing the seeded
  announcements and events, and the seeded kudos and comments, also writes
  their notifications. It seeds no acknowledgements, classifieds, quick
  links, RSVPs, courses, lessons, lesson progress, search logs or wiki
  revisions, and no `department_head`, `team_lead` or `guest` user.
- **`DEMO_MODE=1` (web only)** is a different thing: the web without a
  cms (DM01). `DEMO_MODE=1 pnpm web:dev` skips sign-in and answers from
  in-memory fixtures in `apps/web/src/lib/demo/`, signed in as the fixture
  user Ada Lovelace (a `member` of Engineering). List reads apply their
  filters, sort and paging; the member actions work and stay until the dev
  server restarts or the day changes (kudos, RSVPs, comments, reactions,
  votes, acknowledgements, notifications, the profile, lessons and quizzes,
  own ads without images). The admin area and uploads need a cms. A path
  without a fixture logs `[demo] no fixture for …`. A production server with
  `DEMO_MODE=1` answers every page with a 500
  ([details](./docs/archive/deployment-history.md#16-demo-mode-no-microsoft-account-needed)).

To offer local sign-in **next to** Microsoft or OIDC, set `AUTH_LOCAL_ENABLED=1` for
both apps as well as `ENTRA_ENABLED=1` or `OIDC_ENABLED=1`; the cms mirrors it into its own
e-mail provider switch.

### Full stack with Docker Compose

The same images as production (Postgres, cms, web) behind the bundled Caddy,
on one box:

```bash
cd infra
cp .env.example .env
# set DOMAIN, WEB_PUBLIC_URL and CMS_PUBLIC_URL, fill in every empty secret
docker compose up -d --build
```

`docker compose` refuses to start while a required secret is empty
([Environment reference](README.md#environment-reference)). For a local run set
`DOMAIN=http://localhost` (plain HTTP) and both URLs to `http://localhost`;
`DOMAIN=localhost` serves HTTPS from Caddy's internal CA, and a real host
name gets a Let's Encrypt certificate. Caddy sends `/api/*` (except
`/api/auth/*`), `/admin*`, `/upload*` and the other Strapi admin paths to
the cms and everything else to the web, including `/uploads/*`, which the
web serves through its session-gated proxy. The first build takes a few
minutes; then open the web URL and `/admin`. Step by step:
[Full stack with Docker Compose](#full-stack-with-docker-compose) (local)
and [INSTALL.md](./docs/INSTALL.md) (a server).

### Microsoft Entra ID sign-in (optional)

Microsoft sign-in is one codebase with the local sign-in: off unless
`ENTRA_ENABLED=1` is set for **both** apps, and every `MS_*` / `ENTRA_*`
value is ignored until then. Auth.js runs the OIDC code flow against one
tenant; the cms verifies the ID token itself, finds or creates the user by
tenant id + object id, applies the role of the user's **app role** to the
accounts Entra owns (an account that existed before, or whose role an admin
changed, keeps its role) and issues the intranet session (how it works:
[docs/security.md](./docs/security.md#microsoft-entra-id)). The full
runbook, with a staging dry run before roles are applied, is
[SSO.md, Microsoft Entra ID sign-in](./docs/SSO.md#microsoft-entra-id-sign-in).

**1. Set up the provider** in the
[Microsoft Entra admin center](https://entra.microsoft.com):

1. **App registrations → New registration**, _Accounts in this
   organizational directory only_ (single tenant). Note the **Directory
   (tenant) ID** and the **Application (client) ID** (both GUIDs; `common`,
   `organizations` and `consumers` are refused).
2. **Authentication**, platform _Web_, two redirect URIs:
   `<web URL>/api/auth/callback/microsoft-entra-id` (sign-in) and
   `<web URL>/sign-in` (where sign-out returns to), for example
   `http://localhost:3000/...` locally. There is no cms redirect URI:
   Strapi's own Microsoft provider is not used and is forced off at every
   boot. Leave the _Front-channel logout URL_ empty (single sign-out is not
   implemented).
3. **Certificates & secrets → New client secret**; copy the value
   (`MS_CLIENT_SECRET`, used by the web only) and note its expiry.
4. **API permissions → Microsoft Graph → Delegated**: `openid`, `profile`,
   `email`, `User.Read`; `User.Read.All` only with `ENTRA_SYNC_MANAGER=1`.
   **Grant admin consent.** (`GroupMember.Read.All` is not needed.)
5. **App roles** (allowed member types _Users/Groups_): `Intranet.Admin`,
   `Intranet.Editor`, `Intranet.DepartmentHead`, `Intranet.TeamLead`,
   `Intranet.Member`, `Intranet.Guest` (mapped to `admin_role`, `editor`,
   `department_head`, `team_lead`, `member`, `guest`). Then **Enterprise
   applications** → the app → _Assignment required_ = **Yes**, and assign
   the roles to users or security groups (Entra ID P1; nested groups are not
   expanded). Never assign public Microsoft 365 groups or Teams to a
   privileged role.

**2. Configure the apps.** With Docker Compose, in `infra/.env` (compose
hands each app the keys it reads):

```dotenv
ENTRA_ENABLED=1
MS_TENANT_ID=<directory-tenant-guid>
MS_CLIENT_ID=<application-client-guid>
MS_CLIENT_SECRET=<client-secret-value>
ENTRA_EXCHANGE_SECRET=<openssl rand -hex 32>
ENTRA_SYNC_MODE=dry-run
```

For local development the cms reads `ENTRA_ENABLED`, `MS_TENANT_ID`,
`MS_CLIENT_ID` and `ENTRA_EXCHANGE_SECRET` from `apps/cms/.env`; the web
reads `ENTRA_ENABLED`, `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID`,
`AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET` and the same
`ENTRA_EXCHANGE_SECRET` from `apps/web/.env.local` (both examples carry the
block, commented out). With `ENTRA_ENABLED=1` an invalid value stops the
cms at boot and makes the web answer every request with an error, both
naming the variable; `infra/deploy.sh --check` refuses the deploy first.
The remaining knobs are in the
[environment reference](README.md#environment-reference).

**3. Check it.** The cms logs `[entra] enabled tenant=… mode=dry-run` at
boot, and the sign-in page shows _Sign in with Microsoft_ (local sign-in is
off next to it unless `AUTH_LOCAL_ENABLED=1`). Each sign-in writes one
`[entra] user=… result=…` line. `ENTRA_SYNC_MODE=dry-run` changes no
existing user (it logs the changes `on` would make) and creates new users at
most as `member`; refusals (no assignment, `deny`) apply in both modes.
Switch to `on` once the log looks right
([Staging dry-run, then on](./docs/SSO.md#staging-dry-run-then-on)).
Sign-in errors and the procedure for an e-mail address that already has an
account are in the runbook.

### OIDC sign-in with Keycloak, authentik or Zitadel (optional)

Since v0.25.0 the same pattern works with any standard OpenID Connect
identity provider: off unless `OIDC_ENABLED=1` is set for **both** apps,
and never together with `ENTRA_ENABLED=1`. Auth.js runs the OIDC code flow
against `OIDC_ISSUER`; the cms verifies the ID token itself (discovery and
signing keys of the issuer, asymmetric algorithms only), finds or creates
the user by issuer + subject, takes the role from the `Intranet.*` roles in
the token (without one the sign-in is refused, `OIDC_DEFAULT_ROLE=deny`)
and issues the intranet session. The token must carry a verified e-mail
address. Register `<web URL>/api/auth/callback/oidc` as the redirect URI,
then set in `infra/.env`:

```dotenv
OIDC_ENABLED=1
OIDC_ISSUER=<exactly as the provider's discovery document writes it>
OIDC_CLIENT_ID=<client id>
OIDC_CLIENT_SECRET=<client secret>
OIDC_EXCHANGE_SECRET=<openssl rand -hex 32>
```

The recipes for Keycloak (a client-role mapper into the ID token),
authentik (signing key, trailing slash in the issuer, an own e-mail
mapping) and Zitadel (`OIDC_ZITADEL_ORG_ID`, project role assertion), the
role rules, identity changes and the sign-in errors are in
[SSO.md, OIDC sign-in (Keycloak, authentik, Zitadel)](./docs/SSO.md#oidc-sign-in-keycloak-authentik-zitadel);
the remaining knobs in the [environment reference](README.md#environment-reference).

## Verification checklist

Setup:

- [ ] `pnpm install` completes without an "Ignored build scripts" warning,
      and `pnpm build:domain` writes `packages/domain/dist/cjs` and
      `dist/esm`
- [ ] Strapi admin loads at `:1337/admin`; the first admin exists
- [ ] Six intranet roles under _Settings → Users & Permissions → Roles_, next
      to the built-in _Authenticated_ and _Public_ (eight in total)
- [ ] With `SEED_DEMO_DATA=1` on a fresh database, the seeded
      announcements, events, wiki pages, polls and documents show in the
      Content Manager's default list as _Published_, and editing and
      publishing one keeps its relations (author, department, space, …)
- [ ] The dashboard at `:3000` shows stat cards and empty states
- [ ] Local sign-in returns to the dashboard with your display name in the
      topbar; `/api/auth/session` returns only `user`
      (name/email/image/id), `provider` and `expires`, no Strapi JWT, role
      or department
- [ ] Without `ENTRA_ENABLED=1`: no Microsoft button, the cms logs
      `[entra] disabled`, and `POST /api/auth/entra/exchange` answers 404
- [ ] With `ENTRA_ENABLED=1` (a test tenant): the Microsoft sign-in returns
      to the dashboard, the cms logs one `[entra] user=… result=created`
      line, the profile shows name, job title, phone and office as
      read-only, and sign-out goes through Microsoft back to `/sign-in`
- [ ] `docker compose up -d` brings the full stack up behind the reverse
      proxy (Caddy locally, Traefik on the production host)

Roles and access:

- [ ] Editing a wiki page as a `member` who is not its author answers 403
      (only the author, the head of the page's department, the lead of its
      team, `admin_role` and `editor` may edit it)
- [ ] Through the API, a team lead can change their team's description,
      and a payload with `members` (or any other field outside the write
      allowlist) answers 400 (probe in
      [OPERATIONS.md, Role enforcement (optional)](./docs/OPERATIONS.md#role-enforcement-optional));
      a department head can change their own department's description; a
      department member sees the announcements and wiki spaces targeted at
      their department
- [ ] An admin and an editor see the _Manage_ link and `/manage` with the
      announcement, event, poll, quick-link, document and wiki areas (an
      admin also the reports and the _Organisation_ section: departments,
      teams and users); a department head with a department sees
      _Manage_ with announcements, events and documents of their department
      only; an editor sees _New poll_; a guest sees no RSVP controls and no
      _New ad_ button
- [ ] A guest's navigation has no Announcements, Departments, Teams, Kudos,
      Marketplace or Training; opening one of them by URL shows _Not
      available for your account_, and neither the web nor the cms logs a
      403 for it
- [ ] An editor sees _Moderation_ / _Delete ad_ on someone else's ad and no
      _Edit_ link; `/marketplace/<id>/edit` sends them back to the ad
- [ ] Poll targeting: a poll restricted to one department is listed for
      its members only; an editor outside it sees _Only for: …_, the
      results and disabled buttons
- [ ] Poll guest access: a guest sees no poll until an admin or editor
      turns on _Visible to guests_ (then results, disabled buttons and
      _Guests can't vote on this poll._); with _Guests can vote_ on as well
      the guest can vote
- [ ] ⌘K as a guest finds a colleague by name but not by e-mail; while a new
      term loads, the previous term's results are not shown (nor the old
      results of the same term typed again)
- [ ] A user blocked in the Strapi admin loses `/uploads` files within a
      minute (401) and is sent to sign-in on the next page load
- [ ] Changing the password on `/profile` in browser A keeps A signed in;
      the same account in browser B lands on `/sign-in?expired=1` with its
      next click; a new password set for that account in the Strapi admin
      (_Content Manager → User_, which shows no token version field) sends
      A there too
- [ ] `/events` shows each upcoming RSVP event's counts, the names of the
      "yes" answers and your own answer (never who answered maybe or no);
      as a member, `GET /api/event-rsvps` returns only your own answers,
      and a `filters[user]…` query or a `Strapi-Response-Format` header
      answers 400

Live updates, notifications and dates:

- [ ] A comment posted in session A appears in session B in under two
      seconds without a reload (SSE), or run `infra/live-smoke.sh` (it
      also requires the stream to report `"emitFresh":true`, i.e. the cms
      keepalive reaches the web); on `/announcements` the network panel
      shows one `POST /live/subscribe` with the page's full channel set for
      all cards, and a comment on one card refreshes that card only
- [ ] With the cms stopped, the header shows _Live updates delayed_
      within about 75 s, and the note goes away once the cms is back
- [ ] Publishing an announcement logs `[notifications] created <n>
notification(s) for announcement …` and rings the bell of its
      audience only (no guest, no blocked user)
- [ ] Digest opt-ins save on `/profile`; without SMTP env the 07:30 cron
      logs `[digest] skipped` (dark mode); a guest sees no digest options
- [ ] On Postgres the cms log shows `[datetime] process time zone UTC,
APP_TIME_ZONE …` and no column is left as `timestamp without time zone`
      (`infra/live-smoke.sh` checks both); an all-day event's `.ics`
      download is an all-day entry
- [ ] The web log shows `[datetime] web process time zone UTC, APP_TIME_ZONE …`;
      on `/events` an event that is running today is under _Upcoming_ and a
      multi-day event shows its end day; relative times say "yesterday"
      for something from late last night
- [ ] The `.ics` link on `/events` names the event's documentId, the file's
      `UID` is `event-<documentId>@sinnlos`, and `/events/abc/ics` answers 404

Pages and UI:

- [ ] `/training` lists published courses; on every course a lesson's
      completion button stays locked until every quiz answer is correct
      (per answer on `confirm`, collected on `quizGate`, overall-only on `exam`).
      The browser receives no solution keys; feedback creates no receipt and
      completion is independently graded by the cms. Completed exam review
      stays overall-only, and malformed quiz content cannot complete;
      `/manage/training/report` shows the completion report (admin; department heads and team leads for their own department)
- [ ] Admins/editors author courses and nested lessons at `/manage/training`;
      quiz edits are detected, image uploads survive save conflicts, and previous
      completion receipts remain valid. Department heads/leads edit their permitted
      descriptions from the detail pages; admins also edit organisation images.
      `/manage/activity` shows the admin-only filtered activity trail
- [ ] After a few ⌘K searches, `/manage/analytics` shows the search section
      (totals, zero-result rate, top terms)
- [ ] `/people/<id>` of a manager shows _Direct reports_
- [ ] `/manage/acknowledgements` shows a percentage per mandatory
      announcement (not "–") while the directory is complete, also with
      more than 2000 confirmations in total
- [ ] The kudos picker lists neither you nor blocked accounts; `/people`
      renders 48 cards and a _+ N people_ button when more match; the bell
      badge counts every unread notification (99+ above 99), not only the
      20 in the panel
- [ ] A lesson with a YouTube video plays (no player "Error 153"); on a
      real domain, since localhost can hide the Referer effect
- [ ] `/people/abc`, `/marketplace/abc` and `/marketplace/2147483648`
      show the _Page not found_ card (like every `notFound()` page here
      with HTTP status 200 and `noindex`: `loading.tsx` streams the shell
      first) and send no request to the cms; with the cms stopped,
      `/profile` shows the error banner and no editable profile form;
      stopping the cms after a page loaded, a reaction click or _Mark all
      read_ shows an inline error while the page stays
- [ ] With the cms stopped after a page loaded, the bell keeps its badge
      and list and the open panel says the intranet cannot be reached; a
      page loaded during the stop shows only that note
- [ ] At 360 px every section is reachable: five tabs plus _More_, whose
      sheet opens with Enter, keeps Tab inside, closes with Escape and lists
      _Admin_ for admins only
- [ ] With network throttling, a clicked nav link shows its pending dot
      until the route's skeleton (with the progress bar) appears
- [ ] The first Tab on an app page shows _Skip to content_; the theme
      toggle switches on the first click also for a user whose system theme
      is dark
- [ ] The language menu, the marketplace category and duration selects,
      the _/people_ department filter and the notification bell open with
      Enter, move with the arrow keys, jump by typing a letter, close with
      Escape and give focus back to their button; picking _Deutsch_
      with the keyboard (Enter, ArrowUp, Enter) leaves the focus on the
      language button once the page is German; ⌘K logs no "DialogTitle"
      error in the browser console
- [ ] _Delete ad_ and _Give kudos_ keep Tab inside the dialog, close with
      Escape or a click beside it and give focus back to their button;
      confirming a delete lands on `/marketplace` without a _Page not found_
      flash
- [ ] An announcement renders its Markdown (bold, lists, links, images);
      `<script>` or an `onerror` attribute in a body shows as text, a
      `javascript:` link as plain text; the dashboard's _Latest news_
      excerpts show no `**`, `#` or link targets; footnotes in two
      announcements each jump to their own card's notes
- [ ] With `DEMO_MODE=1 pnpm web:dev` (no cms running), the dashboard
      renders the fixtures signed in as Ada Lovelace, and the other pages
      answer from the fixtures without a `[demo] no fixture` warning
