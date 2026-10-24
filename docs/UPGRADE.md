# Upgrading sinnlos

How to move an installation to a newer release. A new installation: [INSTALL.md](INSTALL.md). Backups, restore, monitoring and everyday operation: [OPERATIONS.md](OPERATIONS.md).

## Supported upgrade path

- **From v0.25.x or newer:** straight to the current release. Read the notes of every release you skip; [From v0.25.x directly](#from-v025x-directly) sums them up.
- **Older than v0.25:** first upgrade to v0.28.x, with the documentation of that release (its `docs/DEPLOYMENT.md`; the same runbooks are in [archive/deployment-history.md](archive/deployment-history.md)), then to the current release. Since v0.29 the cms refuses to start on such a database and changes nothing:
  - `[upgrade] This database predates v0.25 (up_users has no oidc_subject column). …`
  - `[datetime] This database still has naive timestamp columns with data, written before the datetime contract. …`

## From v0.25.x directly

What changed for the operator between v0.25 and this release. The release notes below have the details.

1. **Host settings** (v0.26): `COMPOSE_PROJECT`, `DEPLOY_EDGE=traefik` on a host Traefik, `SINNLOS_BACKUP_DIR` (or `BACKUP_RUN`) and `PASSWORDS_FILE` for live-smoke, in `infra/deploy.env` (mode 600, from [`infra/deploy.env.example`](../infra/deploy.env.example)) or in the deploy user's environment, before the first deploy. A host Traefik without `DEPLOY_EDGE=traefik`, or neither `SINNLOS_BACKUP_DIR` nor `BACKUP_RUN`, makes `infra/deploy.sh` refuse before it changes anything.
2. **Strapi admin panel** (v0.26): only clients from `ADMIN_ALLOW_CIDRS` reach it; empty closes it from outside. `infra/admin-tunnel.sh` opens it through SSH ([INSTALL.md](INSTALL.md), section 8).
3. **Analytics** (v0.26): loaded only when `PLAUSIBLE_SCRIPT_URL` and `PLAUSIBLE_DOMAIN` are set.
4. **Operator links** (v0.26): `PRIVACY_URL`, `IMPRINT_URL` and, optionally, `WHISTLEBLOWING_URL`. **Demo data** (v0.26): production refuses `SEED_DEMO_DATA=1`; remove it from `infra/.env`, or every boot logs the refusal.
5. **Second factor** (v0.27): password accounts of the roles in `MFA_REQUIRED_ROLES` (default: admins and editors) enrol an authenticator app at their next sign-in, and their older sessions end. Keep `ENCRYPTION_KEY` in your `.env` backup.
6. **live-smoke accounts** (v0.27): `SMOKE_EMAIL` and `SMOKE_AUTHOR_EMAIL` must have roles outside `MFA_REQUIRED_ROLES`.
7. **Accounts and e-mail** (v0.27): self-registration is gone; invitations and password links need `SMTP_*` and `DIGEST_FROM`. New passwords need 12 characters.
8. **Data protection** (v0.28): nothing to set. New nightly jobs from 03:20 to 03:56; optional `FEATURES_OFF`, `TRAINING_EVIDENCE_RETENTION_YEARS` and `SEARCH_LOG_RETENTION_DAYS`.
9. **This release** (v0.29): nothing to set. `DATETIME_LEGACY_ZONE` and `DATETIME_LEGACY_UTC_UNTIL` are no longer read; delete them from `infra/.env`. Optional: the branding keys ([INSTALL.md](INSTALL.md)), `SITE_ALLOW_CIDRS` and `infra/ops-check.sh` ([OPERATIONS.md](OPERATIONS.md#monitoring)).

## Update procedure (production-safe)

On the live Traefik host the wrapper handles the checks, backup, build,
smoke checks and the SHA tags of the last-known-good deploy in one shot
([INSTALL.md](INSTALL.md)). Run every step as the owner of the checkout (the
`deploy` user of [INSTALL.md](INSTALL.md); from a root shell `sudo -iu deploy`):

```bash
cd ~/sinnlos && git fetch --tags && git checkout v<new version>   # a detached tag checkout is fine; a checkout that follows main: git pull --ff-only
infra/deploy.sh
```

The manual equivalent (e.g. on a standalone Caddy box):

```bash
# 0. Keep the running images as a rollback target (the wrapper does this with SHA tags)
docker tag "$(docker inspect -f '{{.Image}}' infra-web-1)" infra-web:manual-prev
docker tag "$(docker inspect -f '{{.Image}}' infra-cms-1)" infra-cms:manual-prev

# 1. Always back up first (pg-backup.sh needs SINNLOS_BACKUP_DIR and SINNLOS_ENV_FILE, OPERATIONS.md)
~/sinnlos/infra/backup/pg-backup.sh

# 2. Pull latest code and validate infra/.env (deploys nothing)
cd ~/sinnlos && git fetch --tags && git checkout v<new version>
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
`.git/sinnlos-deploy/infra.state` of the checkout (`infra.history` next to it;
the newest five SHA tags stay, `DEPLOY_KEEP_TAGS`). A failed deploy never
moves that state. When a deploy fails, the script prints the rollback commands for a
verified target only ([Rollback](#rollback)). By hand:

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
them can be a rollback target; check its release first ([Rollback](#rollback)). `:pre-deploy` names the images that
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
delete it by hand only to have the next run tag what runs then.

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
private key, [OPERATIONS.md, Automated daily backups (cron)](OPERATIONS.md#automated-daily-backups-cron); production: the
`-predeploy` generation of `backup-run`, decrypted and checked as in
[Restoring a production generation](OPERATIONS.md#restoring-a-production-generation))
with `infra/restore-db.sh`
([Restoring a database dump](OPERATIONS.md#restoring-a-database-dump)): into a clean
database, in one transaction, checked, and with a fresh `JWT_SECRET`
before the cms starts.

## Rollback

`infra/deploy.sh` records the images of every good deploy as `infra-{web,cms}:<sha12>` (the last-known-good state in `.git/sinnlos-deploy/`). When a deploy fails after the start, it prints the rollback: a retag of both images to that pair, then `up -d --no-build web cms`. Never roll back the web or the cms alone.

- **Verified target:** the commands are printed only when both images resolve to one commit of the checkout at or after v0.25.0 (their `org.opencontainers.image.revision` label, or the recorded state for the same image ids).
- **Unverified target** (`The rollback target … is not a verified v0.25+ release`): no commands are printed. Find out by hand which release the images hold, for example `docker image inspect infra-cms:<tag> --format '{{ index .Config.Labels "org.opencontainers.image.version" }}'`, before you retag. Releases before v0.25 roll back with the runbooks in [archive/deployment-history.md](archive/deployment-history.md).
- **The database stays.** Restore a backup only when a release note says its rollback needs one ([OPERATIONS.md, Restore](OPERATIONS.md#restore)).
- Each release note below says what a rollback to the release before it keeps.

## Expected log lines after a deploy

**Expected log lines after a deploy** (every release since the
dependency update of 2026-10, whatever its runbook lists):

- the cms prints a two-line `(node:N) DeprecationWarning: Calling
client.query() when the client is already executing a query is
deprecated and will be removed in pg@9.0. …` / ``(Use `node
--trace-deprecation ...` to show where the warning was created)`` on
  stderr once per cms process, after its first database activity
  (a sign-in and the first page reads are enough; the pg driver under
  Strapi 5.57). Harmless; it does not match the runbooks' error
  filters;
- after every web redeploy the web logs `Error: Failed to find Server
Action "<id>". This request might be from an older or newer
deployment.` (with `Read more:
https://nextjs.org/docs/messages/failed-to-find-server-action`) for each
  browser tab that was opened before the restart and then submits a form
  or presses a button of the old build. Harmless: nothing was written,
  and the tab works again after a reload. They come in a burst right
  after the deploy and fade as people reload; the runbooks' error
  filters print them, so count them as expected there;
- now and then the cms prints a three-line `(node:N)
TimeoutNegativeWarning: -6 is a negative number.` / `Timeout duration
was set to 1.` / ``(Use `node --trace-warnings ...` …)``. Strapi's
  cron library (croner 10.0.1) computes the delay to the next run and
  gets a few milliseconds below zero when the event loop runs late;
  Node 24 then waits 1 ms instead and the task runs on time. Harmless;
  first seen in the v0.17.0 watch (2026-10-19), possible on every
  release with Node 24;
- the web may log `The Server Reference ID did not match the expected
format`: a scanner posted to a page with a made-up Server Action id,
  and Next refused it before any code ran. Harmless; first seen
  2026-10-17 on Next 16.4.2.

## Release notes

Newest first. Older releases: [archive/deployment-history.md](archive/deployment-history.md).

**Upgrading to v0.29 (polish).** No required env, no edge change, no schema change.

- **Branding** (optional): `SITE_NAME`, `SITE_LOGO_URL`, `SITE_ICON_URL` and `SITE_ACCENT` ([INSTALL.md](INSTALL.md)). Unset keeps the look of v0.28.
- **Readiness and monitoring:** `/healthz` checks the chain edge → web → cms → database; `infra/ops-check.sh` checks the backup age, the disk and the nightly jobs. The cms keeps the status of its nightly jobs in its database ([OPERATIONS.md, Monitoring](OPERATIONS.md#monitoring)).
- **`SITE_ALLOW_CIDRS`** closes the whole site to everyone outside the listed networks, for a restricted restore ([OPERATIONS.md, Restore](OPERATIONS.md#restore)). `infra/deploy.sh` refuses to deploy while it is set.
- **Removed:** the one-time datetime repair for databases from before the datetime contract (`DATETIME_LEGACY_*`, the report CLI, `docker-compose.{cms,web}-legacy-tz.yml`) and the rollback probes for releases before v0.25. The cms refuses a database from before v0.25 ([Supported upgrade path](#supported-upgrade-path)).
- **Accessibility:** quiz answers are radio buttons; focus and announcements on sign-in, search, quizzes and lesson completion.
- **Docs:** `docs/DEPLOYMENT.md` is split into INSTALL, UPGRADE, OPERATIONS and SSO; the history is in `docs/archive/`.
- **Rollback** to v0.28 is a plain retag. The cms leaves its nightly job status in the Strapi core store (`plugin_sinnlos_cron:*`); v0.28 ignores it.

**Upgrading to v0.28 (data protection).** No required env, no edge
change. [data-protection.md](data-protection.md) (German) describes the
result for the data-protection officer and the works council.

- **Blocked people** leave the directory, the org chart, the people
  search and the duty roster (a shift of theirs shows "Former person");
  content they wrote shows only their name. `/manage/users` still lists
  them.
- **Export and anonymisation** at `/manage/users` (admins): block the
  person first; the anonymisation is final (no unblock, no edit, in the
  Strapi panel neither). Keep each one in your register of data-subject
  requests: after restoring an older backup it must be repeated
  ([data-protection.md](data-protection.md), section 5).
- **Training:** cms and web deploy together. A completion now carries the
  published version the learner saw; a lesson page opened before the
  deploy answers "please reload" once. Receipts keep a snapshot; the
  03:25 job fills it for the older receipts over the next nights (at most
  10 000 a night), marked "Stand unbekannt (vor v0.28)". Courses get a
  contact field.
- **New nightly jobs** after the 03:00 backup: 03:20 erasure sweep,
  03:25 training evidence, 03:52 read confirmations, 03:54 RSVPs, 03:56
  poll voter links; the 03:40 notification janitor now also deletes
  unread notifications after 180 days. The first nights work off the
  backlog (unread notifications older than 180 days, RSVPs of events
  that ended more than 180 days ago, voter links of polls closed more
  than 30 days ago, confirmations of deleted documents). The jobs assume
  the nightly host backup ran before them (03:00 in the standard setup);
  they do not wait for it.
- **Optional env:** `FEATURES_OFF` (cms and web, the same value),
  `TRAINING_EVIDENCE_RETENTION_YEARS` (3), `SEARCH_LOG_RETENTION_DAYS`
  (90). An invalid value refuses the cms boot. The boot logs
  `[switches] everything on` or `[switches] off: <list>`.
- **Grants:** admins lose the acknowledgement update and delete routes
  (revoked at boot) and read only their own notifications
  (`/manage/analytics` reads a total instead); four admin actions are
  new (export, anonymisation preview and run, training evidence). The
  boot logs `permission drift: none (report-only check of 218 managed
actions)`.
- **Rollback** to v0.27 is a plain retag **as long as nobody was
  anonymised**. The new attributes (`anonymisedAt`, the receipt
  `snapshot`, `votersRemovedAt`, the course `contact`) stay
  (`DATABASE_FORCE_MIGRATION=false`) and v0.27 ignores them. Rows the
  new jobs deleted come back only from a backup, and on v0.27 a poll
  whose voter links were removed can be reopened, so its earlier voters
  could vote again.
- **After the first anonymisation**, rolling back below v0.28 is the
  owner's decision: v0.27 does not know anonymised accounts. While it
  runs, never unblock a "Former person" / "Ehemalige Person" account
  (`/manage/users` and the Strapi panel would allow it): an SSO identity
  the identity provider still admits could then sign in and sync its
  profile back. Roll forward to v0.28 as soon as possible.

**Upgrading to v0.27 (accounts and second factor).**

- **Second factor.** After the deploy every password account of the
  roles in `MFA_REQUIRED_ROLES` (unset or empty: `admin_role`, `editor`)
  is sent to `/mfa/setup` at its next sign-in and enrolls an
  authenticator app (Aegis, 2FAS, Google or Microsoft Authenticator);
  sessions from before the deploy of those users end (401, sign in
  again). Have an app ready for your own admin account. A locked-out
  sole admin: `infra/mfa-reset.sh <email>` on the host
  ([INSTALL.md](INSTALL.md)). Keep `ENCRYPTION_KEY` in the `.env` backup:
  the second-factor secrets are encrypted with it.
- **live-smoke accounts** must be outside `MFA_REQUIRED_ROLES`: set
  `SMOKE_EMAIL` (best a member who authored a published announcement)
  and `SMOKE_AUTHOR_EMAIL` (a member) in `infra/deploy.env`, and their
  passwords in `PASSWORDS_FILE`. The defaults (`alex.morgan`, an admin,
  and `sam.chen`, an editor) would stop at the second factor.
- **Passwords:** new and changed passwords need 12 characters and must
  not be common; existing ones keep working. The demo seed password is
  now `Demo-Passwort-2026!` (fresh databases only).
- **Accounts:** self-registration is gone (`LOCAL_REGISTRATION` is
  ignored); admins invite people at `/manage/users`, and
  `/forgot-password` mails reset links. Both need SMTP and
  `INTERNAL_UPLOAD_TOKEN`, which is now the cms-web internal secret for
  uploads and password links.
- **Rollback** to v0.26 is a plain retag. It keeps the new `totp_*`
  columns (`DATABASE_FORCE_MIGRATION=false`), which v0.26 ignores: a
  roll-forward finds the enrollments again. Invited accounts that have
  not set a password yet stay without one under v0.26.

**Upgrading to v0.26 (deploy.sh for any host).** `infra/deploy.sh` no
longer assumes the owner's host:

- **The edge** is a setting: `DEPLOY_EDGE=caddy` (the bundled Caddy, the
  default) or `traefik`. A host Traefik must set `DEPLOY_EDGE=traefik`
  **before** this deploy: the preflight refuses the Caddy default while
  containers of the project carry Traefik labels.
- **The pre-deploy backup** is `infra/backup/pg-backup.sh` into
  `SINNLOS_BACKUP_DIR`, which is now required (no default). A host with
  its own backup service names it in `BACKUP_RUN`; deploy.sh then runs
  `sudo -n "$BACKUP_RUN" --kind predeploy sinnlos` as before. A partial
  pre-deploy backup stops the deploy.
- **live-smoke** has no default credentials file: name it in
  `PASSWORDS_FILE`, or deploy with `--record-without-live-smoke`.
- These host settings go into `infra/deploy.env` (gitignored,
  [infra/deploy.env.example](../infra/deploy.env.example)). The owner's
  host: `COMPOSE_PROJECT=infra`, `DEPLOY_EDGE=traefik`,
  `BACKUP_RUN=/usr/local/sbin/backup-run`, `PASSWORDS_FILE=…`; check
  with `infra/deploy.sh --check` as the checkout's owner.
- **The Strapi admin panel** and its APIs answer only clients from
  `ADMIN_ALLOW_CIDRS` (infra/.env; empty: closed from outside).
  `infra/admin-tunnel.sh` opens it through an SSH tunnel
  ([INSTALL.md](INSTALL.md), section 8).
- New installations: [INSTALL.md](INSTALL.md).
