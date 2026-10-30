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
`deploy` user of [INSTALL.md](INSTALL.md); from a root shell `sudo -iu deploy`).
The examples use the INSTALL checkout `~/sinnlos`; an existing installation
uses its own checkout path:

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
cd ~/sinnlos
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

**Upgrading to v0.33.3.** No required env, no edge change. Strapi adds one nullable column.

- **Strapi 5.60.0** (every `@strapi/*` package). At the first boot Strapi adds the nullable column `strapi_webhooks.content_type_events` (webhook events chosen per content type); nothing else in the database changes.
- **Open tabs offer a reload after a deploy (#214).** A tab opened before a deploy runs the old web bundle, so its Server Actions (the bell's refresh, comments, saving) fail until it is reloaded. The live stream's first event now names the web's build revision; a tab whose own revision differs shows a "New version – reload" button in the header, in place of the "Live updates delayed" note. It never reloads by itself. Tabs opened before v0.33.3 do not have the button yet: reload them once by hand. Without the live stream (`LIVE_EVENTS_DISABLED=1`) there is no button. On phones narrower than 360 px the button overlaps the search button, like the delayed note.
- **Rollback** to v0.33.2 is a plain retag of both images. The new column stays, and v0.33.2 ignores it (`DATABASE_FORCE_MIGRATION` stays off); webhook events chosen per content type under v0.33.3 do not apply on v0.33.2. Tabs of v0.33.3 then show the reload button once.

**Upgrading to v0.33.2.** No required env, no edge change, no schema change.

- **Dependencies:** the `node:24-alpine` base image digest, `docker/login-action` 4.7.0, Next 16.4.3, vite 8.3.5, jose 6.2.13, lucide-react 1.61.0, postcss 8.5.31, typescript-eslint 8.72.0, @axe-core/playwright 4.14.0.
- **Screen-reader names in the header (WCAG 2.5.3, Label in Name):** each control's name now contains the text it shows. Search: the placeholder text, with the shortcut as `aria-keyshortcuts`; the bell: "Notifications, 3 unread" (above 99: "99+ unread (150)": the badge text plus the exact count); the language menu: "Choose language EN English"; the profile link: "My profile" plus the initials. Nothing changes on screen.
- **Rollback** to v0.33.1 is a plain retag.

**Upgrading to v0.33.1.** No required env, no edge change, no schema change.

- **Registry mode** (`DEPLOY_IMAGE_SOURCE=registry`): `deploy.sh` drops the `ghcr.io/…:<sha>` tag once the local tags hold a pulled image, so the prune of old SHA tags removes old pulled images too (#210). Images pulled by v0.33.0 keep their `ghcr.io` tag: list them with `docker images ghcr.io/yurtbayemre/sinnlos-*` and remove those no container uses with `docker image rm <ref>` (only untags while a local tag still names the image).
- **Tests only:** the `token-version` integration test counts only its own schema's lock waits (#209).
- **Rollback** to v0.33.0 is a plain retag.

**Upgrading to v0.33.** No required env, no edge change, no schema change.

- **Visibility at any size (#175):** the read rules (announcements, documents, quick links, polls, wiki, courses and lessons, comments and reactions) no longer stop at about 64,500 visible rows of one type (Postgres; about 31,700 on SQLite). The visible list now reaches the database as one parameter, and the rule loaders read in pages of 5,000. Who sees what is unchanged.
  - A filter that is not an object (`?filters=text`) now answers 400 on every policy-gated route.
- **Images from CI:** CI builds arm64 images on every push to `main` into the owner's **private** GHCR packages. `DEPLOY_IMAGE_SOURCE=registry` pulls them by commit SHA and needs a `read:packages` token on the host ([INSTALL.md](INSTALL.md#images-from-ci-registry-mode)). It no longer needs a release tag on the checkout. Other installations keep building (`build`, the default). A host that switches to registry mode does so after a deploy of this release in build mode.
- **iPhone:** text fields show 16px on touch screens, so iOS Safari no longer zooms in on focus and the page after sign-in no longer opens zoomed in. On a desktop the fields keep their size.
- **Rollback** to v0.32.0 is a plain retag.

**Upgrading to v0.32 (tidy).** No required env, no edge change, no schema change.

- **Pinned images:** `infra/docker-compose.yml` pins `postgres:16-alpine` and `caddy:2-alpine` by digest (Postgres 16.15, Caddy 2.11.7; Dependabot proposes new digests of the same tags). The changed image reference can make the first deploy recreate the db container even when the image is the one already running: a short database restart during that deploy. The `pgdata` volume and its data stay. A host whose Postgres differs from the pinned digest gets the pinned 16.x on that deploy.
- **Duty plans:** a start or end time that the clock change skips or repeats (02:00–02:59 on those two nights) is refused with the usual clock-change message, in the editor and in "copy week". It stays as typed until corrected; existing shifts are unchanged.
- **Dates:** an instant on an impossible day (`2026-02-30T…`) is refused everywhere, as the cms parser already did.
- **Kudos:** a message has at most 1,000 characters (the cms answers 400 above it).
- **Invitations:** more than 100 addresses are refused as a whole, with the text kept; blank lines do not count.
- **Backup** (`infra/backup/pg-backup.sh`, hosts without `backup-run`): the uploads are captured right after the database dump, before either is encrypted, and the tar runs without network. The backup directory needs room for both plaintext artifacts at once, plus their compressed and encrypted copies while they are written ([OPERATIONS.md](OPERATIONS.md)).
- **Search:** the index is uploaded in parts of at most 10 MB.
- **Rollback** to v0.31.0 is a plain retag. The compose pins live in the checkout, not in the images: a retag keeps the pinned Postgres.

**Upgrading to v0.31 (scale).** No required env, no edge change, no schema change.

- **Indexes:** the first boot creates four plain indexes, `notifications (source_type, source_document_id)` and `(target_type, target_document_id)` on `comments`, `reactions` and `acknowledgements`, and logs `[document-indexes] created 4 index(es): …` once. While one builds, writes to its table wait; on a large notifications table that can take minutes, so upgrade a big installation outside working hours. Later boots create and log nothing.
- **Permissions:** two new actions, `api::profile.profile.openAcks` (every role) and `api::acknowledgement.acknowledgement.reportIndex` (`admin_role`). The first boot logs `granted 8`; the drift check then counts 220 managed actions.
- **Dashboard banner:** one cms read (`GET /api/me/open-acks`) instead of a page walk over every mandatory announcement and document. Same rules as before.
- **Acknowledgement report** (`/manage/acknowledgements`): 20 items per section and page (`?page=`, `?documentsPage=`), in the same order as before; receipts are read for the shown items only, and the "incomplete" warning refers to them.
- **/manage lists:** without a status filter, a moderator's list reads only the shown page in full.
- **Search** (Meilisearch on): each minute reads a cheap probe and loads the content only when it moved, at least once an hour. Publishing, unpublishing, deleting and scheduled runs still show within a minute; a raw database write that changes text in place shows within the hour ([OPERATIONS.md](OPERATIONS.md#meilisearch-optional-search)).
- **Data export:** unrelated files and duty plans no longer count against the 100,000-row limit; only the person's rows do.
- **Rollback** to v0.30.1 is a plain retag. The indexes stay (v0.30.1 ignores them); the two new routes do not exist there (404 or 405), each v0.30.1 boot removes one stored permission row per unknown action, and the next forward boot grants the missing rows again.

**Upgrading to v0.30.1.** No required env, no edge change, no schema change.

- **Recovery codes:** the sign-in refuses the 10-character recovery codes issued before v0.30 ([GHSA-2jjv-m669-5cqh](https://github.com/yurtbayemre/sinnlos/security/advisories/GHSA-2jjv-m669-5cqh)). The authenticator app keeps working. Everyone who enrolled before v0.30 has no working recovery code until they enrol again. Reset their second factor at `/manage/users`; your own needs another admin, or `infra/mfa-reset.sh <email>` on the host. The reset ends their sessions. A role in `MFA_REQUIRED_ROLES` enrols again at the next sign-in, with new codes; others turn it on again in their profile. Reset admins one at a time: reset the next only after the previous one has enrolled again, so one admin can always use `/manage`.
- **Rollback** to v0.30.0 is a plain retag. Old codes whose hashes are still stored work there again; resets and re-enrolments are not undone.

**Upgrading to v0.30 (hardening).** No required env, no edge change, no schema change.

- **Deploys:** the smoke check asks `/healthz`. `--require-green-ci` needs the successful CI run for the push to `main` at the exact commit, and every push to `main` now runs the whole CI. Before `up`, deploy.sh checks `APP_TIME_ZONE` and `MFA_REQUIRED_ROLES` in the new cms image ([INSTALL.md](INSTALL.md)).
- **Second factor:** new recovery codes have 80 bits (`xxxx-xxxx-xxxx-xxxx`). On v0.30.0 the codes issued before keep working; v0.30.1 refuses them (see above). New codes come with a new enrolment: after an admin MFA reset, or, for a role outside `MFA_REQUIRED_ROLES`, a disable and enable.
- **Sessions:** a block ends the person's sessions and links wherever it is set, the Strapi admin panel included.
- **Uploads:** PNG, JPEG, GIF, WebP and AVIF images, PDF, video and audio open in the browser; other files download. The cms refuses XML uploads; XML files uploaded before stay and download.
- **Anonymisation** cleans other people's notifications after it committed, page by page, and reports what is still pending; the nightly sweep repeats the rest while `CRON_ENABLED` is on ([data-protection.md](data-protection.md)).
- **Time limits** web → cms ([OPERATIONS.md](OPERATIONS.md#time-limits-web--cms)): the edge must allow 300 s for the anonymisation.
- **Editors** ask before leaving with unsaved changes (links, search, the bell, sign-out; Back and Forward in browsers with the Navigation API).
- **Rollback** to v0.29.3 is a plain retag. Recovery codes issued under v0.30 (16 characters) are refused there: those users need an admin MFA reset after a rollback.

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
