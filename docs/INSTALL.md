# Installing sinnlos

The supported path for a new installation:

- one Linux host (amd64, 2 vCPU, 4 GB RAM, 20 GB disk);
- Docker Engine 24 or newer with the compose plugin;
- the bundled Caddy at the edge, which gets its TLS certificate from Let's Encrypt.

For other layouts see [DEPLOYMENT.md](DEPLOYMENT.md), the full reference. Other layouts include a host Traefik (`DEPLOY_EDGE=traefik`), your own reverse proxy, and Azure.

Every command below runs on the host as the **deploy user**, the user that owns the checkout, unless it says otherwise.

## 1. The host

- **Packages:** `git`, `curl`, `openssl`, `gpg`, `bash` and `flock` (from util-linux).
- **Deploy user:** a user in the `docker` group, for example `sudo adduser deploy && sudo usermod -aG docker deploy`.
- **DNS:** an A and/or AAAA record for your domain that points to the host.
- **Firewall:** ports 80 and 443 open.

## 2. The code

```sh
git clone --branch v0.26.0 https://github.com/yurtbayemre/sinnlos.git
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
- **E-mail:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `DIGEST_FROM` as a sender address your mail server accepts.
- **Language and time:** `DEFAULT_LOCALE` (`de` or `en`) and `APP_TIME_ZONE`.
- **Your links:** `PRIVACY_URL`, `IMPRINT_URL` and, optionally, `WHISTLEBLOWING_URL`. If you change the code, also set `SOURCE_URL` to the source of the version you run (AGPL-3.0, §13).

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
5. **Restore drill:** run it once a month on the machine that holds the private key: `infra/backup/restore-drill.sh --all /path/to/copy/of/offsite/sinnlos`. It restores into a throwaway Postgres and checks all three artifacts.

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
   - fill in username, e-mail and a password;
   - set **confirmed** on and **blocked** off;
   - set **role** to **Admin** (`admin_role`).

   Save.

3. Sign in to `https://<DOMAIN>` with that e-mail address. Departments, teams and users are managed at **/manage**.

Do not grant the content-API roles the generic user permissions. Further accounts come from the panel, from self-registration (`LOCAL_REGISTRATION=1`), or from your identity provider (Microsoft Entra ID or OIDC, see [DEPLOYMENT.md](DEPLOYMENT.md)).

## 7. E-mail check

In the admin panel, go to **Settings → Email → Send test email**. The daily or weekly digests and the reminders use the same SMTP settings.

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

1. Read the release notes of the new version, especially the "Upgrade notes" and "Breaking changes" sections.
2. Check out the new version: `git fetch --tags && git checkout v<new version>`.
3. Run `infra/deploy.sh --record-without-live-smoke`. It runs the preflight, the backup, the build, the start and the smoke check.
4. If the deploy fails after the start, `deploy.sh` prints the rollback commands. They switch back to the previous images. Restore the database only when the release notes say a rollback needs it ([DEPLOYMENT.md](DEPLOYMENT.md), "Restoring a database dump").

Optional live-smoke, the end-to-end check of live updates. It signs in as two accounts of yours, so create two local accounts for it (section 6), and publish at least one announcement they can see.

- **`SMOKE_EMAIL`** holds the live stream. Best the author of a published announcement (an editor): the check then covers the notification as well; otherwise it says so in a warning.
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

On the machine with the private key:

1. **Database:**
   1. Decrypt the database artifact: `gpg --decrypt sinnlos-db-<ts>.dump.gz.gpg | gunzip > sinnlos.dump`.
   2. Copy it to the host, into the checkout directory (or give `restore-db.sh` its full path).
   3. Run `infra/restore-db.sh prepare sinnlos.dump`, then `apply`, `rotate-jwt` and `start`. Each step says what it did. The rotation signs everyone out.
2. **Uploads:** untar the uploads artifact into the `infra_cms_uploads` volume with cms and web stopped.
3. **Configuration:** the `.env` artifact holds the `infra/.env` of that day.

[DEPLOYMENT.md](DEPLOYMENT.md), "Backup & Restore", has the details.
