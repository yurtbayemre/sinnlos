#!/usr/bin/env bash
# Nightly backup of the sinnlos intranet (7-day retention, GPG-encrypted at rest):
#   - Postgres (infra-db-1):        pg_dump -Fc, integrity-checked via pg_restore --list
#   - Strapi uploads (infra_cms_uploads volume): tar of the media dir
# Each artifact is gzipped, then ASYMMETRICALLY encrypted to the VPS backup GPG
# public key — a VPS/NAS compromise cannot decrypt (private key + passphrase are
# off-box). Artifacts land in the box's single NAS-pulled offsite dir, under a
# sinnlos/ namespace, so the existing rrsync pull replicates them automatically
# (see /home/bigemo/backups/momsbest/backup for the keyring + NAS mechanics).
set -euo pipefail

DB_C=infra-db-1
UPLOADS_VOL=infra_cms_uploads

# Keyring + keyid live in $BK (parent); only $OFFSITE is exposed to the NAS pull.
# NOTE: the default deliberately points at the momsbest backup root — that dir
# already holds the shared GPG keyring and is the box's single NAS-pulled
# offsite tree. The production cron runs with exactly this path; do NOT change
# the default without migrating the keyring and the NAS rrsync config.
BK="${SINNLOS_BACKUP_DIR:-/home/bigemo/backups/momsbest}"
OFFSITE="$BK/offsite/sinnlos"
export GNUPGHOME="${SINNLOS_GNUPGHOME:-$BK/.gnupg}"
KEYID="$(cat "${SINNLOS_BACKUP_KEYID:-$BK/.backup-keyid}")"
LOG="$OFFSITE/backup.log"
mkdir -p "$OFFSITE"; chmod 700 "$OFFSITE"
TS=$(date +%Y%m%d-%H%M%S)

# gzip $1, encrypt into $OFFSITE, drop plaintext, keep newest 7, log.
finalize() {  # <file(uncompressed)> <retention-glob> <label>
  local f="$1" glob="$2" label="$3" base
  base=$(basename "$f")
  gzip -f "$f"
  gpg --homedir "$GNUPGHOME" --batch --yes --trust-model always \
      --encrypt --recipient "$KEYID" --output "$OFFSITE/$base.gz.gpg" "$f.gz"
  rm -f "$f.gz"
  ls -1t $glob 2>/dev/null | tail -n +8 | xargs -r rm -f
  echo "$(date -Is) ok $label $base.gz.gpg $(du -h "$OFFSITE/$base.gz.gpg" | cut -f1)" >> "$LOG"
}

# ---- Postgres ----
OUT="$BK/sinnlos-db-$TS.dump"
PU=$(docker exec "$DB_C" printenv POSTGRES_USER)
PD=$(docker exec "$DB_C" printenv POSTGRES_DB)
docker exec "$DB_C" pg_dump -U "$PU" -d "$PD" -Fc --no-owner > "$OUT"
docker exec -i "$DB_C" pg_restore --list < "$OUT" >/dev/null   # integrity check
finalize "$OUT" "$OFFSITE/sinnlos-db-*.dump.gz.gpg" sinnlos-db

# ---- Strapi uploads ----
if docker volume inspect "$UPLOADS_VOL" >/dev/null 2>&1; then
  UOUT="$BK/sinnlos-uploads-$TS.tar"
  docker run --rm -v "$UPLOADS_VOL":/u:ro alpine tar -cf - -C /u . > "$UOUT"
  finalize "$UOUT" "$OFFSITE/sinnlos-uploads-*.tar.gz.gpg" sinnlos-uploads
fi

# Keep the log bounded — it lives in the NAS-replicated offsite dir and would
# otherwise grow forever. The last 500 lines cover months of nightly runs.
# Truncate in place: `cat "$tmp" > "$LOG"` overwrites the existing file's
# contents WITHOUT replacing its inode, so the log keeps its original
# owner/permissions no matter who runs the script (deploy.sh as root, cron as
# bigemo). A `tail > tmp && mv` would instead swap in a new inode owned by the
# caller and break the other caller's append. The scratch file comes from
# mktemp (defaults to $TMPDIR/tmp), i.e. outside the NAS-pulled offsite tree.
if [[ -f "$LOG" ]]; then
  tmp=$(mktemp)
  tail -n 500 "$LOG" > "$tmp" && cat "$tmp" > "$LOG" && rm -f "$tmp"
fi
