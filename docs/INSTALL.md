# Installing sinnlos

The supported path for a new installation:

- one Linux host (amd64, 2 vCPU, 4 GB RAM, 20 GB disk);
- Docker Engine 24 or newer with the compose plugin;
- the bundled Caddy at the edge, which gets its TLS certificate from Let's Encrypt.

This page uses the bundled Caddy; any Linux host with Docker works. Behind a host Traefik: [Behind your own Traefik](#behind-your-own-traefik) at the end of this page. Upgrades: [UPGRADE.md](UPGRADE.md). Operation, monitoring and restore: [OPERATIONS.md](OPERATIONS.md). Sign-in with Entra or OIDC: [SSO.md](SSO.md).

Every command below runs on the host as the **deploy user**, the user that owns the checkout, unless it says otherwise.

## 1. The host

- **Packages:** `git`, `curl`, `openssl`, `gpg`, `bash` and `flock` (from util-linux).
- **Deploy user:** a user in the `docker` group, for example `sudo adduser deploy && sudo usermod -aG docker deploy`.
- **DNS:** an A and/or AAAA record for your domain that points to the host.
- **Firewall:** ports 80 and 443 open.

## 2. The code

```sh
git clone --branch v0.30.1 https://github.com/yurtbayemre/sinnlos.git
cd sinnlos
```

Use the newest release tag listed under the repository's Releases.

## 3. Configuration: `infra/.env`

```sh
cp infra/.env.example infra/.env && chmod 600 infra/.env
for key in DATABASE_PASSWORD API_TOKEN_SALT ADMIN_JWT_SECRET TRANSFER_TOKEN_SALT JWT_SECRET \
  ENCRYPTION_KEY AUTH_SECRET REVALIDATE_SECRET INTERNAL_UPLOAD_TOKEN; do
  sed -i "s|^${key}=.*|${key}=$(openssl rand -hex 32)|" infra/.env
done
sed -i "s|^APP_KEYS=.*|APP_KEYS=$(openssl rand -hex 16),$(openssl rand -hex 16)|" infra/.env
```

Then edit `infra/.env`. The comments in the file explain every key.

- **Domain:** `DOMAIN` (your host name), `WEB_PUBLIC_URL` and `CMS_PUBLIC_URL` (both `https://<DOMAIN>`).
- **`ADMIN_ALLOW_CIDRS`:** the networks allowed to reach the Strapi admin panel, for example your office or VPN range (`203.0.113.0/24`). Set it **before** you open `/admin`. Empty keeps the panel closed from outside; you then reach it through the SSH tunnel in section 8.
- **First Strapi super-admin:** `STRAPI_ADMIN_EMAIL` and `STRAPI_ADMIN_PASSWORD` create it on the first boot. Remove both values afterwards.
- **E-mail:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `DIGEST_FROM` as a sender address your mail server accepts. Invitations and password-reset links need it. The server needs a certificate the cms trusts (a publicly signed one); with a self-signed STARTTLS certificate every mail fails (`ESOCKET` in the cms log).
- **Second factor:** `MFA_REQUIRED_ROLES` stays empty for the default: admins and editors sign in with an authenticator app as well (section 6). `ENCRYPTION_KEY` encrypts those app secrets, so it belongs in your `.env` backup.
- **Language and time:** `DEFAULT_LOCALE` (`de` or `en`) and `APP_TIME_ZONE`. E-mails (invitations, password links, digests) follow `DIGEST_DEFAULT_LOCALE` (default `en`): set it to `de` for a German instance.
- **Your links:** `PRIVACY_URL`, `IMPRINT_URL` and, optionally, `WHISTLEBLOWING_URL`: a link to your reporting channel, since sinnlos has no channel of its own. If you change the code, also set `SOURCE_URL` to the source of the version you run (AGPL-3.0, §13).
- **Branding (optional):** `SITE_NAME` (the instance name in titles, the sidebar, the sign-in page, e-mail subjects and the authenticator app; at most 40 characters), `SITE_LOGO_URL` and `SITE_ICON_URL` (`https://` addresses; visitors' browsers fetch them before sign-in, so host them yourself) and `SITE_ACCENT` (`#rrggbb`; a colour that fails the contrast checks falls back to the default with a warning). Unset keeps the default look. The footer always names sinnlos and its source.
- **Single sign-on (optional):** Microsoft Entra ID or one OIDC provider, see [SSO.md](SSO.md). SSO users get their second factor from the identity provider; `MFA_REQUIRED_ROLES` applies to password accounts only.
- **`SITE_ALLOW_CIDRS`** stays empty. It closes the whole site to everyone outside the listed networks, for a restore ([OPERATIONS.md, Restore](OPERATIONS.md#restore)).
- **Modules and data protection:** `FEATURES_OFF` switches off modules you do not use (`events`, `training`, `marketplace`, `kudos`, `celebrations`, `polls`, `duty-plans`, `kpis`) and the features `read-confirmations`, `training-reports` and `search-logging`; empty keeps everything on. `TRAINING_EVIDENCE_RETENTION_YEARS` (3) and `SEARCH_LOG_RETENTION_DAYS` (90) set two retention periods. Hand [data-protection.md](data-protection.md) (German) to your data-protection officer and works council: it lists every data class, who sees it, when it is deleted, and how export and anonymisation work.

`infra/deploy.sh --check` validates the file and changes nothing.

## 4. Backups: `infra/deploy.env` and a GPG key

Every deploy starts with a backup, the first install excepted, so set the backup up now. `infra/backup/pg-backup.sh` writes three encrypted artifacts into `SINNLOS_BACKUP_DIR/offsite/sinnlos`: the database, the uploads, and `infra/.env`.

1. **Create the key on another machine.** For example: `gpg --quick-gen-key "sinnlos backup" rsa4096 encrypt never`. Export only its public key, with `gpg --export --armor <key id> > backup-public.asc`. The private key and its passphrase never go on the host.
2. **On the host:**

   ```sh
   sudo install -d -o deploy -m 700 /srv/sinnlos-backup
   GNUPGHOME=/srv/sinnlos-backup/.gnupg gpg --import backup-public.asc
   echo "<key id>" > /srv/sinnlos-backup/.backup-keyid
   cp infra/deploy.env.example infra/deploy.env && chmod 600 infra/deploy.env
   ```

   In `infra/deploy.env`, keep `COMPOSE_PROJECT=infra` and `SINNLOS_BACKUP_DIR=/srv/sinnlos-backup`. The file explains its other keys.

3. **Nightly cron of the deploy user** (`crontab -e`). The script reads `infra/deploy.env` itself:

   ```
   0 3 * * * /home/deploy/sinnlos/infra/backup/pg-backup.sh
   ```

4. **Off-site copies:** copy `/srv/sinnlos-backup/offsite/sinnlos` off the host (rsync, a NAS pull). Keep copies of `infra/.env` and `infra/deploy.env` somewhere safe too.
5. **Restore drill:** run it once a month on the machine that holds the private key: `infra/backup/restore-drill.sh --all /path/to/copy/of/offsite/sinnlos`. It restores into a throwaway Postgres and checks all three artifacts. If it names a missing uploads or `.env` artifact, the newest set is a partial run (for example a refused pre-deploy backup, see `backup.log`): give it the database file of a complete set instead, or run it again after the next nightly backup.
6. **Monitoring:** `infra/ops-check.sh` warns when the newest backup is too old ([OPERATIONS.md, Monitoring](OPERATIONS.md#monitoring)).

## 5. First deploy

```sh
infra/deploy.sh --record-without-live-smoke
```

The deploy builds both images from the checkout, which takes 5 to 10 minutes. It starts the stack and checks `https://<DOMAIN>`.

`--record-without-live-smoke`: the end-to-end probe of live updates (`infra/live-smoke.sh`) needs two accounts, which a new installation does not have yet (section 9). Without the probe, the flag still lets the deploy count as the next rollback target.

## 6. The first intranet admin

The Strapi super-admin from section 3 can use the admin panel, but it is not an intranet account. Create the first intranet admin once:

1. Open `https://<DOMAIN>/admin`, from an allowed network or through the tunnel (section 8), and sign in as the super-admin.
2. Go to **Content Manager → User** (users-permissions) → **Create new entry**:
   - fill in username, e-mail and a password of at least 12 characters (common passwords are refused);
   - set **confirmed** on and **blocked** off;
   - set **role** to **Admin** (`admin_role`).

   Save.

3. Sign in to `https://<DOMAIN>` with that e-mail address. As an admin you set up the second factor right away: scan the QR code with an authenticator app (Aegis, 2FAS, Google or Microsoft Authenticator), enter the current password and a code, and keep the ten recovery codes somewhere safe. Departments, teams and users are managed at **/manage**.

Everyone else gets an invitation: **/manage/users → Invite people** (German: _Personen einladen_), for one person or several at once. The e-mail carries a link to set a password, valid for 7 days. Accounts can also come from your identity provider (Microsoft Entra ID or OIDC, see [SSO.md](SSO.md)). Do not grant the content-API roles the generic user permissions.

### Passwords and the second factor

- **Passwords** need at least 12 characters and must not be a common one. A forgotten password: **/forgot-password** on the sign-in page mails a reset link, valid for 1 hour; an admin can also send one with **Send a password reset link** (_Link zum Zurücksetzen senden_; for an invitation without a password: **Send the invitation again**) on the user's page at /manage/users.
- **Second factor:** admins and editors (`MFA_REQUIRED_ROLES`) set it up at their first sign-in; everyone else can turn it on at **/profile**. Each sign-in then asks for a code from the app, or for one of the recovery codes (each works once).
- **A lost phone:** an admin opens the user at /manage/users and chooses **Reset two-factor sign-in** (_Zwei-Faktor-Anmeldung zurücksetzen_); the user sets it up again at the next sign-in.
- **The only admin is locked out** (phone and recovery codes gone): on the host, as the deploy user, run `infra/mfa-reset.sh <email>`. It clears the second factor of exactly that account and signs it out everywhere.
- **`ENCRYPTION_KEY`:** the app secrets are encrypted with it. With a different key no code works (recovery codes still do); after a deliberate change, run `infra/mfa-reset.sh` for every account that had a second factor.

## 7. E-mail check

In the admin panel, go to **Settings → Email → Send test email**. The daily or weekly digests, the reminders, the invitations and the password links use the same SMTP settings.

## 8. Strapi admin panel through an SSH tunnel

Use this when the panel is closed from outside (`ADMIN_ALLOW_CIDRS` empty) and you need it.

1. **On the host:**

   ```sh
   infra/admin-tunnel.sh start
   ```

   The script prints the exact `ssh` line for step 2. It starts a small forwarder inside the cms container that only the host itself can use. The forwarder stops after 60 minutes (`ADMIN_TUNNEL_MINUTES`), or when the cms restarts.

2. **On your computer** (Linux, macOS, or Windows 10/11 PowerShell, which includes OpenSSH): the printed line, for example

   ```sh
   ssh -N -L 1337:172.18.0.4:1338 deploy@intranet.example.com
   ```

   It shows no output while the tunnel is open.

3. **In your browser:** `http://localhost:1337/admin`.
4. **When you are done:** press Ctrl-C in the `ssh` window, then run `infra/admin-tunnel.sh stop` on the host.

Nothing changes in `infra/.env`, and the panel stays closed from outside the whole time.

## 9. Upgrades

The supported path, every release's notes and rollback: [UPGRADE.md](UPGRADE.md). In short:

1. Read the release notes of the new version, especially the "Upgrade notes" and "Breaking changes" sections.
2. Check out the new version: `git fetch --tags && git checkout v<new version>`.
3. Run `infra/deploy.sh --record-without-live-smoke`. It runs the preflight, the backup, the build, the start and the smoke check.
4. If the deploy fails after the start, `deploy.sh` prints the rollback commands. They switch back to the previous images. Restore the database only when the release notes say a rollback needs it ([OPERATIONS.md, Restoring a database dump](OPERATIONS.md#restoring-a-database-dump)).

Optional live-smoke, the end-to-end check of live updates. It signs in as two accounts of yours, so invite two local accounts for it (section 6), and publish at least one announcement they can see. **Both must be outside `MFA_REQUIRED_ROLES`** (not admins or editors): the script cannot type a second-factor code.

- **`SMOKE_EMAIL`** holds the live stream. Best the author of a published announcement (a department head, for example): the check then covers the notification as well; otherwise it says so in a warning.
- **`SMOKE_AUTHOR_EMAIL`** posts one `[live-smoke]` comment on that announcement, and the script deletes it again. A member is enough.

In `infra/deploy.env`:

```
SMOKE_EMAIL=smoke-reader@intranet.example.com
SMOKE_AUTHOR_EMAIL=smoke-author@intranet.example.com
PASSWORDS_FILE=/home/deploy/.sinnlos-smoke-accounts.txt
```

`/home/deploy/.sinnlos-smoke-accounts.txt` (mode 600) holds one line per account, the address and the password separated by a space or a tab:

```
smoke-reader@intranet.example.com <password>
smoke-author@intranet.example.com <password>
```

Each deploy then runs the check and no longer needs `--record-without-live-smoke`.

### Published images (later)

Once the project publishes release images, `DEPLOY_IMAGE_SOURCE=registry` in `infra/deploy.env` pulls `ghcr.io/yurtbayemre/sinnlos-{web,cms}:<version>` of the checked-out tag instead of building. `deploy.sh` refuses images whose labels name another commit or version. Before publication starts, the third-party notices and the Strapi Enterprise packages in the cms image are under review, so until then build mode is the only path. Verify a published image with:

```sh
gh attestation verify oci://ghcr.io/yurtbayemre/sinnlos-cms:<version> --owner yurtbayemre
```

## Restore

On the machine with the private key, decrypt the artifacts:

- **Database:** `gpg --decrypt sinnlos-db-<ts>.dump.gz.gpg | gunzip > sinnlos.dump`. Copy the result to the host, into the checkout directory, or give `restore-db.sh` its full path.
- **Uploads:** the uploads artifact is a tar of the `infra_cms_uploads` volume. Untar it into the volume while cms and web are stopped: `docker run --rm -i -v infra_cms_uploads:/uploads alpine tar xf - -C /uploads < uploads.tar`.
- **Configuration:** the `.env` artifact holds the `infra/.env` of that day.

Then restore step by step as [OPERATIONS.md, Restore](OPERATIONS.md#restore) describes. It closes the site first, closes it again after the configuration restore, repeats every anonymisation that is newer than the backup ([data-protection.md](data-protection.md), section 5), and opens the site only after the search cleanup.

The backup and restore tools in detail: [OPERATIONS.md, Backup & Restore](OPERATIONS.md#backup--restore).

## Behind your own Traefik

The live host fronts the **same** db/cms/web containers with the host's existing
Traefik instead of the bundled Caddy. The second compose file
`docker-compose.traefik.yml`:

- gives the bundled `caddy` service the `manual` profile so it does **not** start;
- attaches `web` + `cms` to the external `frontend` Docker network (the network
  Traefik watches — it must already exist: `docker network create frontend`);
- adds Traefik router/middleware labels that mirror the Caddyfile routing
  (`/api/auth/*` → web, Strapi paths → cms, everything else → web), terminate TLS
  via the `lehttp` certresolver, and apply the security headers + rate limits
  described in [OPERATIONS.md, Production hardening](OPERATIONS.md#production-hardening).

**`DOMAIN` is required here.** Every router matches ``Host(`$DOMAIN`)`` from
`infra/.env`, so the overlay file is the same for every instance (it named
`sinnlos.yurtbay.dev` literally until batch 10). Set it to the bare host name,
without scheme or port, equal to the host of `WEB_PUBLIC_URL`. Without it
`docker compose` refuses to render the file
(`required variable DOMAIN is missing a value`), and `infra/deploy.sh` stops in
its preflight before anything is touched.

**`infra/deploy.sh` checks the value.** Compose only rejects a missing or
empty `DOMAIN`. A value with a scheme (`https://…`), with a port, with a
typo, or the example `intranet.example.com` renders fine, and then no
router matches: the whole site answers Traefik's `404 page not found`, and
the image rollback of a failed smoke check does not help, because the
router rules come from `infra/.env`, not from the images. So the preflight
of `infra/deploy.sh` (and `--check`) reads the host the routers will match
from the rendered labels and refuses the deploy, before anything is
touched, unless all five routers match one host that is a bare host name
(no scheme, port, path or blank), not a placeholder (`example.com`,
`.org` and `.net` and their subdomains, the `.example` and `.invalid`
names, `change-me`, `your-domain`), and the host of both `WEB_PUBLIC_URL`
and `CMS_PUBLIC_URL`, since the overlay serves web and cms on that one
host (`ERROR: DOMAIN in infra/.env does not fit this instance:` and the
reasons). A wrong `DOMAIN` that went live some other way (a hand-run
`docker compose up`, a typo that is also in both URLs) shows the same
symptom: correct `DOMAIN` and recreate web and cms with the corrected
labels:
`docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml up -d --no-build web cms`.
To see what compose renders (it prints five times the same host, yours):

```bash
docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
  config --format json | grep -o 'Host(`[^`]*`)' | sort | uniq -c
```

The smoke checks follow `DOMAIN`: `deploy.sh` curls `SMOKE_URL`, by default
`https://$DOMAIN` (the host its preflight checked; `--check` prints both),
and hands the same URL to `infra/live-smoke.sh` as `BASE_URL`. The smoke
check (v0.30) asks `<SMOKE_URL>/healthz` and passes only on HTTP 200 with
the body `{"status":"ok"}` and a complete transfer; it follows no
redirect, so it proves the chain edge → web → cms → database. Run by hand,
live-smoke takes `BASE_URL`, or else `https://$DOMAIN`, with `DOMAIN` from
the environment or from the `infra/.env` next to it. Until batch 10 both
defaulted to the owner's `https://sinnlos.yurtbay.dev`, so on another
instance an older checkout's deploy tested the owner's site.

**One Sinnlos stack per Traefik.** The router, service and middleware names
are fixed (`sinnlos-*`), and a Traefik docker provider keeps one set of names
for every container it watches. A second instance (the employer instance, a
staging copy such as the [Entra dry-run](SSO.md#staging-dry-run-then-on)) needs its
own host or its own Traefik; never start it behind the production Traefik.
With a different `DOMAIN`, the routers of both stacks conflict and Traefik
drops all of them (both sites answer 404; the Traefik log says
`Router defined multiple times with different configurations`). With the same
`DOMAIN`, the same-named services merge their servers, and production requests
are load-balanced onto the other stack's containers and database. Neither
case fails at deploy time.

The routers, highest priority first (a request goes to the highest-priority
router whose rule matches; `infra/routing-parity.test.ts` pins all of them):

| Router           | Rule (besides the host)                                                                                                                        | Priority | Target | Middlewares                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ | ---------------------------------------- |
| `sinnlos-auth`   | `PathPrefix(/api/auth)`                                                                                                                        | 100      | web    | headers, ratelimit, compress             |
| `sinnlos-signin` | `POST` on `/sign-in` or `/register`                                                                                                            | 90       | web    | headers, authlimit, compress             |
| `sinnlos-cms`    | `/api`, `/admin`, `/upload`, `/upload/…`, `/email`, `/content-manager`, `/content-type-builder`, `/users-permissions`, `/i18n`, `/content-api` | 50       | cms    | cms-headers, cms-ratelimit, cms-compress |
| `sinnlos-live`   | `PathPrefix(/live/)` (the SSE stream and subscribe)                                                                                            | 10       | web    | headers only                             |
| `sinnlos-web`    | everything else, `/uploads/…` included                                                                                                         | 1        | web    | headers, compress                        |

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
cd ~/sinnlos
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

Every deploy runs as the checkout owner (from a root shell as
`sudo -u <owner> -H infra/deploy.sh`); the owner needs docker access and the
sudoers rule for the pre-deploy backup (step 1,
[Checking the backup permission](OPERATIONS.md#checking-the-backup-permission-production)).

`deploy.sh` does, in order:

0. An env preflight that stops before anything is touched
   (`infra/deploy.sh --check` runs only this step, see
   [deployment-history.md, Upgrading an existing instance to this release](archive/deployment-history.md#upgrading-an-existing-instance-to-this-release)), then the deploy
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
   none, a private one needs read access to Actions). Since v0.30 it looks
   for the run of the CI workflow (`ci.yml`) for the **push to `main` at the
   exact commit**; the newest such run decides, and only a completed,
   successful one passes (skipped, neutral, failed or pull-request runs do
   not). Every push to `main` runs the whole CI, so a deploy right after a
   merge reads pending until that run finishes. The line reads
   `CI: the CI run for the push to main passed for <sha12> (<run url>)`.
   The script reads the answer with a small awk JSON scanner (no `jq` or
   `gh` on the host).
1. A pre-deploy Postgres + uploads + `.env` backup. Project `infra`
   (production, since 2026-10-07): the host's `backup-run` from the
   `srv-prod-01-ops` repo, as
   `sudo -n /usr/local/sbin/backup-run --kind predeploy sinnlos` (a
   `-predeploy` generation of service `sinnlos` in `/srv/backup/outbox`,
   which the NAS pulls; it waits for a running nightly backup). The
   sudoers drop-in `/etc/sudoers.d/backup-run-predeploy`, installed by that
   repo's `install.sh`, allows the deploying user exactly this command;
   without it `sudo -n` refuses and the deploy stops here. sudo applies
   the **last** matching rule, so the drop-in must be the last rule that
   matches this command for that user
   ([Checking the backup permission](OPERATIONS.md#checking-the-backup-permission-production)). `DEPLOY_BACKUP_NO_SUDO=1`
   runs `BACKUP_RUN` without `sudo` (the tests use it). Any other compose project (a staging copy) keeps
   `infra/backup/pg-backup.sh` with `SINNLOS_BACKUP_KIND=predeploy` into its
   own `SINNLOS_BACKUP_DIR`: its artifacts are named `…-predeploy…` and kept
   apart from the nightly ones, [OPERATIONS.md, Automated daily backups (cron)](OPERATIONS.md#automated-daily-backups-cron).
   A failed backup stops the deploy before anything is touched. A first
   install, with neither the db container nor its volume, has nothing to
   back up.
2. The rollback target: the images of the **last-known-good** deploy,
   `infra-{web,cms}:<sha>` (the first 12 characters of its commit), from
   the state file `.git/sinnlos-deploy/infra.state` of the checkout.
   Without a usable state (the first run of this version of `deploy.sh`,
   or those images are gone) it tags the running images `:rollback`, as
   before, and a re-run before the first recorded deploy keeps that
   `:rollback` (`.git/sinnlos-deploy/infra.bootstrap`). A running image it
   cannot tag (containerd image store, no tag names it any more) or a
   marker it cannot write stops the run before the build, so `:rollback`
   never pairs an older image of one service with the current one of the
   other. On every run it also tags the running images
   `infra-{web,cms}:pre-deploy` (moved each run, never pruned, never a
   rollback target): on Docker's containerd image store an image that no
   tag names can no longer be resolved by its id, and without that tag a
   re-run after a deploy that failed after `up` could not tag what runs.
3. Builds web and cms with `BUILDX_NO_DEFAULT_ATTESTATIONS=1` (without
   BuildKit's default provenance attestation an unchanged rebuild keeps its
   image id). Before anything is replaced it runs the boot-value check of
   the new cms image (v0.30: `dist/scripts/check-boot-env.js` on the
   rendered compose config, in a container without network); a value the
   cms would refuse to boot with (`APP_TIME_ZONE`, `MFA_REQUIRED_ROLES`)
   stops the deploy with the cms's own message and the running containers
   unchanged. Then it restarts the stack with the Traefik override
   (`up -d --no-build`). If `up` fails while the cms is still running but
   not healthy (a long first boot or migration), deploy.sh prints how to
   inspect it instead of rollback commands.
4. Curl smoke-checks `https://$DOMAIN/healthz`, the host the preflight checked
   (override with `SMOKE_URL=`, which live-smoke gets as `BASE_URL`, see
   [Behind your own Traefik](#behind-your-own-traefik)), then runs `infra/live-smoke.sh`: first the
   [datetime contract](OPERATIONS.md#datetime-contract) check (no
   `timestamp without time zone` column left, the cms process runs in UTC:
   by its `[datetime]` boot line, or, once log rotation has dropped that
   line, by `node` in the running cms container), then the end-to-end SSE
   pipeline probe (one comment
   posted through the cms → the ping frame on a subscribed stream, which
   must be uncompressed, and, when the comment lands on the stream user's
   own announcement, the notification frame; see [OPERATIONS.md, Health checks](OPERATIONS.md#health-checks)).
   The stream user is `SMOKE_EMAIL`, by default the first of
   `alex.morgan@sinnlos.local` (an announcement author in the demo data)
   and `casey.jones@sinnlos.local` with a line in the credentials file; when
   it owns no visible announcement, the notification frame goes unchecked,
   live-smoke and `deploy.sh` print a warning, and the state records
   `LIVE_SMOKE=passed (notification frame not checked)`. A failed live-smoke
   **fails the deploy**; it is skipped with `LIVE_EVENTS_DISABLED=1` (read
   from the env compose hands the apps) or when the demo credentials file
   is not readable, and on an identity-provider-only instance (Entra or
   OIDC without `AUTH_LOCAL_ENABLED=1`) it runs the datetime check only.
5. Only after both passed: tags the images web and cms now run as
   `infra-{web,cms}:<sha>`, records them in the state file as
   last-known-good, and removes the SHA tags beyond the newest five
   (`DEPLOY_KEEP_TAGS`). A skip for `LIVE_EVENTS_DISABLED=1` and the
   datetime check alone on an identity-provider-only instance count as passed. A
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
defaults are the owner's host): `SMOKE_URL` (`https://$DOMAIN`), `PASSWORDS_FILE`,
`SINNLOS_CHECKOUT` (the checkout it lives in), `COMPOSE_PROJECT` (`infra`),
`DEPLOY_STATE_DIR` (state, history, bootstrap marker and lock, and in
`restore/` the state and the reservation of `infra/restore-db.sh`; by
default `sinnlos-deploy` in the clone's `.git`, which its linked worktrees
share: a second clone that deploys or restores the same project must point
`DEPLOY_STATE_DIR` at that same directory, or the two neither share the
lock nor the rollback target, and a deploy from one does not see a restore
in the other), `DEPLOY_KEEP_TAGS` and `BACKUP_RUN`
(unset: `infra/backup/pg-backup.sh`; set, for example to `/usr/local/sbin/backup-run`, it runs through `sudo -n`). A second compose project (a
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
- `DOMAIN` does not fit the instance (since batch 10): the five Traefik
  routers do not all match one host, or that host is not a bare host name,
  is a placeholder, or is not the host of `WEB_PUBLIC_URL` and
  `CMS_PUBLIC_URL` ([Behind your own Traefik](#behind-your-own-traefik)).
  This check names the hosts, which are no secrets.

`apps/cms/src/utils/deploy-preflight.test.ts` pins the preflight's key lists,
placeholder markers and digest rule to the cms guards (`env-guard.ts`,
`send-digests.ts`), and the Entra rules to the cms's `parseEntraConfig`
(`apps/cms/src/entra/config.ts`), the web's `auth-config.ts` and the compose
mapping, so the preflight cannot silently drift from what the apps do at
boot. `infra/deploy-flow.test.ts` runs the whole script against a throwaway
checkout with docker, curl and flock stubbed (tags, state, rollback target,
failures, checks, dry run).
