# Operating sinnlos

Everyday operation of an installed instance: monitoring, restore, backups, hardening and troubleshooting.

- Installation: [INSTALL.md](INSTALL.md).
- Upgrades and rollback: [UPGRADE.md](UPGRADE.md).
- Sign-in with Entra or OIDC: [SSO.md](SSO.md).
- The Strapi admin panel through an SSH tunnel, and a locked-out admin's second factor: [INSTALL.md](INSTALL.md), sections 8 and 6.

## Monitoring

### `/healthz`

`/healthz` is public and needs no session.

- **Answers:** `200 {"status":"ok"}` when the web reaches the cms and the cms reaches its database, else `503 {"status":"unavailable"}`.
- **What it proves:** the chain edge → web → cms → database. It does not check the schema, search, e-mail or the nightly jobs.
- **Staleness:** each process caches its answer for up to 5 seconds, so the result can be that much out of date.
- **Monitor:** point an uptime monitor at `https://<DOMAIN>/healthz` every minute, and alert after a few failures in a row.
- **Behind it:** the cms route is `GET /api/health/ready`.

### `infra/ops-check.sh`

`infra/ops-check.sh` checks what an HTTP monitor cannot see. Run it on the host as the deploy user; like `deploy.sh`, it reads `infra/deploy.env`.

**Output:** one line per problem. It exits 1 if there is any problem and 0 when everything is clean. A line starting with `UNKNOWN` means it could not check something, and that counts as a problem too.

**What it checks:**

- **Backup age.** The script reads one of two files:
  - `$SINNLOS_BACKUP_DIR/offsite/sinnlos/last-success`, written by `infra/backup/pg-backup.sh`;
  - a backup-run `backup-status` file named in `OPS_BACKUP_STATUS` (it uses `daily_last_ok_at`).

  It is a problem if the backup is older than `OPS_BACKUP_MAX_AGE_HOURS` (default 26), or the file is missing or unreadable.

- **Disk.** A problem when free space is below `OPS_DISK_MIN_PERCENT` (default 15) on any of: the Docker root directory, the backup directory, `infra/backups`, the database volume, the uploads volume.
- **Nightly jobs.** The cms records every job run in its database. A problem when:
  - cron is switched off (`CRON_ENABLED=false`);
  - a job failed, either in its last run or within `OPS_CRON_LOOKBACK` (default 2 hours), even if a later run succeeded;
  - a job has not run for longer than its schedule allows.
- **Push.** With `OPS_PUSH_URL` set, a clean check calls that URL, for example an Uptime Kuma push monitor. Kuma then alerts when the pings stop. A failed ping is reported as a problem line.

**Schedule:** run it hourly from the deploy user's crontab. Send the problem lines to a mail address (`MAILTO` needs a working mail transport on the host), use a push monitor, or both:

```
MAILTO=ops@example.com
0 * * * * /home/deploy/sinnlos/infra/ops-check.sh
```

Container logs are lost when a container is recreated. `ops-check.sh` does not need them; to keep them anyway, use a Docker logging driver such as `journald`.

## Restore

Restoring a backup brings back everyone the backup holds, **including people anonymised after it was taken**. Until those anonymisations are repeated, nobody else may reach the site, so the restore runs behind closed doors:

1. **Close the site and check it.**
   - Check your current public address first.
   - In `infra/.env`, set `SITE_ALLOW_CIDRS=<your address>/32` (comma-separated for several networks) and `CRON_ENABLED=false`.
   - Recreate the edge and the apps.
   - Check **from outside** that the site answers 503.
2. **Run `infra/restore-db.sh prepare <dump>`.** It reserves the restore and stops web and cms.
3. **Restore uploads and configuration while the apps are stopped.** Keep the `ENCRYPTION_KEY` that belongs to the dump: it decrypts the second-factor secrets. (`rotate-jwt` in step 5 changes only `JWT_SECRET`.)
4. **Close the site again.** The restored `infra/.env` may lack the two settings, so set `SITE_ALLOW_CIDRS` and `CRON_ENABLED=false` again in the `infra/.env` that will be used. Then:
   - **Bundled Caddy:** run `docker compose up -d --no-deps --force-recreate caddy`. `--no-deps` keeps the apps stopped.
   - **Host Traefik:** the gate lives in the app labels. Check them with `docker compose … config`: the `sinnlos-site-allow` middleware must be on all five routers, with your range.
5. **Run `apply`, `rotate-jwt` and `start`.** Then check from outside, on every route, that the site still answers 503.
6. **Repeat the anonymisations.**
   - Sign in from your address.
   - Repeat every anonymisation in your erasure record that is newer than the backup: block, then anonymise, at `/manage/users`.
   - Check each person in the directory, in search, on their avatar and in marketplace images.
   - If the only restored admin must be anonymised too, first create a new admin with the first-admin procedure ([INSTALL.md](INSTALL.md), section 6).
7. **Turn cron back on, with the site still closed.**
   - Remove `CRON_ENABLED=false` and recreate the apps.
   - With Meilisearch, wait for an ok `search-index` run that started after the last anonymisation; `infra/ops-check.sh` shows a failed one.
   - Search for each erased name.
8. **Open the site.** Remove `SITE_ALLOW_CIDRS` and recreate the edge (with Traefik: the apps).

Notes on the gate:

- `SITE_ALLOW_CIDRS` filters on the client address the edge sees. It works on the bundled Caddy, and on a host Traefik that is the direct ingress. Behind another proxy or a CDN, configure that layer instead.
- Checks from the host itself arrive from the Docker bridge, so they get 503 too unless you list the bridge range. That covers `deploy.sh`'s smoke check, live-smoke and a local uptime monitor.
- `infra/deploy.sh` refuses to deploy while `SITE_ALLOW_CIDRS` is set, and `infra/restore-db.sh start` reminds you when the site would be public.
- The erasure record is personal data ([data-protection.md](data-protection.md), section 5).

## If the cms refuses to boot

- **`[upgrade] This database predates v0.25 …`** or **`[datetime] This database still has naive timestamp columns …`:** upgrade through v0.28.x first ([UPGRADE.md](UPGRADE.md#supported-upgrade-path)).
- **The org draft/publish guard** (department or team drafts): follow [infra/migrations/org-dp/README.md](../infra/migrations/org-dp/README.md).
- **The revision guard** (wiki revision drafts): follow [infra/migrations/wiki-revision-dp/README.md](../infra/migrations/wiki-revision-dp/README.md).

Both guards fire only after a rollback to images from before those changes.

## Backup & Restore

For any production deployment (VPS or Azure VM with Docker Compose), you are
responsible for backing up two things:

1. **Postgres database** — all content, users, revisions, announcements
2. **Uploads volume** — images, avatars, file attachments

> For Azure Container Apps (unverified, [deployment-history.md, 5. Azure Container Apps (Advanced)](archive/deployment-history.md#5-azure-container-apps-advanced)),
> use **Azure Database for PostgreSQL automated backups** (7–35 days,
> enabled by default) for the database. Azure Files takes no snapshots by
> itself: set up share snapshots or Azure Backup for the uploads share.

### Manual Postgres backup

From the Docker Compose host (on the owner's host the checkout is
`/home/bigemo/git/sinnlos`):

```bash
cd /home/bigemo/git/sinnlos/infra   # a standalone Caddy box: cd /opt/sinnlos/infra
umask 077 && mkdir -p backups   # the dump holds every user and password hash

# Dump to a timestamped file
docker compose exec -T db \
  pg_dump -U sinnlos -d sinnlos --format=custom \
  > backups/sinnlos-$(date +%Y%m%d-%H%M%S).dump
```

#### Restoring a database dump

Restore into a **clean** database, never over the one that runs:
`pg_restore --clean` drops only the objects the dump holds, so a table a
newer release added, with its foreign keys into the dump's tables (the
RSVP, acknowledgement and author links into `up_users`, for example),
blocks those drops, and by default `pg_restore` carries on after such
errors and leaves a mixture of both states. The restore below therefore
drops and recreates the database and restores in one transaction that
stops at the first error.

**`infra/restore-db.sh`** does it in four steps, run one after the other
as the checkout owner (on the owner's host `bigemo`; from a root shell
`sudo -iu bigemo`), from any directory. Each step ends with one `OK: …`
or `STOP: …` line and exits 0 (OK), 1 (STOP: the line says what changed
and what to do next), 2 (usage) or 3 (another restore step or a deploy of
the project holds the lock; nothing changed). A dump counts as readable
only when it lists at least one table **and** the whole archive decodes
(`pg_restore --file=/dev/null`): `--list` alone reads only the table of
contents, which a dump cut off in its data still has. Every step clears
its own result and the results of the steps after it before it does
anything, and a result belongs to one **attempt** (one `prepare`), so a
retried or failed step never leaves an old "passed" behind:

- `prepare <dump>` starts a new attempt. First it ends the attempt
  before it (that one can then no longer be applied, rotated or started,
  even when this `prepare` fails). It copies the dump into the attempt's
  own file, `infra/backups/restore-<attempt>/dump` (mode 600 in a mode-700
  directory, the **staged** dump; from here on only this copy is read, so
  a dump path changed or swapped later changes nothing) and checks that
  copy. Then it **reserves** the project (below), stops web and cms, and
  writes a **new** copy of the current database,
  `infra/backups/before-restore-<attempt>.dump` (a name that has not
  existed before), checked the same way; it drops nothing;
- `apply` runs only for the current attempt, prepared and not ended. It
  opens the staged dump once and reads everything through that one
  descriptor: its sha256 must still be the one of `prepare` and it must
  still decode. It stops web and cms again and then asks Postgres whether
  the database exists: a database that exists is dropped only when the
  attempt's copy of it is still there with its sha256 and decodes (when
  `prepare` found no database, one that exists now stops `apply`). Then
  it drops the database (`dropdb --if-exists --force`, so a retry after a
  failed `createdb` works) and creates it again, runs `pg_restore
--no-owner --exit-on-error --single-transaction`, and checks that the
  database holds the dump's tables and at least one `up_users` row (both
  queries with `ON_ERROR_STOP`); a failed `apply` may be run again;
- `rotate-jwt` runs only after `apply` passed for this attempt: it refuses
  a `JWT_SECRET` exported in the shell (Compose would hand that to the
  cms instead of `infra/.env`) and an `infra/.env` without exactly one
  `JWT_SECRET=` line, writes a fresh `openssl rand -base64 48` on that
  line (mode 600, by rename), and checks by checksum, without printing
  it, that the file and the value Compose hands the cms (`compose config`)
  are the new one, so a compose file that sets `JWT_SECRET` stops it too;
  it turns tracing off itself, so `bash -x` shows no secret either;
- `start` starts web and cms (`up -d --no-build web cms`) only when
  `apply` and `rotate-jwt` passed for the same attempt and Compose still
  hands the cms the rotated secret (no `JWT_SECRET` exported since). It
  ends the attempt and the reservation and deletes the staged dump:
  another restore starts with `prepare` again. Should that cleanup not
  finish after the apps came up (the staged dump cannot be removed, or the
  step is interrupted), `start` stops with that and the reservation stays;
  running `start` again finishes only the cleanup (the staged dump, the
  unsafe mark and the reservation), without touching the database or the
  containers.

`infra/restore-db.sh status` shows the current attempt (the dump and the
copy with their sha256 and table counts, which steps passed and the next
one, and the reservation; never a secret). `infra/restore-db.sh back`
starts a new attempt from the copy of the database as it was before the
restore (below). `infra/restore-db.sh cancel` ends an attempt whose
`apply` has not begun, and the reservation (below).

**Restore** (the dump's path in the first step; on the owner's host the
checkout is `/home/bigemo/git/sinnlos`, elsewhere e.g. `/opt/sinnlos`):

```bash
cd /home/bigemo/git/sinnlos
infra/restore-db.sh prepare infra/backups/sinnlos-20260415-120000.dump
infra/restore-db.sh apply
infra/restore-db.sh rotate-jwt
infra/restore-db.sh start
```

Each step goes on only from what the step before recorded, so pasting
the four lines at once, or joining them with `&&`, is safe: after a STOP
the following steps stop too. The attempt lives in a state file,
`<project>.state` in `restore/` of `infra/deploy.sh`'s state dir
(`.git/sinnlos-deploy/restore/` of the checkout, or of
`DEPLOY_STATE_DIR`; no secret; the earlier attempts next to it), not in
the shell: a new shell, an `exit`, a
changed variable or another working directory loses nothing. The script
reads its state files as data it checks, never as code: each must be a
regular file of the checkout owner with mode 600 in a mode-700 directory,
hold only its known keys, once each, and every value in its form
(attempt ids, sha256, counts, times); the paths it works with are derived
from the attempt id. Anything else stops the step before it changes
anything (move the file away and start again with `prepare`).

**The reservation:** from `prepare` on, the project is reserved
(`restore/<project>.reservation` next to the lock) until `start` passes
or `cancel` ends it, also across failed steps. **`infra/deploy.sh`
refuses to deploy while the reservation exists** (`ERROR: a database
restore of compose project infra is in progress`, nothing changed),
because its `up` would start the cms on a database that may be empty, or
restored without its new secret. As the reservation lies next to
`infra/deploy.sh`'s lock and state, a second clone that shares
`DEPLOY_STATE_DIR` ([INSTALL.md](INSTALL.md), the parameters) sees a restore of
the other clone as well. Once an `apply` has begun, the reservation also
records that the database is **unsafe** (empty, half-restored, or
restored without its new secret); that mark stays through later
`prepare`, `back` and failed steps, and only a `start` that passes (its
attempt's `apply` and `rotate-jwt` passed) ends it, with the reservation.
Each step also holds the lock of `infra/deploy.sh`
(`<state dir>/<project>.lock`), so no second step and no deploy of the
project run at the same time as a step.

**The way back:** after a failed `apply` (the database is then empty, or
missing after a failed `createdb`), or after a restore you do not want,
`infra/restore-db.sh back`, then `apply`, `rotate-jwt` and `start`.
`back` is `prepare` with the copy of the database as it was before the
restore: the copy taken by the last attempt that started web and cms, or,
while an attempt is unfinished, the copy taken before it; the own copy of
a failed or unfinished attempt (an empty or half-restored database) is
skipped. So a failed way back can simply be taken again and leads to the
same copy. Like every `prepare` it writes a new copy first (when the
database exists), and no copy is ever overwritten. Delete the
`infra/backups/before-restore-*.dump` copies once the restored site
works. `--no-owner` makes the restoring user own everything, as the cms
expects.

**To give up before `apply`** (a STOP of `prepare`, or a change of mind;
nothing was dropped): `infra/restore-db.sh cancel`. It ends the attempt
and the reservation and deletes the staged dump; it drops, restores and
starts nothing, so web and cms stay stopped as `prepare` left them, and
it prints the command that starts them with the attempt's compose files
(`docker compose -p infra -f … up -d --no-build web cms`). Once any
`apply` has begun since the reservation was taken, `cancel` refuses, also
after a later `prepare` or `back` passed (the database may be empty,
half-restored or restored without its new secret): only `back` or a
passing `apply`, then `rotate-jwt` and `start`, lead to running apps.

**The compose files** are the ones the project's web and cms containers
were started with, in their order (their compose `config_files` label):
`infra/docker-compose.yml`, then `docker-compose.traefik.yml` of this
checkout's `infra/` when the project runs behind a host Traefik. The
retired `docker-compose.{cms,web}-legacy-tz.yml` of releases before v0.25
stop the step with a recovery note. Web and cms with different lists, a file that is not one of these
(such as `/tmp/cms-direct-start.yml`) or containers that tell nothing
stop the step: `RESTORE_COMPOSE_FILES=<file>:<file>…` (relative to the
checkout) names them then. An attempt keeps the files its `prepare` used;
a later step that would use others stops. **Another compose project** (a
staging copy): `COMPOSE_PROJECT=<name>`, as for `infra/deploy.sh`; it has
its own state, reservation and lock.

**Why `rotate-jwt` is mandatory after every database or `.env` restore,
also with the same images:** a dump holds every user's token version as it
was when it was taken. A password change since then raised it and revoked
that user's older JWTs; the restore lowers it again, so those JWTs, still
unexpired and signed with the same key, would be accepted again (the cms
compares the JWT's version with the stored one,
`apps/cms/src/extensions/users-permissions/strapi-server.ts`). A restored
`infra/.env` can also bring back a `JWT_SECRET` that was rotated since. A
fresh secret makes every JWT signed before the restore invalid: **everyone
is signed out once** and signs in again, local and Microsoft accounts
alike; the admin panel's sessions (`ADMIN_JWT_SECRET`) and the web's own
key (`AUTH_SECRET`) stay. This is the rule of the owner decision of
2026-10-12 for a rollback below batch 13
([Deploying batch 13](archive/deployment-history.md#deploying-batch-13-2026-10-12), R4), applied to
restores.

**When the host lost `infra/.env`:** put the backed-up file back first
(owned by the checkout owner, mode 600). Without it Compose refuses
`stop`, `up` and `config` (the compose file requires its secrets; only
`exec` into a running container still works), and every step stops with
`infra/.env is missing`. Then the four steps as above: the cms does not
start before `rotate-jwt` has replaced the restored secret. When only
`infra/.env` was restored and the database is intact:
`infra/restore-db.sh rotate-jwt --env-only`, then
`infra/restore-db.sh start --env-only` (refused while a database restore
holds the reservation).

The cms then brings the schema up to its own release on boot (it adds what
an older dump lacks). A dump from before v0.25 is refused ([If the cms refuses to boot](#if-the-cms-refuses-to-boot)).

**Why a script** (2026-10-13): the restore was first four shell
functions pasted into the operator's shell and walked twice that morning.
A pasted function cannot fully protect itself: errexit or tracing
inherited from that shell (`set -e`, `set -x`) closes the shell on a stop
or prints the secret, a variable changed between two calls (the dump,
the compose files, an exported `JWT_SECRET`) changes what the next call
does, and the attempt is gone with the shell. The script runs in its own
process with its own options (`set +x` first, then `set -Eeuo pipefail`
and `umask 077`), keeps the attempt on disk, rechecks it at every step
and hands the new secret to `awk` through the environment, never on a
command line. (Under `set -e` in your own shell a STOP, exit 1, still
ends that shell, but nothing is lost: `infra/restore-db.sh status` in a
new one shows the attempt.) `infra/restore-db.test.ts` runs it with docker stubbed
(each case of this section, and the findings of the review of PR #68: a
failing `prepare` after a good one, a database that appears between
`prepare` and `apply`, a state file it did not write, a dump path swapped
after the checks, the reservation, the legacy-zone overlay) and, with
`SINNLOS_SLOW_SHELL_TESTS=1`, against a real Postgres 16 started with the
legacy-zone overlay (a dump cut off in its data, an older dump over a
newer database, a swapped dump path, a failed `createdb` and a failed
restore with their retries and the way back, a compose file that pins
`JWT_SECRET`, an exported one, the `.env`-only pair and a held lock).
`infra/deploy-flow.test.ts` pins `infra/deploy.sh`'s refusal while the
reservation exists, also from a second clone that shares
`DEPLOY_STATE_DIR` while the real script restores in the first.

**Walked on 2026-10-13** on throwaway containers: a compose project in
Traefik mode with a real cms schema (105 tables, the demo data) and a
`backup-run` generation made from it with a throwaway age key, through
the steps of
[Restoring a production generation](#restoring-a-production-generation)
with the commands as written there. After the backup a password change
revoked a JWT, a newer table and an upload were added, and `infra/.env`
was deleted. The drill refused the wrong key and passed with the right
one (105 tables, 10 users); the four components decrypted and matched
`MANIFEST`; the `.env` went back; `prepare` and `apply` ran in a shell
with `set -ex` (`SHELLOPTS` exported) and an exported `JWT_SECRET`,
neither of which changed them (105 tables again, the newer table gone);
the uploads went back (the later upload gone); `rotate-jwt` refused the
exported `JWT_SECRET`, then passed under `set -x` with no secret in the
trace; `start` started web and cms, and the cms container held the
rotated secret. On the restored database the real cms with the new
secret answered 401 to the revoked JWT and to the JWT issued after the
backup and signed the restored password in; with the old secret it had
accepted the revoked JWT again, which is what the rotation prevents. The
same walk passed again after the fixes of the review of PR #68 (the dump
staged and restored from the staged copy, the reservation released by
`start`, the staged copy gone with it).

### Backup uploads volume

The volume of compose project `infra` is `infra_cms_uploads` (project name,
underscore, `cms_uploads`); `docker volume ls | grep cms_uploads` shows it.

```bash
# Copy uploads out of the named volume
docker run --rm \
  -v infra_cms_uploads:/uploads \
  -v "$(pwd)/backups":/backup \
  alpine tar czf /backup/uploads-$(date +%Y%m%d-%H%M%S).tar.gz -C /uploads .
```

Restore (with the cms stopped; extracting into the volume adds and
overwrites files but deletes none, so empty it first, `find /uploads
-mindepth 1 -delete` in the same container, when files created after the
backup must go):

```bash
docker run --rm \
  -v infra_cms_uploads:/uploads \
  -v "$(pwd)/backups":/backup \
  alpine sh -c "cd /uploads && tar xzf /backup/uploads-20260415-120000.tar.gz"
```

### Automated daily backups (cron)

> **Production (since 2026-10-07):** the owner's host backs `sinnlos` up with
> `backup-run` from the `srv-prod-01-ops` repo (nightly at 04:00, and as the
> pre-deploy backup of `infra/deploy.sh`, [INSTALL.md](INSTALL.md)); its
> `docs/backup.md` has the layout and the decrypting, and
> [Restoring a production generation](#restoring-a-production-generation)
> below what sinnlos needs on top. `pg-backup.sh` below stays for other
> hosts and for the pre-deploy backup of another compose project (a staging
> copy).

#### Restoring a production generation

Production's backups are `backup-run` generations in
`/srv/backup/outbox/sinnlos/<YYYYMMDD>T<HHMMSS>Z-<daily|predeploy>/` (UTC;
the newest 7 per kind stay, and the NAS pulls the outbox daily after
04:30). A generation holds:

- `db.dump.zst.age`: `pg_dump -Fc` of `infra-db-1` (Postgres 16; the
  `MANIFEST` names the `db_pg_dump_version`);
- `db-globals.sql.zst.age`: `pg_dumpall --globals-only`, for a new
  Postgres container only (the running one has its roles);
- `uploads.tar.zst.age`: the volume `infra_cms_uploads`, paths relative to
  its root;
- `config.tar.zst.age`: `infra/.env`, stored as
  `home/bigemo/git/sinnlos/infra/.env`;
- `MANIFEST`: the sha256 of every file of the generation, and for each
  component its plaintext size and sha256 (`plain.<component>.bytes`,
  `plain.<component>.sha256`);
- `COMPLETE`, written last: a generation without it must not be used.

Each component is compressed with zstd, then encrypted with **age** (not
GPG). The age private keys are never on the VPS, so decrypting happens off
it, with the commands of `docs/backup.md` in `srv-prod-01-ops`
(`age -d -i <identity> <file>.zst.age | zstd -d > <file>`); this document
does not repeat them. What sinnlos needs around them:

1. **Check the generation** (no key needed): `backup-verify <generation
dir>` passes, i.e. `COMPLETE` names the directory and every file
   matches `MANIFEST`. Off the VPS, where the key is,
   `infra/backup/restore-drill.sh --generation <dir> --identity <age key
file>` checks the same, decrypts and compares every component and
   restores the dump into a throwaway Postgres 16 (the restore drill
   below): a quick proof that the generation is usable, before the real
   restore.
2. **Decrypt** `db.dump` (and `uploads.tar` and `config.tar` when you need
   them) off the VPS into an owner-only directory (`umask 077`), and
   compare every plaintext with the generation: `sha256sum db.dump` must
   print the `plain.db.dump.sha256` value of `MANIFEST`, and so on for the
   others. A mismatch: stop, the file is not what was backed up.
3. **The `.env` first, if the host lost it:** `config.tar` holds
   `home/bigemo/git/sinnlos/infra/.env`. Extract it into a scratch
   directory and put it back as `infra/.env` (owned by `bigemo`, mode 600) before anything else: while it is missing, Compose refuses
   `stop`, `up` and `config` (the compose file requires its secrets). Its
   `JWT_SECRET` is replaced by `infra/restore-db.sh rotate-jwt` below
   before the cms starts. A host that kept its `infra/.env` skips this
   step.
4. **The database:** copy `db.dump` to the host, into the owner-only
   `infra/backups/` of the checkout (`mkdir -p -m 700 infra/backups`
   when it is not there yet), and run
   `infra/restore-db.sh prepare infra/backups/db.dump`, then
   `infra/restore-db.sh apply`
   ([Restoring a database dump](#restoring-a-database-dump): the whole
   dump checked, web and cms stopped, a new copy of the current database,
   a clean database, `pg_restore --exit-on-error --single-transaction`,
   the check). Not with the plain `pg_restore --clean --if-exists` of
   `docs/backup.md`: over the database that runs, that leaves a mixture
   when the schemas differ.
5. **The uploads**, while web and cms are stopped (after `prepare`):
   stream the plain tar into the volume,
   `docker run --rm -i -v infra_cms_uploads:/uploads alpine tar xf - -C
/uploads < uploads.tar`; it adds and overwrites but deletes nothing,
   so empty the volume first (`find /uploads -mindepth 1 -delete` in the
   same container) when files created after the backup must go.
6. **`infra/restore-db.sh rotate-jwt`, then `infra/restore-db.sh
start`** (it starts nothing unless this attempt's restore passed its
   check and `JWT_SECRET` was rotated and verified), then delete the
   host's copy of `db.dump` and every plaintext copy off the VPS. When
   only `infra/.env` was restored: `infra/restore-db.sh rotate-jwt
--env-only` and `infra/restore-db.sh start --env-only`.

The same holds for a `-predeploy` generation after a failed deploy (the update procedure in [UPGRADE.md](UPGRADE.md#update-procedure-production-safe)).

#### Backups with pg-backup.sh (hosts without backup-run)

The repo ships a ready-made script: **`infra/backup/pg-backup.sh`**. It is
the backup for hosts without the owner's `backup-run` (and the pre-deploy
backup of a compose project other than `infra`) and does more than the
manual snippets above:

- dumps Postgres from `infra-db-1` (`pg_dump -Fc --no-owner`) and **verifies**
  the dump with `pg_restore --list` before keeping it;
- tars the `infra_cms_uploads` volume, and copies `infra/.env` (every
  secret; the dumps do not hold it);
- gzips each artifact, then **GPG-encrypts** it to the VPS backup public key
  (asymmetric — a host/NAS compromise can't decrypt; the private key lives
  off-box). gpg runs with `--no-random-seed-file`, so it never reads or
  writes `random_seed` in the keyring (a root run once left a root-owned
  one there, and every later cron run printed `can't open … random_seed:
Permission denied`; such a leftover is ignored now and can be deleted),
  and as root (`deploy.sh`) with `--no-permission-warning`, so the owner's
  keyring no longer draws `unsafe ownership on homedir`;
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
  the cron user and the NAS pull keep reading them, and the offsite dirs
  it creates (`offsite/`, `offsite/sinnlos/`, on a new host or a new
  `SINNLOS_BACKUP_DIR` when a deploy's backup runs before the first
  nightly one) the owner of the backup root. So on a new host the backup
  root must exist, with its keyring (`.gnupg`, `.backup-keyid`), owned by
  the cron user; without it every run stops with `the backup root … does
not exist`;
- **retention**, per series (database, uploads, `.env`; each once for the
  nightly and once for the pre-deploy artifacts): an artifact is removed
  only when it is **older than 7 days** (by the timestamp in its name)
  **and** not among the **newest 7** of its series. Pruning runs after
  each new artifact of a kind (database, uploads, `.env`) is encrypted, and
  then checks both series of that kind, nightly and pre-deploy, each by
  itself (a nightly run also prunes old pre-deploy artifacts and the
  reverse); `backup.log` keeps its last 500 lines. `deploy.sh` runs the script (for a
  compose project other than `infra`) with
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
  cron look fresh. A run that skipped the uploads or the `.env` artifact
  (a wrong `SINNLOS_UPLOADS_VOLUME`, `SINNLOS_ENV_FILE` or checkout path
  leaves the media or the secrets unbacked) is **partial**: it ends with
  `done <kind> partial (skipped: sinnlos-uploads sinnlos-env)`, prints a
  `WARNING` on stderr and refreshes neither file, so the monitor alerts;
  it still exits 0 (the skipped quick-access copy does not count).

It reads its paths from the backup keyring env (`SINNLOS_BACKUP_DIR`,
`SINNLOS_GNUPGHOME`, `SINNLOS_BACKUP_KEYID`), defaulting to the shared
`/home/bigemo/backups/momsbest` keyring. `infra/deploy.sh` runs it once as a
**pre-deploy** snapshot of a compose project other than `infra`; register it nightly with cron:

```bash
# in the crontab of the backup root's owner; set your own backup root and env file
( crontab -l 2>/dev/null ; \
  echo '0 3 * * * SINNLOS_BACKUP_DIR=/path/to/backup-root SINNLOS_ENV_FILE=/opt/sinnlos/infra/.env /opt/sinnlos/infra/backup/pg-backup.sh >> "$HOME/sinnlos-backup.log" 2>&1' ) \
  | crontab -
```

> Self-hosting without the GPG/NAS keyring? Use the manual `pg_dump` + volume-tar
> commands in "Manual Postgres backup" and "Backup uploads volume" on a cron instead, and push the output off-site with
> `rsync`/`rclone`.

The paths come from `SINNLOS_BACKUP_DIR`, `SINNLOS_GNUPGHOME`,
`SINNLOS_BACKUP_KEYID`, `SINNLOS_ENV_FILE`, `SINNLOS_DB_CONTAINER`
(`infra-db-1`) and `SINNLOS_UPLOADS_VOLUME` (`infra_cms_uploads`), plus
`SINNLOS_LOCAL_ENV_BACKUP` (a plaintext quick-access copy, refreshed only
when it exists). The other defaults (`/home/bigemo/backups/momsbest`,
`/home/bigemo/git/sinnlos/infra/.env`,
`/home/bigemo/.sinnlos-env-backup/.env`) fit only the owner's host, which
no longer runs this script for project `infra`: set `SINNLOS_BACKUP_DIR`
and `SINNLOS_ENV_FILE` everywhere else (without the env file every run is
partial; without the backup root it stops).

**Is it running?** `tail -n 5 <offsite>/backup.log` ends with `done nightly`
after 03:00, and `cat <offsite>/last-success` names last night. A `FAIL`
line names the step; the plaintext of that run is already gone. `done
nightly partial (skipped: …)` names the series that run did not back up;
the `skip` lines above it say why (fix the path or volume name). The rule
for a monitor: `last-success` (its modification time, or the time it
starts with) younger than 26 hours; older means the nightly cron stopped
or failed. Only nightly runs write it.

**Restoring an encrypted artifact** of `pg-backup.sh` (hosts without
`backup-run`; on a machine with the private key, never on the VPS;
production: [Restoring a production generation](#restoring-a-production-generation)).
Take the database, uploads and `.env` artifacts of one run (the same
`<ts>[-predeploy]` in their names):

```bash
# Owner-only files in a private directory: the dump and the .env copy hold
# every secret, and a plain `>` would create them with your umask (often 0644).
umask 077
mkdir -m 700 restore && cd restore
gpg --decrypt ../sinnlos-db-<ts>.dump.gz.gpg | gunzip > sinnlos-db-<ts>.dump
gpg --decrypt ../sinnlos-env-<ts>.env.gz.gpg | gunzip > infra.env
```

Then copy the dump to the host, into the owner-only `infra/backups/` of
the checkout, and restore it with `infra/restore-db.sh`
([Restoring a database dump](#restoring-a-database-dump)): a clean
database, one transaction, the check, the fresh `JWT_SECRET`; delete the
host's copy afterwards. The uploads artifact is a
gzipped **plain** tar: once decrypted and gunzipped it is an uncompressed
`.tar`, which `tar xf` reads (the `tar xzf` of "Backup uploads volume" is for its own
`.tar.gz` and fails on it). Stream it into the volume, so no plaintext
copy lands on disk:

```bash
gpg --decrypt ../sinnlos-uploads-<ts>.tar.gz.gpg | gunzip \
  | ssh <host> docker run --rm -i -v infra_cms_uploads:/uploads alpine tar xf - -C /uploads
```

Put `infra.env` back as `infra/.env` of the checkout (owned by the
checkout owner, mode 600) only if the host lost it, and before any other
step (Compose refuses `stop` and `up` without it); its `JWT_SECRET` is
then replaced by `infra/restore-db.sh rotate-jwt` ("Manual Postgres backup") before the cms
starts, because the backed-up file can hold a secret that was rotated
since. Delete the plaintext afterwards
(`cd .. && rm -rf restore`). This procedure was walked verbatim on
2026-10-12 against artifacts of `pg-backup.sh` with a throwaway key and
Postgres 16 (decrypt, the "Manual Postgres backup" steps of that day, the uploads stream, the
`.env`, then `restore-drill.sh --all`).

**Restore drill** (off-box, where the key is; never on the VPS, which
holds no private key): `infra/backup/restore-drill.sh` proves that a
database backup restores. It restores into a throwaway
`postgres:16-alpine` without network and with its data on a tmpfs, which
goes with its volumes on exit, prints the row count of every table and
fails unless `up_users` came back. It knows both kinds of backup.

**Production's `backup-run` generations** (age), with `--generation <dir>
--identity <age key file>`, for a generation of the NAS copy of
`/srv/backup/outbox/sinnlos/`:

- it checks the generation as `backup-verify` does: `COMPLETE` exists and
  names the directory, and `MANIFEST` lists every other file with a
  matching sha256, none missing and none extra; its `generation=` must
  name the directory and its `service=` be `sinnlos`; it warns when the
  generation is older than 36 hours (`MAX_AGE_HOURS`, by its name). The
  format (`# ` comment lines, `key=value` lines, `plain.<component>.bytes`
  and `.sha256`, `<sha256>  <file>` lines) is the one of a real
  production generation of 2026-10-13, whose `MANIFEST` and `COMPLETE`
  the drill read and accepted (with stand-in components) and whose
  tampered variants it refused; the test fixture writes the same shape
  with synthetic values;
- it decrypts every component (`age -d -i <identity> | zstd -d`) into a
  private temporary directory (mode 700, under `TMPDIR`, removed on every
  exit) and compares each plaintext with `plain.<component>.sha256` of
  `MANIFEST`; `db.dump`, `db-globals.sql`, `uploads.tar` and `config.tar`
  must all be there;
- it restores `db.dump` with `pg_restore --exit-on-error
--single-transaction` into the clean throwaway database and prints the
  table counts, counts the roles of `db-globals.sql` (not applied: only a
  new Postgres container needs them), and lists `uploads.tar` (the file
  count and the first 20 names) and `config.tar` (its names, and the
  number of keys of its `.env` files; no value is shown). It never passes
  a name from an archive or a generation to a command: the archives are
  listed, and the `.env` files are read by its own pattern; every file
  name of a generation must follow `backup-run`'s rule
  (`[a-z0-9][a-z0-9._-]*`), and each of the four components is required
  by its exact name.

It needs bash, age, zstd, tar and docker:

```bash
infra/backup/restore-drill.sh --generation /path/to/copy/of/outbox/sinnlos/20261012T180345Z-predeploy --identity <age key file>
```

A wrong identity (`no identity matched any of the recipients`), a changed
or damaged file (`does not match its sha256 in MANIFEST`), a generation
without `COMPLETE`, or a component that decrypts to other bytes than
`MANIFEST` names each fail the drill with that line. The plaintext lands
on this machine's disk for the run (it is checked before the restore):
point `TMPDIR` at an encrypted or in-memory directory if that matters.

**`pg-backup.sh` artifacts** (GPG, hosts without `backup-run`): the drill
picks the newest `sinnlos-db-…dump.gz.gpg` of a directory (the NAS copy
of the offsite dir; nightly and pre-deploy alike) or takes one file,
warns when it is older than 36 hours, and streams `gpg --decrypt | gunzip
| pg_restore --exit-on-error` into the throwaway database (nothing
decrypted touches the disk). It needs bash, gpg, gunzip, tar and docker:

```bash
infra/backup/restore-drill.sh /path/to/copy/of/offsite/sinnlos           # your keyring, gpg asks for the passphrase
infra/backup/restore-drill.sh --key private.asc --passphrase-file pass.txt --all /path/to/copy/of/offsite/sinnlos
```

`--all` also decrypts the uploads and `.env` artifacts of the same run as
the dump (the same `<timestamp>[-predeploy]` in their names) and checks
them (a tar listing and a key count; no value is shown); when either is
missing, a partial run, the drill fails and names it. `--keep` (both
kinds) leaves the container running for a look (`docker exec -it <name>
psql -U drill -d drill`). Run the drill after changes to the backup and
every few months. Its database is a throwaway one that no cms ever uses,
so it needs no new `JWT_SECRET`; a real restore does ("Manual Postgres backup",
`infra/restore-db.sh rotate-jwt`). `infra/backup/restore-drill.test.ts`
runs both kinds with age, zstd, gpg and docker stubbed and, with
`SINNLOS_SLOW_SHELL_TESTS=1`, a generation against real age, zstd and
Postgres 16 (a good one, a wrong identity, a changed file, no
`COMPLETE`).

> **No order needed:** the crontab runs in the **host's** zone, the
> janitors (uploads, search log, and since batch 12 notifications and
> expired ads) from 03:30 to 03:45 **`APP_TIME_ZONE`**
> ([datetime contract](#datetime-contract)). Either may run first: the
> janitors delete only orphaned uploads older than 24 hours and rows 90
> days past their date, which every earlier nightly backup already holds.

### Checking the backup permission (production)

`deploy.sh` takes the pre-deploy backup of project `infra` with
`sudo -n /usr/local/sbin/backup-run --kind predeploy sinnlos` (step 1). The
drop-in `/etc/sudoers.d/backup-run-predeploy` comes from `srv-prod-01-ops`
and holds the rule `bigemo ALL=(root) NOPASSWD: /usr/local/sbin/backup-run
--kind predeploy sinnlos` (production's nightly `backup-run` timer fires at
04:00). It works only while it is the **last** sudoers rule that matches the command
for `bigemo`: sudo applies the last match. A general rule for the user or
one of their groups (`bigemo ALL=(ALL:ALL) ALL`, `%sudo ALL=(ALL:ALL) ALL`)
that `/etc/sudoers` lists **after** its `@includedir /etc/sudoers.d` line,
or a drop-in whose name sorts after `backup-run-predeploy`, wins and asks
for a password; `sudo -n` then stops with `sudo: a password is required`,
and so does the deploy at its backup step. That is how the first batch 12
deploy stopped on 2026-10-12, until the owner moved the `bigemo` line
above the include.

`sudo -n -l /usr/local/sbin/backup-run --kind predeploy sinnlos` proves
**nothing**: it prints the command and exits 0 whenever any rule permits
it, the one that asks for a password included. **The recommended check
before a deploy** (owner decision 2026-10-12) is the command itself, as
`bigemo`, next to the read-only listing (checked with sudo 1.9.17 for both
orders and for a group rule):

```bash
sudo -n /usr/local/sbin/backup-run --kind predeploy sinnlos; echo "backup-run exit $?"
sudo -n -l
sudo awk '/^[[:space:]]*[@#]includedir[[:space:]]/ {inc = NR; next}
  inc && /^[[:space:]]*(bigemo|%)/ {print NR": "$0}' /etc/sudoers
```

- **`sudo -n -l`** (no command; read-only, and no password while one of
  the user's rules is NOPASSWD) lists the user's rules in the order sudo
  checks them. The `(root) NOPASSWD: /usr/local/sbin/backup-run --kind
predeploy sinnlos` line must come **after** every line that also allows
  it, such as `(ALL : ALL) ALL`. This order check is reliable for the
  rules of `/etc/sudoers` and its includes.
- **The `awk` line** shows the cause in the file: it prints every user or
  group rule below the `@includedir` line of `/etc/sudoers` and must print
  nothing (it asks for the password; a group rule matters for the groups
  `id -nG bigemo` lists). It does not see the drop-ins themselves.
- **The command itself** (recommended) is the only end-to-end proof: it
  takes one pre-deploy backup, the same as step 1 of a deploy, so one
  more `-predeploy` generation lands in `/srv/backup/outbox/sinnlos/`
  (`backup-run` keeps the newest 7 per kind, so it never pushes a nightly
  one out). As far as this repo knows it, success
  is `backup-run exit 0`, which is what `deploy.sh` takes as a good
  backup; a missing or losing sudoers rule stops it at once with
  `sudo: a password is required` and exit 1, and any other non-zero exit
  is `backup-run`'s own failure (its output and `docs/backup.md` in
  `srv-prod-01-ops` say why).

## Post-Deployment Verification

After any deployment, run through this smoke test to confirm everything works
end-to-end. Replace `<URL>` with your deployment's base URL
(`http://localhost:3000`, `https://localhost` (Caddy's default without
`DOMAIN`), `http://localhost`, or `https://intranet.example.com`).

### Health checks

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

### Content bootstrap

1. Open `<URL>/admin` → create your first Strapi admin user.
2. **Settings → Users & Permissions plugin → Roles** — confirm all six roles
   exist: `admin_role`, `editor`, `department_head`, `team_lead`, `member`, `guest`.
3. **Content Manager → Department → Create new entry** — create a test
   department (name: "Engineering", slug: "engineering"), save. Departments
   and teams have no Publish step: a save is live.
4. Open `<URL>/departments` → the test department should render.

### Microsoft sign-in flow

Without `ENTRA_ENABLED=1` there is no Microsoft button: check local sign-in
instead (`<URL>/` redirects to `/sign-in`, e-mail + password lands on the
dashboard with your display name in the top-right), and that
`POST <cms>/api/auth/entra/exchange` answers 404. With Microsoft sign-in
configured ([Microsoft Entra ID sign-in](SSO.md#microsoft-entra-id-sign-in)):

1. Open `<URL>/` → you should be redirected to `/sign-in`.
2. Click **Sign in with Microsoft** → complete the Microsoft sign-in.
3. You land on the dashboard with your display name in the top-right.
4. The cms log has one `[entra] user=<id> … result=created role=new->…` line
   (`docker logs infra-cms-1 2>&1 | grep '\[entra\]'`), without any token.
5. In the Strapi admin → **Content Manager → User**, your account exists:
   username `entra-<object id>`, provider `microsoft`, the role of your app
   role (at most `member` in dry-run), _Role source_ `entra`.
6. `/profile` shows name, job title, phone and office as read-only; _Sign
   out_ goes through Microsoft and returns to `/sign-in`.

### Role enforcement (optional)

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

### Common failure signals

| Symptom                                                                                                                                                                                          | Likely cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/admin` returns 502 for 60+ seconds                                                                                                                                                             | Strapi still building admin panel — wait and check `docker compose logs -f cms`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `/sign-in` redirects loop                                                                                                                                                                        | `AUTH_URL` doesn't match the host header — check env vars                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| MS login `AADSTS50011`                                                                                                                                                                           | Redirect URI missing in the Entra app registration — add `<WEB_PUBLIC_URL>/api/auth/callback/microsoft-entra-id` ([Microsoft Entra ID sign-in](SSO.md#microsoft-entra-id-sign-in), step 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Microsoft sign-out ends on Microsoft's "You signed out" page instead of `/sign-in`                                                                                                               | `<WEB_PUBLIC_URL>/sign-in` is not a registered Web redirect URI of the app ([Microsoft Entra ID sign-in](SSO.md#microsoft-entra-id-sign-in), step 2); the intranet session is already gone                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| cms stops at boot with `[entra] ENTRA_ENABLED=1, but the Entra configuration is invalid: …`, or every web request answers 500 with `[auth] ENTRA_ENABLED=1, but …` in the web log                | The named Entra setting is invalid (a tenant `common` or a non-GUID, a short `ENTRA_EXCHANGE_SECRET`, …). Fix it in `infra/.env` (`infra/deploy.sh --check` names the keys) or unset `ENTRA_ENABLED`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `infra/deploy.sh` stops with `ERROR: ENTRA_ENABLED=1, but these Entra settings in infra/.env are invalid: …`                                                                                     | The same check before the deploy ([INSTALL.md](INSTALL.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `infra/deploy.sh` stops with `ERROR: OIDC_ENABLED=1, but these OIDC settings in infra/.env are invalid: …` (or the cms or web refuses to start with an `OIDC_*` message)                         | The named OIDC setting is invalid, or `ENTRA_ENABLED=1` is set as well ([OIDC sign-in](SSO.md#oidc-sign-in-keycloak-authentik-zitadel), configuration table). Fix it in `infra/.env` or unset `OIDC_ENABLED`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| OIDC sign-in lands on `/sign-in` with an `oidc_*` error, or `error=Configuration` right after the button                                                                                         | See [the OIDC sign-in errors](SSO.md#oidc-sign-in-keycloak-authentik-zitadel) (an issuer with a missing or extra trailing slash, authentik without a signing key or with its stock e-mail mapping, a Keycloak role mapper without the client id)                                                                                                                                                                                                                                                                                                                                                                                                                |
| Microsoft sign-in lands on `/sign-in` with _"Microsoft sign-in is unavailable right now"_                                                                                                        | The web log says why: the cms is unreachable, the two `ENTRA_EXCHANGE_SECRET` values differ (401 unauthorized), or `ENTRA_ENABLED` is not `1` for the cms (404); or the cms could not reach Microsoft (its log: `[entra] exchange failed …`). See [the sign-in errors](SSO.md#microsoft-entra-id-sign-in)                                                                                                                                                                                                                                                                                                                                                       |
| Microsoft sign-in lands on `/sign-in` with _"already exists"_                                                                                                                                    | A local account uses the e-mail address; check whose it is, then bind or delete it ([the 409 procedure](SSO.md#an-e-mail-address-that-already-has-an-account-409))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Local sign-in answers "Invalid email or password" for an account created through Microsoft sign-in, although an admin set its password                                                           | The account still has `provider = microsoft`; Strapi's local login only matches `provider = local`. Change **Provider** to `local` in **Content Manager → User** ([upgrade step 2](archive/deployment-history.md#upgrading-to-the-strapi-5551-release-2026-09-25))                                                                                                                                                                                                                                                                                                                                                                                              |
| Local sign-in answers "This provider is disabled"                                                                                                                                                | `ENTRA_ENABLED=1` or `OIDC_ENABLED=1` without `AUTH_LOCAL_ENABLED=1`: the cms refuses password sign-ins (identity provider only). Set `AUTH_LOCAL_ENABLED=1` for a break-glass account. After an image rollback to a cms from before batch 9 that alone does not help: restart this release's cms on it before the rollback, or re-enable the Email provider in the Strapi admin panel afterwards ([Rolling back after switching Microsoft sign-in on](SSO.md#rolling-back-after-switching-microsoft-sign-in-on), step 2)                                                                                                                                       |
| Dashboard shows "0 departments" even after creating one                                                                                                                                          | Strapi permissions — confirm `public` role has `find` access to departments, OR you're signed in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| cms restarts in a loop, log says `[env-guard] placeholder value in … Refusing to start in production`                                                                                            | A secret in the env still holds a template placeholder — generate real values (`infra/deploy.sh --check` names the keys)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| cms log says `[draft-twins] <type> <documentId>: could not create the draft (…)`                                                                                                                 | The boot repair could not give that published entry its draft twin (the reason is in the parentheses; `the pending draft of … links another …` is a saved, unpublished move of a lesson or wiki page: publish or discard that draft, then restart the cms); the cms runs normally and retries on every boot. Fix the named entry before you edit or publish the entries linked to it (its course, lessons, space, pages, parent or child pages): until it has a draft, publishing one of them drops its link to the named entry. See [Upgrading to the draft-twin repair (FX38)](archive/deployment-history.md#upgrading-to-the-draft-twin-repair-fx38), step 8 |
| cms restarts in a loop, log says `[org-dp] departments still holds N draft row(s)` (or `teams`)                                                                                                  | The database still has department/team drafts from an earlier release (not migrated, a pre-migration dump restored, or a roll-forward after an image rollback). The data is untouched; run [One-time: org draft/publish off](archive/deployment-history.md#one-time-org-draftpublish-off) step 0 (preflight), then steps 3 to 7                                                                                                                                                                                                                                                                                                                                 |
| `docker compose up` fails with `… must be set`                                                                                                                                                   | A required key in `infra/.env` is empty (see [INSTALL.md](INSTALL.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Traefik mode: every path answers `404 page not found` (after a hand-run `docker compose up`, or a deploy with a `deploy.sh` from before batch 10; the current preflight refuses such a `DOMAIN`) | `DOMAIN` in `infra/.env` is not the bare public host name (a scheme, a port, a typo, the example host), so no router matches. Correct it and run `docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml up -d --no-build web cms`; an image rollback does not help ([INSTALL.md, Behind your own Traefik](INSTALL.md#behind-your-own-traefik))                                                                                                                                                                                                                                                                                |
| Traefik mode: the site answers 404, or shows another instance's data, after a second Sinnlos stack started behind the same Traefik                                                               | One Sinnlos stack per Traefik: the `sinnlos-*` routers of both stacks conflict (Traefik log: `Router defined multiple times with different configurations`) or their services merge. Stop the second stack and give it its own host or Traefik ([INSTALL.md, Behind your own Traefik](INSTALL.md#behind-your-own-traefik))                                                                                                                                                                                                                                                                                                                                      |
| Every signed-in user lands on `/sign-in?expired=1` right after a deploy                                                                                                                          | Expected once after a `JWT_SECRET` rotation — signing in again fixes it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| web log after a deploy: `Error: Failed to find Server Action "…". This request might be from an older or newer deployment.`                                                                      | Expected and harmless: a browser tab opened before the web restarted submitted a form or pressed a button of the old build. Nothing was written; the tab works after a reload ([UPGRADE.md, Release notes](UPGRADE.md#release-notes), "Expected log lines after a deploy")                                                                                                                                                                                                                                                                                                                                                                                      |
| cms stderr: `(node:N) DeprecationWarning: Calling client.query() when the client is already executing a query is deprecated …`                                                                   | Expected and harmless since the Strapi 5.57 update: the pg driver warns once per process ([UPGRADE.md, Release notes](UPGRADE.md#release-notes))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Every uploaded image/document answers 404                                                                                                                                                        | `INTERNAL_UPLOAD_TOKEN` unset on the cms or different on cms and web                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Sign-in form says "Too many sign-in attempts" for everyone                                                                                                                                       | Strapi's throttle sees one client IP for all users: the edge does not pass the client's `X-Forwarded-For` (see [Production hardening](#production-hardening))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Admin link / `/manage` missing for an admin                                                                                                                                                      | `GET /api/me` failed for that request (check the web log for `[viewer]`), or the web was rolled back past 2026-09-24 and the user has not signed in again ([Rolling back the 2026-09-24 release](archive/deployment-history.md#rolling-back-the-2026-09-24-release))                                                                                                                                                                                                                                                                                                                                                                                            |
| `[digest] misconfigured` / `[digest] skipped: DIGEST_FROM unset` in the cms log                                                                                                                  | SMTP is set without `DIGEST_FROM` or `PUBLIC_WEB_URL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `[datetime] … needs a UTC process` or `… only correct in a UTC process`                                                                                                                          | The cms runs with another `TZ` (a custom compose file or orchestrator). Set `TZ=UTC` ([Datetime contract](#datetime-contract))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `[datetime] The database session runs in "…", not UTC`                                                                                                                                           | A pooler or proxy drops the startup options (PgBouncer in transaction mode, Azure's port 6432): connect the cms to Postgres directly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| cms refuses to start: `DATABASE_URL sets its own \`options\` query parameter …`                                                                                                                  | Remove `options` from `DATABASE_URL` (or include `-c TimeZone=UTC` in it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `[datetime] N column(s) are still timestamp without time zone after two conversion attempts`                                                                                                     | Another session held a lock on those tables (a long `psql` transaction, a dump). End it and restart the cms; the guard converts them then                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| cms refuses to start, or every web page answers 500 with `An error occurred while loading instrumentation hook: APP_TIME_ZONE must be an IANA time zone name …` in the web log                   | Fix `APP_TIME_ZONE` in `infra/.env` (an IANA name such as `Europe/Berlin`, no UTC offset) or leave it empty                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| web log: `[datetime] The web process runs in …, not UTC`                                                                                                                                         | The current web image runs with a `TZ` other than UTC (an orchestrator setting): dates are unaffected, but remove it so the web runs in UTC                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `infra/deploy.sh` stops with `ERROR: docker compose up failed …` (compose: `dependency failed to start: container infra-cms-1 …`)                                                                | The new cms refused to start; `docker logs infra-cms-1` says why. Fix and re-run, or roll back with the commands it prints ([Rolling back this release](archive/deployment-history.md#rolling-back-this-release): before the repair only with the legacy-zone override)                                                                                                                                                                                                                                                                                                                                                                                         |
| `live-smoke: FAIL — timestamp without time zone columns remain`                                                                                                                                  | The guard did not run or failed: check `docker logs infra-cms-1 \| grep datetime`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `live-smoke: FAIL — subscribe: … came back compressed (Content-Encoding: …)`                                                                                                                     | The edge compresses `text/event-stream`, so pings wait in the encoder's buffer: take the compression off the `/live` route                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `live-smoke: FAIL — sign-in as … produced no session cookie (HTTP 302, redirect …error=CredentialsSignin…)`                                                                                      | Wrong password in the demo credentials file, or the account is blocked or locked. On an identity-provider-only instance (Entra or OIDC without `AUTH_LOCAL_ENABLED=1`) live-smoke skips its sign-in steps by itself                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `infra/deploy.sh` stops with `ERROR: another infra/deploy.sh (or an infra/restore-db.sh step) is running for compose project infra`                                                              | A deploy or a restore step of the same project runs (the lock goes with its process); let it finish, then re-run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `infra/restore-db.sh` prints `STOP: …` (exit 1) or, with exit 3, `STOP: another infra/restore-db.sh step or infra/deploy.sh holds the lock …`                                                    | The step changed only what the line says; `infra/restore-db.sh status` shows the attempt and its next step ([Restoring a database dump](#restoring-a-database-dump))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `infra/restore-db.sh start` stops with `STOP: removing the staged dump … failed; web and cms run on the restored database … its cleanup did not finish` (or was interrupted after starting them) | The apps run with the new secret; only the cleanup is left. Fix the cause (for example the permissions of `infra/backups/restore-<attempt>`), then run `infra/restore-db.sh start` again: it finishes the cleanup and ends the reservation, and deploys work again ([Restoring a database dump](#restoring-a-database-dump))                                                                                                                                                                                                                                                                                                                                    |
| `infra/deploy.sh` stops with `ERROR: a database restore of compose project infra is in progress (…/sinnlos-deploy/restore/infra.reservation)`                                                    | A restore (in this clone, or in another one with the same `DEPLOY_STATE_DIR`) holds the reservation from its `prepare` until its `start` passes: finish it (`infra/restore-db.sh status` names the next step), or end it with `infra/restore-db.sh cancel` (only while no `apply` has begun since the reservation was taken); then deploy. Nothing was changed                                                                                                                                                                                                                                                                                                  |
| `infra/deploy.sh` stops with `ERROR: the checkout … has changed tracked files`                                                                                                                   | Commit, stash or revert the listed files, then re-run; nothing was changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `infra/deploy.sh` prints `WARNING: CI is …` (or stops, with `--require-green-ci`)                                                                                                                | GitHub has no green CI run for the checked-out commit yet: not pushed, still running, or failed. Dependabot's own update jobs on the commit do not count (since batch 13; before, they could make a green commit read `pending`)                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `infra/deploy.sh` stops with `failed during '<step>'`                                                                                                                                            | An unexpected error; before `start` the running containers are untouched, from `start` on the rollback commands follow                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `backup.log` has a `FAIL <kind> <step>` line, or `pg-backup: FAILED at …`                                                                                                                        | The backup stopped at that step (its plaintext is removed); a pre-deploy one also stops the deploy. Fix the cause (usually the db container is down or the key is missing) and re-run                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

---

## Enable auto-restart on reboot

Docker containers already have `restart: unless-stopped`. If Docker itself isn't
running on boot:

```bash
systemctl enable docker
systemctl start docker
```

## Production hardening

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
  ago may no longer be there, nor the cms's `[datetime]` boot line (the
  cms logs every request, the healthcheck's included; live-smoke then asks
  `node` in the running cms container for the zone). Check with
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
  the [2026-09-24 upgrade checklist](archive/deployment-history.md#upgrading-from-a-release-before-2026-09-24).
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

**`DATABASE_FORCE_MIGRATION` removes only what one tracked schema change
removes.** The compose file lists the cms environment explicitly and does
not pass this variable, so a line in `infra/.env` has no effect, and
`infra/deploy.sh` (which uses only the two live compose files) never sets
it. What it does (`@strapi/database` 5.55.1): a boot syncs the schema only
when the schema's hash changed since the last boot or a migration ran
(`dist/schema/index.js`, `sync`); the sync then removes only the tables,
columns, indexes and foreign keys that the **stored previous** schema
tracked and the new one lacks (`dist/schema/diff.js`), and only with the
flag set (`dist/schema/builder.js`, `dropColumn`, `dropTable`, `dropIndex`).
After a boot with the flag off, the stored schema no longer lists what that
release dropped from its schema: those columns and tables stay in the
database for good, untracked, and no later boot with the flag removes them,
whether the schema changed again or not. So the flag matters only on the one
boot that changes the schema (and must stay off when rolling back to an
older image, [Rolling back the Strapi 5.55.1 release](archive/deployment-history.md#rolling-back-the-strapi-5551-release-2026-09-25)).
Cleaning up what earlier deploys left behind is **manual work for the
owner**, with the listing and the SQL below. To set the flag for one boot
anyway, write an override outside the checkout and leave it off again
afterwards:

```bash
cat > /tmp/force-migration.yml <<'YML'
services:
  cms:
    environment:
      DATABASE_FORCE_MIGRATION: "true"
YML
COMPOSE=(docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml)
"${COMPOSE[@]}" -f /tmp/force-migration.yml up -d --no-build cms
# once the cms is up: the same without the override, then remove it
"${COMPOSE[@]}" up -d --no-build cms
rm /tmp/force-migration.yml
```

**Leftovers of earlier deploys** (owner only, after a backup). The listing
is read-only: it compares the live tables and columns with the schema the
cms stored at its last boot (`strapi_database_schema`) and prints what the
stored schema does not track (Strapi's own bookkeeping tables excluded):

```bash
"${COMPOSE[@]}" exec -T db sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
WITH stored AS (SELECT schema::jsonb AS s FROM strapi_database_schema ORDER BY time DESC LIMIT 1),
tracked_columns AS (
  SELECT t->>'name' AS table_name, c->>'name' AS column_name
  FROM stored, jsonb_array_elements(s->'tables') t, jsonb_array_elements(t->'columns') c),
tracked_tables AS (SELECT DISTINCT table_name FROM tracked_columns)
SELECT 'column' AS kind, col.table_name, col.column_name
  FROM information_schema.columns col
  JOIN tracked_tables tt USING (table_name)
 WHERE col.table_schema = current_schema()
   AND NOT EXISTS (SELECT 1 FROM tracked_columns tc
                    WHERE tc.table_name = col.table_name AND tc.column_name = col.column_name)
UNION ALL
SELECT 'table', tab.table_name, NULL
  FROM information_schema.tables tab
 WHERE tab.table_schema = current_schema() AND tab.table_type = 'BASE TABLE'
   AND tab.table_name NOT IN (SELECT table_name FROM tracked_tables)
   AND tab.table_name NOT IN ('strapi_database_schema', 'strapi_migrations', 'strapi_migrations_internal')
ORDER BY 1, 2, 3;
SQL
```

Each row is a candidate, not a verdict: decide per row (a table such as
`datetime_migration_audit` is kept on purpose until its own runbook drops
it). For the rows you remove, write the statements yourself, preview them
in a transaction that rolls back, and only then run them for real:

```bash
"${COMPOSE[@]}" stop web cms
"${COMPOSE[@]}" exec -T db sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
BEGIN;
ALTER TABLE <table> DROP COLUMN <column>;   -- one line per reviewed row
-- DROP TABLE <table>;                      -- a reviewed leftover table
SELECT table_name, column_name FROM information_schema.columns
 WHERE table_schema = current_schema() AND table_name = '<table>';
ROLLBACK;                                    -- the preview; COMMIT only in the real run
SQL
```

The preview prints the table's columns as they would be and changes
nothing. For the real run replace `ROLLBACK` with `COMMIT`, run the listing
again (the removed rows are gone, nothing else changed), start the cms
(`"${COMPOSE[@]}" up -d --no-build web cms`) and check its log for errors:
the cms never reads an untracked column, so it boots as before.

## Datetime contract

How times are stored and computed (deep-dive decision 04; phase 1 covers
the cms and the database, phase 2 the web):

- **Instants** (a point on the timeline: `createdAt`, event `start`/`end`,
  poll `closesAt`, …) are Strapi `datetime` fields, stored as Postgres
  `timestamptz(6)` and sent as ISO-8601 in UTC with `Z`. Clients must send
  instants with `Z` or an offset. The cms's own code reads instants only
  through its time module, which rejects an offset-less value (a vote
  against such a `closesAt` counts the poll as open). Since batch 15 (lane
  15B, DT-OFFSETLESS) every Document Service write refuses one as well:
  the content API, the admin panel and scripts answer 400 `ValidationError`
  "Instants need Z or an offset (e.g. 2026-10-01T07:00:00.000Z): <fields>"
  instead of storing the value read in the process zone (UTC). Raw
  `strapi.db.query` writes are not covered; the cms's own code passes Date
  objects or ISO-Z there. The web and the admin panel always send `Z`.
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
UTC`) when its `TZ` is set to something else.
- **The guard.** Strapi creates every new `datetime` column as
  `timestamp without time zone`. At each boot the cms converts every such
  column of the app schema (`DATABASE_SCHEMA`, default `public`) to
  `timestamptz` right after Strapi's schema sync, one short transaction per
  table (lock timeout 5 s, statement timeout 60 s), reads the stored wall
  clock as UTC, and logs `[datetime] converted N column(s) …`. It **refuses to
  start** when a column is still naive after a retry, when the process is not
  in UTC while there is something to convert, when a boot creates or changes
  the schema in a non-UTC process, when the database session is not in UTC,
  or when a naive app column holds data written before the contract.
  The schema check runs in Strapi's `beforeSync` hook, before any migration,
  DDL or schema-sync write (`[datetime] This boot runs database migrations /
changes the database schema and needs a UTC process …`); a check after
  the sync stays as a backstop. A boot refused by that backstop may already
  have applied DDL; a start with `TZ=UTC` finishes it. An ordinary restart
  in a non-UTC process only warns. On SQLite (local development) all of
  this is skipped.
- **Databases written before the contract** are no longer repaired: since v0.29 the cms refuses to start on them and changes nothing ([UPGRADE.md](UPGRADE.md#supported-upgrade-path)).
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
- **Cron and backups.** The janitors run from 03:20 to 03:56 (03:30 /
  03:35 since the start, 03:40 / 03:45 since batch 12, the audit janitor
  at 03:50 since batch 15, 03:20 / 03:25 / 03:52 / 03:54 / 03:56 since
  v0.28), the scheduled publisher every minute (batch 15), the training
  reminders at 06:45 and the digest at 07:30 `APP_TIME_ZONE`. The nightly
  backup may run before or after the janitors: they delete only rows and
  files past their retention or of documents deleted for good
  ([data-protection.md](data-protection.md)), which every earlier nightly
  backup holds (production's
  `backup-run` runs at 04:00). The scheduled publisher changes current
  content like a manual publish in the same minute; `pg_dump` takes a
  consistent snapshot.
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

| Var                 | On CMS | On Web | Purpose                                                          |
| ------------------- | :----: | :----: | ---------------------------------------------------------------- |
| `REVALIDATE_SECRET` |   ✓    |   ✓    | Shared secret for `/api/live/emit`; must match on both sides     |
| `WEB_INTERNAL_URL`  |   ✓    |   —    | How the CMS reaches Next.js (compose: `http://sinnlos-web:3000`) |

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

## Meilisearch (optional search)

Off by default. With it on, the ⌘K search answers typos ("Brandshutz" finds
"Brandschutz"), matches several words in any order and ranks title hits first,
for announcements, wiki pages, documents, events and polls. People,
departments, teams and wiki spaces stay on the built-in search.

**How it works.** Meilisearch only ranks. The web server asks it for
candidate ids (search-only key, server side), then reads exactly those
through Strapi with the user's own JWT, so every read rule (department
audiences, announcement targeting and expiry, wiki spaces, guests, drafts)
still decides what anyone sees; nothing from the index reaches the browser.
While Meilisearch is off, unreachable, slow or empty, the web answers with
its built-in search. The cms keeps the index `sinnlos_search` current: about
once a minute it checks for changes and rebuilds into `sinnlos_search_build`,
then swaps it in. The index holds published content only and is rebuilt from
the database at any time, so it needs no backup.

| Variable                  | Where                | Purpose                                                                                              |
| ------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `COMPOSE_PROFILES=search` | infra/.env (compose) | starts the `meili` container (`sinnlos-meili:7700`, project network only, no port, no Traefik route) |
| `MEILI_MASTER_KEY`        | meili only           | 16+ characters (`openssl rand -hex 32`); never handed to cms or web                                  |
| `MEILISEARCH_ENABLED`     | cms + web            | `1` switches the module on; anything else is off                                                     |
| `MEILISEARCH_URL`         | cms + web            | default `http://sinnlos-meili:7700`                                                                  |
| `MEILISEARCH_WRITE_KEY`   | cms                  | rebuilds the index (index, document, settings and task actions)                                      |
| `MEILISEARCH_SEARCH_KEY`  | web                  | `search` on `sinnlos_search` only                                                                    |

**Switch it on** (each step is a normal deploy; `infra/deploy.sh` refuses
`MEILISEARCH_ENABLED=1` without the profile and the keys, and the profile
without a usable master key):

1. In `infra/.env`: `COMPOSE_PROFILES=search` and `MEILI_MASTER_KEY=` a fresh
   `openssl rand -hex 32`. Deploy: the `meili` container starts; the search
   stays as it was.
2. Create the two restricted keys: `COMPOSE_PROJECT=infra
infra/meilisearch/provision-keys.sh`. It runs inside the `meili`
   container with that container's master key and prints
   `MEILISEARCH_WRITE_KEY=…` and `MEILISEARCH_SEARCH_KEY=…`; put both lines
   into `infra/.env`. The key uids are fixed, so a re-run prints the same
   values (a new master key gives new ones).
3. `MEILISEARCH_ENABLED=1` in `infra/.env`, deploy. cms and web are
   recreated; within about a minute the cms has built the index.

**Switch it off / roll back:** `MEILISEARCH_ENABLED=0` (or remove it) and
deploy: cms and web go back to the built-in search, nothing else changes.
To stop the container as well, remove `search` from `COMPOSE_PROFILES`, then
`docker compose -p infra -f infra/docker-compose.yml -f
infra/docker-compose.traefik.yml --profile search rm -sf meili`. The volume
`infra_meili_data` only holds the rebuildable index; delete it when the
module is not coming back.

**After a database restore** nothing is needed: the next minute's check sees
the changed content and rebuilds the index. Until then a stale hit is
harmless, because Strapi drops anything gone or hidden.

**Resources:** `mem_limit: 512m`, one CPU, one indexing thread with
`MEILI_MAX_INDEXING_MEMORY=256MiB`; idle use is well below 100 MB at
intranet size. The container runs as root (the image has no user and its
data directory is root's) with every Linux capability dropped and
`no-new-privileges`.

**Upgrading Meilisearch:** the image is pinned by version and digest in
`infra/docker-compose.yml`. A newer Meilisearch may not open an older data
volume; since the index is rebuildable, the simplest upgrade is: bump the
pin, stop the container, delete `infra_meili_data`, deploy. The keys are
gone with the volume: run `provision-keys.sh` again and update
`infra/.env` (deploy once more), or keep the volume and use Meilisearch's
own dump/import.

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
[Microsoft Entra ID sign-in](SSO.md#microsoft-entra-id-sign-in)).

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
